import jsyaml from "js-yaml"
import { auditJob } from "../audit"
import type { Env } from "../env"
import { HttpError } from "../http"
import { dueAt } from "../profile/routes"
import { RepoConflict, type RepoFetch, type TreeEntry } from "../repo"
import { type ChangeRow, type DraftRow, settle, stagedKey } from "../uploads/drafts"
import { DraftRepo } from "../uploads/github"
import { type VaultView, pageProblems, vaultProblems } from "./public"
import { editMessage, editTitle } from "./rules"

// Edits of public pages (the public vault, HafeziGroupJQI/vault): no pull request, as the site's
// other public-vault writes (People page settings, src/profile/publish.ts) make none. Publishing
// an edit checks it against main as the vault's own check would (public.ts) and queues it for the
// hour after this one, so its member can still change or discard it; until then it is theirs
// alone, in the site's D1 and R2. The hourly run (commitDue, the Worker's "4 * * * *" cron) then
// commits each due edit straight to main as its member's own commit, checked again against main
// as it is then, and refused as a conflict if the page changed there since the member loaded it:
// nothing anyone else wrote is overwritten.

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
 * Publish a member's edit of a public page: checked against main, it goes in at the end of the
 * hour after this one. Returns main's version of the page instead when it changed there since the
 * member loaded it (their base), so the editor can show what changed.
 */
export async function publishEdit(
  env: Env,
  repo: DraftRepo,
  row: DraftRow,
  change: ChangeRow,
  text: string,
  { admin, author }: { admin: boolean; author: string },
  now = Date.now(),
): Promise<{ incoming: { sha: string; text: string } | null } | null> {
  const main = await repo.file(change.path)
  if (!main || main.sha !== change.base_sha)
    return { incoming: main && { sha: main.sha, text: decoder.decode(main.bytes) } }
  const base = decoder.decode(main.bytes)
  if (base === text) throw new HttpError(422, "nothing changed: the page is the same as on main")
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
  await env.DB.prepare(
    `UPDATE upload_drafts SET status = 'open', title = ?, author = ?, detail_json = NULL,
       sent_at = ?, due_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(editTitle(change.path, author, row.summary ?? ""), author, now, dueAt(now), now, row.id)
    .run()
  return null
}

export interface CommitResult {
  merged: string[]
  failed: string[]
  conflicts: string[]
  waiting: string[]
}

type Due = DraftRow & Pick<ChangeRow, "path" | "base_sha">

/** Record why a due edit didn't go in, unless its member published it again meanwhile. */
async function mark(env: Env, row: Due, status: "open" | "failed" | "conflict", message: string) {
  await env.DB.prepare(
    `UPDATE upload_drafts SET status = ?, detail_json = ?, updated_at = ?
     WHERE id = ? AND sent_at IS ?`,
  )
    .bind(status, JSON.stringify({ message }), Date.now(), row.id, row.sent_at)
    .run()
}

/**
 * The hourly run: every public page edit that is due goes into the vault's main, each as its
 * member's own commit (chained on one another), and main moves once. An edit changed since it was
 * published waits for its member to publish it again; one whose page changed on main since its
 * base is a conflict; one the vault's check would now refuse (a page it links to is gone, say)
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
  const tip = await repo.head()
  const files = await repo.tree(tip.tree)
  const vault = vaultView(repo, files)
  let parent = tip.commit
  let tree = tip.tree
  const made: { row: Due; commit: string }[] = []
  for (const row of results) {
    try {
      if (row.sent_at === null || row.edited_at > row.sent_at) {
        await mark(env, row, "open", "changed since you published it: publish it again")
        result.waiting.push(row.id)
        continue
      }
      if (files.get(row.path)?.sha !== row.base_sha) {
        await mark(
          env,
          row,
          "conflict",
          "the page changed on main since you started: open it in the editor to take the change in",
        )
        await auditJob(env, row.login, "edit.conflict", row.id, { path: row.path })
        result.conflicts.push(row.id)
        continue
      }
      const object = await env.ARTIFACTS.get(stagedKey(row.id, row.path))
      if (!object) {
        await mark(env, row, "failed", "its text is gone: discard it and edit the page again")
        result.failed.push(row.id)
        continue
      }
      const text = await object.text()
      // Main is the edit's base here (checked above): what the edit adds must still lead
      // somewhere, and what it names must still be there.
      const base = await repo.read(row.path)
      const problems = await vaultProblems(row.path, text, base, vault)
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
      made.push({ row, commit: parent })
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
  for (const { row, commit } of made) {
    await settle(env, row.id, "merged", { merge: commit })
    await auditJob(env, row.login, "edit.merge", row.id, { path: row.path, commit })
    result.merged.push(row.id)
  }
  return result
}
