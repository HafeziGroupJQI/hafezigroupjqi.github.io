import type { Env } from "../env"
import { HttpError } from "../http"
import { dueAt } from "../profile/routes"
import { RepoConflict, RepoMissing } from "../repo"
import type { PrivateVault } from "./github"

// Members' upload drafts in D1 (upload_drafts, upload_changes) and R2 (uploads/<id>/<path>), and
// what turns one into a pull request on vault-private: the routes (routes.ts), the hourly merge
// (merge.ts) and /admin share these.

export type Status = "editing" | "open" | "failed" | "conflict" | "review" | "merged" | "discarded"
export type Action = "add" | "replace" | "rename" | "delete"

/** Drafts that are neither merged nor discarded: the member (or an admin) can still act on them. */
export const LIVE: Status[] = ["editing", "open", "failed", "conflict", "review"]

/** SQL for "status is live", in a query. */
export const LIVE_SQL = `status IN (${LIVE.map((s) => `'${s}'`).join(", ")})`

export interface DraftRow {
  id: string
  login: string
  note: string
  status: Status
  title: string | null
  branch: string | null
  pr_number: number | null
  head_sha: string | null
  detail_json: string | null
  created_at: number
  edited_at: number
  sent_at: number | null
  due_at: number | null
  merged_at: number | null
  merge_sha: string | null
  updated_at: number
}

export interface ChangeRow {
  draft_id: string
  path: string
  action: Action
  from_path: string | null
  base_sha: string | null
  size: number | null
  content_type: string | null
  /** Why a person must merge it (see rules.ts checkContent), or null. */
  review: string | null
  staged_at: number
}

export interface Detail {
  message: string
  url?: string | null
}

export const stagedKey = (id: string, path: string) => `uploads/${id}/${path}`

export async function draftRow(env: Env, id: string): Promise<DraftRow | null> {
  return env.DB.prepare("SELECT * FROM upload_drafts WHERE id = ?").bind(id).first<DraftRow>()
}

export async function changesOf(env: Env, id: string): Promise<ChangeRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM upload_changes WHERE draft_id = ? ORDER BY staged_at, path",
  )
    .bind(id)
    .all<ChangeRow>()
  return results
}

/** The changes of several drafts at once, by draft. */
export async function changesOfAll(env: Env, ids: string[]): Promise<Map<string, ChangeRow[]>> {
  const out = new Map<string, ChangeRow[]>(ids.map((id) => [id, []]))
  if (!ids.length) return out
  const { results } = await env.DB.prepare(
    `SELECT * FROM upload_changes WHERE draft_id IN (SELECT value FROM json_each(?))
     ORDER BY staged_at, path`,
  )
    .bind(JSON.stringify(ids))
    .all<ChangeRow>()
  for (const change of results) out.get(change.draft_id)?.push(change)
  return out
}

/** Every member's live drafts, with their changes, for /admin: those due soonest first. */
export async function liveDrafts(env: Env, repo: string) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM upload_drafts WHERE ${LIVE_SQL}
     ORDER BY status = 'editing', COALESCE(due_at, updated_at), login`,
  ).all<DraftRow>()
  const changes = await changesOfAll(
    env,
    results.map((row) => row.id),
  )
  return results.map((row) => draftView(repo, row, changes.get(row.id) ?? []))
}

/** A draft as the members site shows it. */
export function draftView(repo: string, row: DraftRow, changes: ChangeRow[]) {
  const live = LIVE.includes(row.status)
  return {
    id: row.id,
    login: row.login,
    note: row.note,
    status: row.status,
    title: row.title,
    created_at: row.created_at,
    edited_at: row.edited_at,
    sent_at: row.sent_at,
    due_at: row.due_at,
    merged_at: row.merged_at,
    // Changed since it was last sent (or never sent): the hourly merge waits until it is sent.
    unsent: live && changes.length > 0 && (row.sent_at === null || row.edited_at > row.sent_at),
    pull: row.pr_number
      ? { number: row.pr_number, url: `https://github.com/${repo}/pull/${row.pr_number}` }
      : null,
    merge: row.merge_sha
      ? { sha: row.merge_sha, url: `https://github.com/${repo}/commit/${row.merge_sha}` }
      : null,
    detail: row.detail_json ? (JSON.parse(row.detail_json) as Detail) : null,
    bytes: changes.reduce((total, change) => total + (change.size ?? 0), 0),
    // Why an admin merges it rather than the hourly run: something in it runs.
    review: needsReview(changes),
    changes: changes.map((change) => ({
      path: change.path,
      action: change.action,
      from: change.from_path,
      size: change.size,
      review: change.review,
      staged_at: change.staged_at,
    })),
  }
}

