import { auditJob } from "../audit"
import type { Env } from "../env"
import type { RepoFetch } from "../repo"
import { settleChanges } from "../changes"
import {
  type Detail,
  type DraftRow,
  type Status,
  changesOf,
  changesOfAll,
  needsReview,
  send,
  settle,
  stagedKey,
} from "./drafts"
import { type DraftRepo, PrivateVault, draftRepo } from "./github"
import { baseKey, baseText, firstState, openConflict } from "../edit/conflicts"
import { threeWay } from "../edit/merge"
import { contentReport } from "../edit/rules"

// The hourly merge of members' uploads and private page edits (the Worker's "2 * * * *" cron): a draft sent in an earlier hour whose pull request's validate check is green is marked
// ready and merged into its repository's main (vault-private's, or the restricted vault's its
// files are in) by rebase, as the member's own commit. A failed check or a conflict stays open for
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
  repo: DraftRepo,
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
  // The change it was made on top of has merged: its branch, made on main as it was before, would
  // conflict with main exactly where the two meet. Rebuilt on main now (its text merged with
  // anything else main gained), it goes in once its check passes on the new commit.
  if (row.kind === "edit" && row.after_draft && first === "none") {
    await rebuild(env, repo, row, result)
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
      // A page edit is held with a conflict row: its member withdraws it in the editor first.
      message:
        row.kind === "edit"
          ? "main changed the same lines: an admin can settle it, or withdraw it in the editor, take main's change in and send it again"
          : "main changed the same files: send the draft again to rebuild it on main",
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

/** Rebuild a page edit made on top of a change that has merged since, on main as it is now. */
async function rebuild(env: Env, repo: DraftRepo, row: DraftRow, result: MergeResult) {
  const [change] = await changesOf(env, row.id)
  const [main, staged, base] = await Promise.all([
    repo.file(change.path),
    env.ARTIFACTS.get(stagedKey(row.id, change.path)).then((object) => object?.text() ?? null),
    baseText(env, repo, row, change),
  ])
  const now = main && new TextDecoder().decode(main.bytes)
  const merged =
    now === null || staged === null || base === null
      ? null
      : now === base
        ? { clean: true, text: staged }
        : threeWay(base, now, staged)
  if (!main || !merged?.clean) {
    await mark(env, row, "conflict", {
      message:
        "main changed the same lines as yours since the change you edited on top of went in: an admin can settle it, or withdraw it in the editor and send it again",
    })
    await env.DB.batch([
      openConflict(env, {
        repo: row.repo,
        path: change.path,
        draft: row.id,
        login: row.login,
        reason: main ? "main" : "moved",
        now: Date.now(),
      }),
    ])
    await auditJob(env, row.login, "edit.conflict", row.id, { reason: "rebuild" })
    result.conflicts.push(row.id)
    return
  }
  if (merged.text !== staged)
    await env.ARTIFACTS.put(stagedKey(row.id, change.path), merged.text, {
      httpMetadata: { contentType: change.content_type ?? "text/markdown; charset=utf-8" },
    })
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE upload_changes SET base_sha = ?, size = ?, review = ?
       WHERE draft_id = ? AND path = ?`,
    ).bind(
      main.sha,
      new TextEncoder().encode(merged.text).length,
      contentReport(change.path, merged.text).review,
      row.id,
      change.path,
    ),
    env.DB.prepare("UPDATE upload_drafts SET after_draft = NULL WHERE id = ?").bind(row.id),
  ])
  await env.ARTIFACTS.delete(baseKey(row.id, change.path))
  // Its hour stays as it was: sent at the same time, it is due at the same time.
  const rebuilt = { ...row, after_draft: null }
  await send(
    env,
    repo,
    rebuilt,
    await changesOf(env, row.id),
    row.author || row.login,
    row.sent_at ?? Date.now(),
  )
  await auditJob(env, row.login, "edit.rebuild", row.id, { onto: main.sha })
  result.waiting.push(row.id)
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
  if (!new PrivateVault(env, fetcher).ready) return result
  // Due drafts first, oldest first; then those waiting for an admin, to see whether one merged.
  const { results } = await env.DB.prepare(
    `SELECT * FROM upload_drafts
     WHERE repo = 'vault-private' AND pr_number IS NOT NULL
       AND ((status = 'open' AND due_at <= ?) OR status = 'review')
     ORDER BY status = 'review', due_at LIMIT ?`,
  )
    .bind(now + SLACK_MS, perRun)
    .all<DraftRow>()
  // Each in its own repository: vault-private, or the restricted vault its files are in.
  const changes = await changesOfAll(
    env,
    results.map((row) => row.id),
  )
  for (const row of results)
    await Promise.resolve()
      .then(() => draftRepo(env, fetcher, row, changes.get(row.id) ?? []))
      .then((repo) => settleDraft(env, repo, row, result))
      .catch((error) => {
        console.error(`merging upload ${row.id} failed`, error)
        result.waiting.push(row.id)
      })
  return result
}
