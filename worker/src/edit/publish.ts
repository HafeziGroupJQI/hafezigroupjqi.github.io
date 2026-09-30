import jsyaml from "js-yaml"
import { auditJob } from "../audit"
import type { Env } from "../env"
import { HttpError } from "../http"
import { dueAt } from "../profile/routes"
import { RepoConflict, type RepoFetch, type TreeEntry } from "../repo"
import { draftChanges, recordChanges, settleChanges, unsentChanges } from "../changes"
import { type ChangeRow, type DraftRow, publishedKey, settle } from "../uploads/drafts"
import { DraftRepo } from "../uploads/github"
import { baseText, firstState, mergeable, newId as newConflict, openConflict } from "./conflicts"
import { threeWay } from "./merge"
import { type VaultView, pageProblems, vaultProblems } from "./public"
import { editMessage, editTitle } from "./rules"

// Edits of public pages (the public vault, HafeziGroupJQI/vault): no pull request, as the site's
// other public-vault writes (People page settings, src/profile/publish.ts) make none. Publishing
// an edit checks it against main as the vault's own check would (public.ts) and queues it for the
// hour after this one, so its member can still change or discard it; until then it is theirs
// alone, in the site's D1 and R2. The hourly run (commitDue, the Worker's "4 * * * *" cron) then
// commits each due edit straight to main as its member's own commit, checked again against main
// as it is then. If the page changed there since the member loaded it, or another member's edit
// of the same page went in earlier in the same run, the two are merged line by line (merge.ts):
// changes to different lines both go in, and changes to the same lines make the later edit a
// conflict (conflicts.ts), held with its text kept. Nothing anyone else wrote is overwritten.

/** Due within this long of now counts as due: the cron fires on the hour, give or take. */
const SLACK_MS = 5 * 60_000
/**
 * Edits the hourly run commits per invocation: each takes about eight subrequests (its text from
 * R2, main's version, a tree and a commit on GitHub, its D1 row, its staged text dropped, an audit
 * row), besides about ten for the run (main's tip and tree, schemas and places, the branch moved),
 * and a Workers Free invocation may make 50. The rest go in an hour later.
 */
export const EDITS_PER_RUN = 4

const decoder = new TextDecoder()

/** The vault at main as the checks see it: its files, and its JSON and YAML read once each. */
export function vaultView(repo: DraftRepo, files: Map<string, TreeEntry>): VaultView {
  const read = new Map<string, Promise<unknown>>()
  return {
    files,
    data(path) {
      if (!read.has(path))
        read.set(
          path,
          repo.read(path).then((text) => {
            if (text === null) return null
            return path.endsWith(".json") ? JSON.parse(text) : jsyaml.load(text)
          }),
        )
      return read.get(path)!
    },
  }
}

/** A refusal (422) that names every problem the vault's check would find. */
function refuse(problems: string[]): never {
  throw new HttpError(422, `the vault's check would refuse this: ${problems.join("; ")}`)
}

/**
 * Publish a member's edit of a public page: checked against the vault at main, it goes in at the
 * end of the hour after this one. `base` is the text the edit was made from, main's version of
 * the page, which the route checked it against first (conflicts.ts).
 */
export async function publishEdit(
  env: Env,
  repo: DraftRepo,
  row: DraftRow,
  change: ChangeRow,
  text: string,
  { admin, author, base }: { admin: boolean; author: string; base: string },
  now = Date.now(),
): Promise<void> {
  const local = pageProblems(text, base, admin)
  if (local.length) refuse(local)
  const tip = await repo.head()
  const problems = await vaultProblems(
    change.path,
    text,
    base,
    vaultView(repo, await repo.tree(tip.tree)),
  )
  if (problems.length) refuse(problems)
  // What goes in is this text, whatever its member saves after (they publish that again).
  await env.ARTIFACTS.put(publishedKey(row.id, change.path), text, {
    httpMetadata: { contentType: change.content_type ?? "text/markdown; charset=utf-8" },
  })
  const title = editTitle(change.path, author, row.summary ?? "")
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE upload_drafts SET status = 'open', title = ?, author = ?, detail_json = NULL,
         sent_at = ?, due_at = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(title, author, now, dueAt(now), now, row.id),
    // The site's recent changes (src/changes.ts): the page as published now, in place of before.
    unsentChanges(env, row.id),
    recordChanges(
      env,
      draftChanges(row, [change], { at: now, author, summary: title, pull: null }),
    ),
  ])
}

