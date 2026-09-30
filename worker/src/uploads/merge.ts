import { auditJob } from "../audit"
import type { Env } from "../env"
import type { RepoFetch } from "../repo"
import { settleChanges } from "../changes"
import { type Detail, type DraftRow, type Status, changesOf, needsReview, settle } from "./drafts"
import { PrivateVault } from "./github"
import { firstState, openConflict } from "../edit/conflicts"

// The hourly merge of members' uploads and private page edits (the Worker's "2 * * * *" cron): a draft sent in an earlier hour whose pull request's validate check is green is marked
// ready and merged into vault-private's main by rebase, as the member's own commit. A failed check or a conflict stays open for
// its author to revise or discard; a draft with something in it that runs waits, checked and
// ready, for an admin to merge it on GitHub; a draft changed since it was sent waits for the next
// send. Nothing reaches main without a green check. What GitHub doesn't answer is tried next hour.

/** Due within this long of now counts as due: the cron fires on the hour, give or take. */
const SLACK_MS = 5 * 60_000
/** Drafts looked at per run: each takes up to six GitHub requests and about six D1 and R2 calls,
 *  and the cron's invocation (its own, src/index.ts) may make 50 on the Workers Free plan. The
 *  rest wait an hour. */
export const PER_RUN = 4

export interface MergeResult {
  merged: string[]
  failed: string[]
  conflicts: string[]
  review: string[]
  waiting: string[]
  closed: string[]
}

/** The audit log's word for a draft: uploads.merge, or edit.merge for a page edit (src/edit/). */
const kind = (row: DraftRow) => (row.kind === "edit" ? "edit" : "uploads")

/** Record where a draft stands, unless its author sent a new version meanwhile. */
async function mark(env: Env, row: DraftRow, status: Status, detail: Detail): Promise<void> {
  const update = env.DB.prepare(
    `UPDATE upload_drafts SET status = ?, detail_json = ?, updated_at = ?
     WHERE id = ? AND head_sha IS ?`,
  ).bind(status, JSON.stringify(detail), Date.now(), row.id, row.head_sha)
  // A refusal shows in the site's recent changes (src/changes.ts), in the same request; waiting
  // for the hour or the check changes nothing there.
  if (status === "failed" || status === "conflict" || status === "review")
    await env.DB.batch([update, settleChanges(env, row.id, status)])
  else await update.run()
}