/** The changes a person must review before they go in, as "path: why", or null for none. */
export function needsReview(changes: Pick<ChangeRow, "path" | "review">[]): string[] | null {
  const reasons = changes.filter((c) => c.review).map((c) => `${c.path}: ${c.review}`)
  return reasons.length ? reasons : null
}

/** Delete a draft's staged files. */
export async function dropStaged(env: Env, id: string): Promise<void> {
  for (let cursor: string | undefined; ;) {
    const listing = await env.ARTIFACTS.list({ prefix: `uploads/${id}/`, cursor })
    if (listing.objects.length) await env.ARTIFACTS.delete(listing.objects.map((o) => o.key))
    if (!listing.truncated) return
    cursor = listing.cursor
  }
}

/** Mark a draft settled (merged or discarded) and drop its staged files. */
export async function settle(
  env: Env,
  id: string,
  status: "merged" | "discarded",
  { detail = null, merge = null }: { detail?: Detail | null; merge?: string | null } = {},
): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `UPDATE upload_drafts SET status = ?, detail_json = ?, merge_sha = COALESCE(?, merge_sha),
       merged_at = CASE WHEN ? = 'merged' THEN ? ELSE merged_at END, updated_at = ?
     WHERE id = ?`,
  )
    .bind(status, detail ? JSON.stringify(detail) : null, merge, status, now, now, id)
    .run()
  await dropStaged(env, id)
}

/**
 * Take a draft back: its pull request is closed and its branch deleted (both stay in GitHub's
 * history), and its staged files are gone. A pull request merged on GitHub meanwhile counts as
 * merged instead (409).
 */
export async function discard(
  env: Env,
  repo: PrivateVault,
  row: DraftRow,
  message: string,
): Promise<void> {
  if (!LIVE.includes(row.status)) throw new HttpError(409, `this draft is already ${row.status}`)
  if (row.pr_number) {
    const pull = await repo.pull(row.pr_number).catch((error) => {
      if (error instanceof RepoMissing) return null
      throw error
    })
    if (pull?.merged) {
      await settle(env, row.id, "merged", { merge: pull.merge_commit_sha })
      throw new HttpError(409, "this draft's pull request was merged on GitHub already")
    }
    if (pull?.state === "open") await repo.updatePull(row.pr_number, { state: "closed" })
  }
  if (row.branch) await repo.deleteBranch(row.branch)
  await settle(env, row.id, "discarded", { detail: { message } })
}

// ---- the commit and the pull request ----

const list = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

/** What a draft changes, in a few words: "add notes/a.pdf", or "add 2 files and delete 1 file in notes". */
export function summary(
  changes: Pick<ChangeRow, "action" | "path" | "from_path">[],
  short = false,
) {
  if (changes.length === 1 && !short) {
    const [change] = changes
    return change.action === "rename"
      ? `rename ${change.from_path} to ${change.path}`
      : `${change.action} ${change.path}`
  }
  const counts = (["add", "replace", "rename", "delete"] as const)
    .map((action) => [action, changes.filter((c) => c.action === action).length] as const)
    .filter(([, n]) => n)
    .map(([action, n]) => `${action} ${n} ${n === 1 ? "file" : "files"}`)
  const folders = [...new Set(changes.map((c) => c.path.split("/")[0]))].sort()
  return `${list(counts)} in ${list(folders)}`
}

/** A draft's commit and pull request title, lowercase like the vault's history, at most 110
 *  characters so the merge's "… from the members site uploads" stays under 150. */
export function uploadTitle(
  changes: Pick<ChangeRow, "action" | "path" | "from_path">[],
  name: string,
) {
  const by = ` by ${name.replace(/\s+/g, " ").trim()}`
  let title = summary(changes) + by
  if (title.length > 110) title = summary(changes, true) + by
  return title.slice(0, 110).trim().toLowerCase()
}