export interface CommitResult {
  merged: string[]
  failed: string[]
  conflicts: string[]
  waiting: string[]
}

type Due = DraftRow & Pick<ChangeRow, "path" | "base_sha">

/** Record why a due edit didn't go in, unless its member published it again meanwhile. */
async function mark(
  env: Env,
  row: Due,
  status: "open" | "failed" | "conflict",
  message: string,
  also: D1PreparedStatement[] = [],
) {
  const update = env.DB.prepare(
    `UPDATE upload_drafts SET status = ?, detail_json = ?, updated_at = ?
     WHERE id = ? AND sent_at IS ?`,
  ).bind(status, JSON.stringify({ message }), Date.now(), row.id, row.sent_at)
  // A refusal shows in the site's recent changes (src/changes.ts), in the same request.
  if (status === "open") await update.run()
  else await env.DB.batch([update, settleChanges(env, row.id, status), ...also])
}

/**
 * The hourly run: every public page edit that is due goes into the vault's main, each as its
 * member's own commit (chained on one another), and main moves once. An edit changed since it was
 * published waits for its member to publish it again; one whose page changed since its base (on
 * main, or by an edit committed earlier in this run) is merged with that change when the two
 * touch different lines, and is a conflict when they touch the same; one the vault's check would
 * now refuse (a page it links to is gone, say)
 * fails; its member sees why in the editor. If main moves while the run commits, the run tries
 * again next hour.
 */