async function settleDraft(
  env: Env,
  repo: PrivateVault,
  row: DraftRow,
  result: MergeResult,
): Promise<void> {
  const number = row.pr_number!
  // Changed since it was sent: its author is revising it, and it goes in once they send it again.
  if (row.status === "open" && row.sent_at !== null && row.edited_at > row.sent_at) {
    await mark(env, row, "open", { message: "changed since it was sent: send it again" })
    result.waiting.push(row.id)
    return
  }
  // Made on top of another member's change (src/edit/conflicts.ts): never before it, and not at
  // all without it, or the first change would go in under the second member's name.
  const first = await firstState(env, row)
  if (first === "waiting") {
    await mark(env, row, "open", { message: "it goes in after the change it was made on top of" })
    result.waiting.push(row.id)
    return
  }
  if (first === "gone") {
    await mark(env, row, "conflict", {
      message: "the change you edited on top of was taken back: send the draft again",
    })
    await env.DB.batch([
      openConflict(env, {
        repo: row.repo,
        path: (await changesOf(env, row.id))[0]?.path ?? "",
        draft: row.id,
        login: row.login,
        reason: "base-gone",
        now: Date.now(),
      }),
    ])
    await auditJob(env, row.login, `${kind(row)}.conflict`, row.id, { reason: "base-gone" })
    result.conflicts.push(row.id)
    return
  }
  let pull = await repo.pull(number)
  if (pull.merged) {
    // An admin merged it on GitHub.
    await settle(env, row.id, "merged", { merge: pull.merge_commit_sha })
    await auditJob(env, row.login, `${kind(row)}.merge`, row.id, {
      pull: number,
      commit: pull.merge_commit_sha,
      on: "github",
    })
    result.merged.push(row.id)
    return
  }
  if (pull.state === "closed") {
    if (row.branch) await repo.deleteBranch(row.branch)
    await settle(env, row.id, "discarded", { detail: { message: "closed on GitHub" } })
    await auditJob(env, row.login, `${kind(row)}.closed`, row.id, { pull: number })
    result.closed.push(row.id)
    return
  }
  if (row.status === "review") {
    result.review.push(row.id)
    return
  }
  // The check of the commit GitHub would merge, and the merge only of that commit.
  const sha = pull.head.sha
  // Only what the site built and checked goes in by itself: a branch changed on GitHub (someone
  // pushed to it) is left to an admin.
  if (sha !== row.head_sha) {
    await mark(env, row, "review", {
      message: "its branch was changed on GitHub, so an admin merges it",
      url: pull.html_url,
    })
    await auditJob(env, row.login, `${kind(row)}.review`, row.id, { pull: number, head: sha })
    result.review.push(row.id)
    return
  }
  const check = await repo.check(sha)
  if (!check || check.state === "pending") {
    await mark(env, row, "open", { message: "waiting for the validate check", url: check?.url })
    result.waiting.push(row.id)
    return
  }
  if (check.state !== "success") {
    await mark(env, row, "failed", {
      message: `the validate check failed${check.description ? `: ${check.description}` : ""}`,
      url: check.url,
    })
    await auditJob(env, row.login, `${kind(row)}.failed`, row.id, {
      pull: number,
      check: check.url,
    })
    result.failed.push(row.id)
    return
  }
  // GitHub works out whether it merges cleanly on the first read after main moves.
  if (pull.mergeable === null) pull = await repo.pull(number)
  if (pull.mergeable === false) {
    await mark(env, row, "conflict", {
      message: "main changed the same files: send the draft again to rebuild it on main",
      url: pull.html_url,
    })
    // A page edit's conflict is listed for its member and admins, like a public page's.
    if (row.kind === "edit")
      await env.DB.batch([
        openConflict(env, {
          repo: row.repo,
          path: (await changesOf(env, row.id))[0]?.path ?? "",
          draft: row.id,
          login: row.login,
          reason: "main",
          now: Date.now(),
        }),
      ])
    await auditJob(env, row.login, `${kind(row)}.conflict`, row.id, { pull: number })
    result.conflicts.push(row.id)
    return
  }
  if (pull.mergeable === null) {
    result.waiting.push(row.id)
    return
  }
  if (pull.draft) await repo.markReady(pull)
  const review = needsReview(await changesOf(env, row.id))
  if (review) {
    await mark(env, row, "review", {
      message: `checked; an admin merges it on GitHub, since something in it runs (${review.join("; ")})`,
      url: pull.html_url,
    })
    await auditJob(env, row.login, `${kind(row)}.review`, row.id, { pull: number })
    result.review.push(row.id)
    return
  }
  const merged = await repo.merge(number, sha)
  if ("refused" in merged) {
    // A revision raced the merge, or GitHub isn't ready: the next hour tries again.
    await mark(env, row, "open", { message: merged.refused, url: pull.html_url })
    result.waiting.push(row.id)
    return
  }
  if (row.branch) await repo.deleteBranch(row.branch)
  await settle(env, row.id, "merged", { merge: merged.merged })
  await auditJob(env, row.login, `${kind(row)}.merge`, row.id, {
    pull: number,
    commit: merged.merged,
  })
  result.merged.push(row.id)
}

export async function mergeDue(
  env: Env,
  fetcher: RepoFetch,
  now = Date.now(),
  perRun = PER_RUN,
): Promise<MergeResult> {
  const result: MergeResult = {
    merged: [],
    failed: [],
    conflicts: [],
    review: [],
    waiting: [],
    closed: [],
  }
  const repo = new PrivateVault(env, fetcher)
  if (!repo.ready) return result
  // Due drafts first, oldest first; then those waiting for an admin, to see whether one merged.
  const { results } = await env.DB.prepare(
    `SELECT * FROM upload_drafts
     WHERE repo = 'vault-private' AND pr_number IS NOT NULL
       AND ((status = 'open' AND due_at <= ?) OR status = 'review')
     ORDER BY status = 'review', due_at LIMIT ?`,
  )
    .bind(now + SLACK_MS, perRun)
    .all<DraftRow>()
  for (const row of results)
    await settleDraft(env, repo, row, result).catch((error) => {
      console.error(`merging upload ${row.id} failed`, error)
      result.waiting.push(row.id)
    })
  return result
}