/** A member's name for a title and description: no @mention, code or link in it. */
export const plainName = (name: string, login: string) =>
  name.replace(/[@`<>[\]]/g, "").trim() || login

export const mergeTitle = (title: string) => `${title} from the members site uploads`

const size = (bytes: number | null) =>
  bytes === null
    ? ""
    : bytes < 1024 * 1024
      ? ` (${Math.max(1, Math.round(bytes / 1024))} kb)`
      : ` (${(bytes / 1024 / 1024).toFixed(1)} mb)`

/** The pull request's description: who, every file, the member's note, and when it merges. */
export function pullBody(row: DraftRow, changes: ChangeRow[], name: string, due: number): string {
  const lines = changes.map((change) =>
    change.action === "rename"
      ? `- rename \`${change.from_path}\` to \`${change.path}\``
      : `- ${change.action} \`${change.path}\`${size(change.size)}`,
  )
  const note = row.note.trim()
  const review = changes.filter((change) => change.review)
  return [
    `uploaded from the members site by ${name.toLowerCase()} (${row.login.toLowerCase()}), draft ${row.id}:`,
    "",
    ...lines,
    // In a code block, so an @name in the note doesn't notify anyone.
    ...(note ? ["", "their note:", "", "```text", note.replace(/```/g, "'''"), "```"] : []),
    "",
    review.length
      ? `an admin merges this by hand once the validate check passes, since something in it runs: ${review.map((c) => `\`${c.path}\` (${c.review})`).join(", ")}. until then the member can revise it (a new commit replaces this one) or discard it from the site.`
      : `the site merges this at ${new Date(due).toISOString().slice(0, 16).replace("T", " ")} utc, the end of the hour after it was last sent, once the validate check passes. until then the member can revise it (a new commit replaces this one) or discard it from the site.`,
  ].join("\n")
}

/**
 * Send a draft: one commit on main's tip with all its changes, on its branch (made, or moved to
 * it by force), and its draft pull request opened or updated. Each send is a single commit on
 * main, so the pull request's diff is always the whole draft and a revision never conflicts with
 * what main gained meanwhile. A change whose file changed on main since it was staged is refused.
 */
export async function send(
  env: Env,
  repo: PrivateVault,
  row: DraftRow,
  changes: ChangeRow[],
  displayName: string,
  now = Date.now(),
): Promise<void> {
  const name = plainName(displayName, row.login)
  if (row.pr_number) {
    const pull = await repo.pull(row.pr_number)
    if (pull.merged) {
      await settle(env, row.id, "merged", { merge: pull.merge_commit_sha })
      throw new HttpError(409, "this draft's pull request was merged on GitHub already")
    }
    if (pull.state === "closed") {
      if (row.branch) await repo.deleteBranch(row.branch)
      await settle(env, row.id, "discarded", { detail: { message: "closed on GitHub" } })
      throw new HttpError(409, "this draft's pull request was closed on GitHub")
    }
  }
  const tip = await repo.head()
  const files = await repo.tree(tip.tree)
  const lower = new Set([...files.keys()].map((path) => path.toLowerCase()))
  const problems: string[] = []
  for (const change of changes) {
    const source = change.from_path ?? change.path
    const current = files.get(source)
    if (change.action !== "add") {
      if (current?.type !== "blob") problems.push(`${source} is no longer on main`)
      else if (current.sha !== change.base_sha) problems.push(`${source} changed on main`)
    }
    // A new name, even one that differs only in case (the vault is checked out on Windows and
    // macOS too), mustn't be taken; a rename may change just the case of its own name.
    const target = change.path.toLowerCase()
    const arrives = change.action === "add" || change.action === "rename"
    if (arrives && lower.has(target) && target !== change.from_path?.toLowerCase())
      problems.push(`${change.path} is on main now`)
  }
  if (problems.length)
    throw new HttpError(
      409,
      `the vault changed since you staged this: ${problems.join("; ")}. Take those changes out, look at the new version and stage them again.`,
    )

  const entries: { path: string; sha: string | null }[] = []
  for (const change of changes) {
    if (change.action === "delete") entries.push({ path: change.path, sha: null })
    else if (change.action === "rename")
      entries.push(
        { path: change.from_path!, sha: null },
        { path: change.path, sha: files.get(change.from_path!)!.sha },
      )
    else {
      const object = await env.ARTIFACTS.get(stagedKey(row.id, change.path))
      if (!object)
        throw new HttpError(409, `the staged copy of ${change.path} is gone; add it again`)
      entries.push({ path: change.path, sha: await repo.streamBlob(object.body, object.size) })
    }
  }
  const title = uploadTitle(changes, name)
  const commit = await repo.createCommit(
    title,
    await repo.createTree(tip.tree, entries),
    [tip.commit],
    {
      name: row.login,
      email: `${row.login}@users.noreply.github.com`,
    },
  )
  const branch = row.branch ?? `uploads/${row.login.toLowerCase()}/${row.id}`
  if (!row.branch) await repo.createBranch(branch, commit)
  else
    await repo.moveBranch(branch, commit, true).catch(async (error) => {
      // Deleted on GitHub meanwhile: make it again.
      if (!(error instanceof RepoMissing) && !(error instanceof RepoConflict)) throw error
      await repo.createBranch(branch, commit)
    })
  const due = dueAt(now)
  const body = pullBody(row, changes, name, due)
  const number = row.pr_number
    ? (await repo.updatePull(row.pr_number, { title, body })).number
    : (await repo.openPull({ title, body, head: branch })).number
  await env.DB.prepare(
    `UPDATE upload_drafts SET status = 'open', title = ?, branch = ?, pr_number = ?, head_sha = ?,
       detail_json = NULL, sent_at = ?, due_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(title, branch, number, commit, now, due, now, row.id)
    .run()
}