export async function commitDue(
  env: Env,
  fetcher: RepoFetch,
  now = Date.now(),
  perRun = EDITS_PER_RUN,
): Promise<CommitResult> {
  const result: CommitResult = { merged: [], failed: [], conflicts: [], waiting: [] }
  const repo = new DraftRepo(env, fetcher, "vault")
  if (!repo.ready) return result
  const { results } = await env.DB.prepare(
    `SELECT d.*, c.path, c.base_sha FROM upload_drafts d
     JOIN upload_changes c ON c.draft_id = d.id
     WHERE d.repo = 'vault' AND d.kind = 'edit' AND d.status = 'open' AND d.due_at <= ?
     ORDER BY d.due_at, d.sent_at LIMIT ?`,
  )
    .bind(now + SLACK_MS, perRun)
    .all<Due>()
  if (!results.length) return result
  // A draft made on top of another due in this run comes after it, whichever hour is earlier.
  const due: Due[] = []
  const place = (row: Due, seen = new Set<string>()) => {
    if (due.includes(row) || seen.has(row.id)) return
    seen.add(row.id)
    const first = results.find((other) => other.id === row.after_draft)
    if (first) place(first, seen)
    due.push(row)
  }
  for (const row of results) place(row)
  const tip = await repo.head()
  const files = await repo.tree(tip.tree)
  const vault = vaultView(repo, files)
  let parent = tip.commit
  let tree = tip.tree
  const made: { row: Due; commit: string; onto: string | null }[] = []
  // Each page's text as this run has it so far, and whose edit wrote it: main's tree above was
  // read once, so a second due edit of the same page is checked against the first one's text.
  const written = new Map<string, { text: string; row: Due }>()
  for (const row of due) {
    try {
      if (row.sent_at === null || row.edited_at > row.sent_at) {
        await mark(env, row, "open", "changed since you published it: publish it again")
        result.waiting.push(row.id)
        continue
      }
      // Made on top of another member's change: never before it, and not at all without it.
      const first = await firstState(env, row)
      const firstHere = made.some((item) => item.row.id === row.after_draft)
      if (first === "waiting" && !firstHere) {
        await mark(env, row, "open", "it goes in after the change it was made on top of")
        result.waiting.push(row.id)
        continue
      }
      if (first === "gone") {
        await mark(
          env,
          row,
          "conflict",
          "the change you edited on top of was taken back: take its lines out, or keep them, and publish again",
          [
            openConflict(env, {
              repo: "vault",
              path: row.path,
              draft: row.id,
              login: row.login,
              reason: "base-gone",
              now,
            }),
          ],
        )
        await auditJob(env, row.login, "edit.conflict", row.id, {
          path: row.path,
          reason: "base-gone",
        })
        result.conflicts.push(row.id)
        continue
      }
      const object = await env.ARTIFACTS.get(publishedKey(row.id, row.path))
      if (!object) {
        await mark(env, row, "failed", "its text is gone: discard it and edit the page again")
        result.failed.push(row.id)
        continue
      }
      let text = await object.text()
      const before = written.get(row.path)
      const onMain = files.get(row.path)
      // The page as it is now: what the edit adds must still lead somewhere, and what it names
      // must still be there.
      const current = before ? before.text : onMain ? await repo.read(row.path) : null
      let merged = false
      if (before || onMain?.sha !== row.base_sha) {
        // The page changed since this edit's base: both go in if they touch different lines.
        const base = current === null ? null : await baseText(env, repo, row, row)
        const merge = base !== null && mergeable(row.path) ? threeWay(base, current!, text) : null
        if (!merge?.clean || (await vaultProblems(row.path, merge.text, current, vault)).length) {
          const conflict = newConflict()
          await mark(
            env,
            row,
            "conflict",
            before
              ? `${before.row.author || before.row.login} changed the same lines of this page, and their change went in first`
              : current === null
                ? "the page was moved or deleted on main since you started"
                : "the page changed on main since you started, on the same lines as your change",
            [
              openConflict(env, {
                id: conflict,
                repo: "vault",
                path: row.path,
                draft: row.id,
                login: row.login,
                first: before && {
                  id: before.row.id,
                  login: before.row.login,
                  author: before.row.author,
                },
                blob: before ? null : (onMain?.sha ?? null),
                reason: current === null ? "moved" : "main",
                now,
              }),
            ],
          )
          await auditJob(env, row.login, "edit.conflict", row.id, {
            path: row.path,
            conflict,
            first: before?.row.login ?? null,
          })
          result.conflicts.push(row.id)
          continue
        }
        text = merge.text
        merged = true
      }
      const problems = await vaultProblems(row.path, text, current, vault)
      if (problems.length) {
        await mark(
          env,
          row,
          "failed",
          `the vault's check would refuse it now: ${problems.join("; ")}`,
        )
        await auditJob(env, row.login, "edit.failed", row.id, { path: row.path, problems })
        result.failed.push(row.id)
        continue
      }
      tree = await repo.createTree(tree, [{ path: row.path, content: text }])
      const message = editMessage(row.title ?? editTitle(row.path, row.login, row.summary ?? ""))
      parent = await repo.createCommit(message, tree, [parent], {
        name: row.author || row.login,
        email: `${row.login}@users.noreply.github.com`,
      })
      made.push({ row, commit: parent, onto: merged ? (before?.row.id ?? onMain!.sha) : null })
      written.set(row.path, { text, row })
    } catch (error) {
      console.error(`committing edit ${row.id} failed`, error)
      result.waiting.push(row.id)
    }
  }
  if (!made.length) return result
  try {
    await repo.moveBranch("main", parent)
  } catch (error) {
    if (!(error instanceof RepoConflict)) throw error
    // Someone pushed meanwhile: every edit is checked again on the new main next hour.
    for (const { row } of made) {
      await mark(
        env,
        row,
        "open",
        "main moved while it went in: it goes in with the next hourly run",
      )
      result.waiting.push(row.id)
    }
    return result
  }
  for (const { row, commit, onto } of made) {
    await settle(env, row.id, "merged", { merge: commit })
    // Merged with a change that went in since its base: the audit log says onto what.
    await auditJob(env, row.login, "edit.merge", row.id, {
      path: row.path,
      commit,
      ...(onto ? { auto_merged: true, onto } : {}),
    })
    result.merged.push(row.id)
  }
  return result
}
