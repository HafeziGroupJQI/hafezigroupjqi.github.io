import { type Auditor, isAdmin } from "../audit"
import { requireMutation } from "../auth"
import type { Env } from "../env"
import { fileHeaders } from "../gpt/context"
import { HttpError, json, readJson, readLimited } from "../http"
import { navIdentity } from "../profile/routes"
import type { RepoFetch } from "../repo"
import type { Session } from "../session"
import {
  type ChangeRow,
  type DraftRow,
  LIVE,
  LIVE_SQL,
  changesOf,
  changesOfAll,
  discard,
  draftRow,
  draftView,
  send,
  stagedKey,
} from "./drafts"
import { PrivateVault, repoFullName } from "./github"
import {
  CHANGES_MAX,
  DRAFT_MAX,
  FILE_MAX,
  FOLDERS,
  TYPES,
  checkContent,
  extension,
  shownFolder,
  typeOf,
  vaultFolder,
  vaultPath,
} from "./rules"

// Members' uploads to vault-private (/uploads): files added, replaced, renamed or deleted from
// the site. A draft is one change set, staged in R2 and D1 (drafts.ts) until the member sends it;
// sending makes it a branch (uploads/<login>/<draft>) holding one commit on main's tip, and a
// draft pull request whose diff is the review. Sending again (a revision) replaces that commit.
// The hourly cron (merge.ts) merges it at the end of the hour after it was last sent, once
// vault-private's validate check is green, so every change can be revised for at least an hour;
// a draft with something in it that runs (rules.ts checkContent) waits for an admin instead.
// Signed-in members only, never a lab ticket; every action is audited, with daily limits.

/** Drafts one member may have that are neither merged nor discarded. */
export const DRAFTS_MAX = 5
/** Changes to drafts (new drafts, files, renames, deletions, notes) per member in 24 hours. */
export const EDITS_PER_DAY = 300
/** Sends (new pull requests and revisions) per member in 24 hours. */
export const SENDS_PER_DAY = 40
const EDITS = [
  "uploads.create",
  "uploads.stage",
  "uploads.rename",
  "uploads.delete",
  "uploads.unstage",
  "uploads.note",
]
const NOTE_MAX = 1000
const DAY_MS = 86_400_000

const DRAFT = /^\/api\/uploads\/drafts\/([0-9a-f]{12})(?:\/(file|changes|send))?$/

const mb = (bytes: number) => `${bytes / 1024 / 1024} MB`

export async function underLimit(
  env: Env,
  login: string,
  actions: string[],
  max: number,
  what: string,
) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE login = ? AND at > ?
       AND action IN (SELECT value FROM json_each(?))`,
  )
    .bind(login, Date.now() - DAY_MS, JSON.stringify(actions))
    .first<{ n: number }>()
  if ((row?.n ?? 0) >= max)
    throw new HttpError(429, `at most ${max} ${what} a day; try again tomorrow`)
}

/**
 * A draft the member may see (their own; admins see every one), or may change (their own, live).
 * A page edit (src/edit/) changes from the editor; here it can only be looked at or discarded.
 */
export async function ownDraft(
  env: Env,
  id: string,
  session: Session,
  { change = false, kind = null }: { change?: boolean; kind?: DraftRow["kind"] | null } = {},
): Promise<DraftRow> {
  const row = await draftRow(env, id)
  const own = row?.login.toLowerCase() === session.login.toLowerCase()
  if (!row || (!own && (change || !(await isAdmin(env, session)))))
    throw new HttpError(404, "no such draft")
  if (kind && row.kind !== kind)
    throw new HttpError(
      409,
      row.kind === "edit"
        ? "this draft is a page edit: open it in the editor"
        : "this draft is an upload: open it on Uploads",
    )
  if (change && !LIVE.includes(row.status))
    throw new HttpError(409, `this draft is ${row.status}; start a new one`)
  return row
}

async function touch(env: Env, id: string): Promise<void> {
  const now = Date.now()
  await env.DB.prepare("UPDATE upload_drafts SET edited_at = ?, updated_at = ? WHERE id = ?")
    .bind(now, now, id)
    .run()
}

async function insertChange(env: Env, change: ChangeRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO upload_changes
       (draft_id, path, action, from_path, base_sha, size, content_type, review, staged_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (draft_id, path) DO UPDATE SET size = ?6, content_type = ?7, review = ?8,
       staged_at = ?9`,
  )
    .bind(
      change.draft_id,
      change.path,
      change.action,
      change.from_path,
      change.base_sha,
      change.size,
      change.content_type,
      change.review,
      change.staged_at,
    )
    .run()
}

/** Whether a path is already part of a draft, as a change's file or a renamed file's old name. */
const inDraft = (changes: ChangeRow[], path: string) =>
  changes.some((change) => change.path === path || change.from_path === path)

function cleanNote(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") throw new HttpError(422, "the note must be text")
  const note = value.trim()
  if (/[\p{Cc}\u2028\u2029]/u.test(note.replace(/\r?\n/g, "")))
    throw new HttpError(422, "the note can't contain control characters")
  if (note.length > NOTE_MAX)
    throw new HttpError(422, `the note is longer than ${NOTE_MAX} characters`)
  return note
}

export async function uploadRoutes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  record: Auditor,
  fetcher: RepoFetch,
): Promise<Response | null> {
  const path = url.pathname
  if (path !== "/api/uploads" && !path.startsWith("/api/uploads/")) return null
  // Code in a member's lab can read its ticket; what reaches the vault comes from the site.
  if (session.lab) throw new HttpError(403, "uploads are made from the members site")
  const repo = new PrivateVault(env, fetcher)
  // A draft's links go to its own repository: a public page's edit is the public vault's.
  const view = async (id: string) => {
    const row = (await draftRow(env, id))!
    return draftView(repoFullName(env, row.repo), row, await changesOf(env, id))
  }

  if (path === "/api/uploads" && request.method === "GET") {
    // Every live draft, and the settled ones of the last 30 days.
    const { results } = await env.DB.prepare(
      `SELECT * FROM upload_drafts WHERE login = ? COLLATE NOCASE
         AND (${LIVE_SQL} OR updated_at > ?)
       ORDER BY created_at DESC LIMIT 50`,
    )
      .bind(session.login, Date.now() - 30 * DAY_MS)
      .all<DraftRow>()
    const changes = await changesOfAll(
      env,
      results.map((row) => row.id),
    )
    return json({
      ready: repo.ready,
      repo: repo.repo,
      folders: FOLDERS,
      types: Object.keys(TYPES),
      limits: { file: FILE_MAX, draft: DRAFT_MAX, changes: CHANGES_MAX, drafts: DRAFTS_MAX },
      drafts: results.map((row) =>
        draftView(repoFullName(env, row.repo), row, changes.get(row.id) ?? []),
      ),
    })
  }

  // A folder of the vault at main, for choosing where files go and which to replace or move.
  if (path === "/api/uploads/folder" && request.method === "GET") {
    const folder = vaultFolder(url.searchParams.get("path"))
    const listing = await repo.list(folder)
    const entries = (listing ?? [])
      .filter((entry) =>
        entry.type === "dir"
          ? folder
            ? shownFolder(entry.name)
            : FOLDERS.includes(entry.name)
          : entry.type === "file" && folder !== "" && !entry.name.startsWith("."),
      )
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: entry.type === "dir" ? "folder" : "file",
        size: entry.type === "file" ? entry.size : null,
        // Files of a type the site takes can be replaced, moved or deleted from it.
        changeable: entry.type === "file" && Object.hasOwn(TYPES, extension(entry.name)),
      }))
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1,
      )
    return json({ path: folder, exists: listing !== null, entries })
  }

  if (path === "/api/uploads/drafts" && request.method === "POST") {
    requireMutation(request, env)
    if (!repo.ready) throw new HttpError(503, "uploads are not set up yet: ask an admin")
    const body = (await readJson(request)) as { note?: unknown }
    const note = cleanNote(body.note)
    const open = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM upload_drafts
       WHERE login = ? COLLATE NOCASE AND kind = 'upload' AND ${LIVE_SQL}`,
    )
      .bind(session.login)
      .first<{ n: number }>()
    if ((open?.n ?? 0) >= DRAFTS_MAX)
      throw new HttpError(409, `you have ${DRAFTS_MAX} drafts open; send or discard one first`)
    await underLimit(env, session.login, EDITS, EDITS_PER_DAY, "changes to uploads")
    const id = [...crypto.getRandomValues(new Uint8Array(6))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO upload_drafts (id, login, note, created_at, edited_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, session.login, note, now, now, now)
      .run()
    record("uploads.create", id)
    return json(await view(id), 201)
  }

  const match = path.match(DRAFT)
  if (!match) throw new HttpError(404, "not found")
  const [, id, part] = match

  if (!part && request.method === "GET") {
    const row = await ownDraft(env, id, session)
    // While a pull request waits for its hour, what its check says so far.
    const check =
      row.status === "open" && row.head_sha
        ? await repo.check(row.head_sha).catch((error) => {
            console.error("reading an upload's check failed", error)
            return null
          })
        : null
    return json({ ...(await view(id)), check })
  }

  if (!part && request.method === "PATCH") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true, kind: "upload" })
    const body = (await readJson(request)) as { note?: unknown }
    await underLimit(env, session.login, EDITS, EDITS_PER_DAY, "changes to uploads")
    await env.DB.prepare("UPDATE upload_drafts SET note = ? WHERE id = ?")
      .bind(cleanNote(body.note), row.id)
      .run()
    await touch(env, row.id)
    record("uploads.note", row.id)
    return json(await view(row.id))
  }

  if (!part && request.method === "DELETE") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true })
    await discard(env, repo, row, "discarded by its author")
    record(`${row.kind === "edit" ? "edit" : "uploads"}.discard`, row.id, { pull: row.pr_number })
    return json(await view(row.id))
  }

  // A staged file, as it will be committed: typed by its kind and sandboxed (never run as the site).
  if (part === "file" && request.method === "GET") {
    const row = await ownDraft(env, id, session)
    const target = url.searchParams.get("path") ?? ""
    const change = (await changesOf(env, row.id)).find((c) => c.path === target)
    const object =
      change && (change.action === "add" || change.action === "replace")
        ? await env.ARTIFACTS.get(stagedKey(row.id, target))
        : null
    if (!change || !object) throw new HttpError(404, "no such staged file")
    return new Response(object.body, {
      headers: {
        ...fileHeaders({
          mime: change.content_type ?? "application/octet-stream",
          name: target.split("/").pop()!,
        }),
        "content-length": String(object.size),
      },
    })
  }

  // Stage a file: a new one (mode=add, the default) or a new version of one (mode=replace).
  if (part === "file" && request.method === "PUT") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true, kind: "upload" })
    const target = vaultPath(url.searchParams.get("path"))
    const replace = url.searchParams.get("mode") === "replace"
    const type = typeOf(target)
    await underLimit(env, session.login, EDITS, EDITS_PER_DAY, "changes to uploads")
    const bytes = await readLimited(request, FILE_MAX, `a file can be at most ${mb(FILE_MAX)}`)
    const review = checkContent(target, bytes)
    const changes = await changesOf(env, row.id)
    const existing = changes.find(
      (c) => c.path === target && (c.action === "add" || c.action === "replace"),
    )
    const others = changes.filter((c) => c !== existing)
    if (inDraft(others, target))
      throw new HttpError(
        409,
        `${target} is renamed or deleted in this draft; take that change out first`,
      )
    if (!existing && changes.length >= CHANGES_MAX)
      throw new HttpError(
        422,
        `a draft holds at most ${CHANGES_MAX} changes; send this one and start another`,
      )
    if (others.reduce((total, c) => total + (c.size ?? 0), 0) + bytes.length > DRAFT_MAX)
      throw new HttpError(413, `a draft can hold at most ${mb(DRAFT_MAX)}`)
    let action = existing?.action
    let base = existing?.base_sha ?? null
    if (!action) {
      const { found, clash } = await repo.entry(target)
      if (found && found.type !== "file") throw new HttpError(409, `${target} is a folder`)
      if (clash)
        throw new HttpError(
          409,
          `${clash} is already there: names that differ only in case break the vault on Windows and macOS`,
        )
      if (found && !replace)
        throw new HttpError(409, `${target} is already in the vault; replace it instead`)
      if (!found && replace) throw new HttpError(404, `${target} isn't in the vault`)
      action = found ? "replace" : "add"
      base = found?.sha ?? null
    }
    await env.ARTIFACTS.put(stagedKey(row.id, target), bytes, {
      httpMetadata: { contentType: type.mime },
    })
    await insertChange(env, {
      draft_id: row.id,
      path: target,
      action,
      from_path: null,
      base_sha: base,
      size: bytes.length,
      content_type: type.mime,
      review,
      staged_at: Date.now(),
    })
    await touch(env, row.id)
    record("uploads.stage", target, { draft: row.id, action, bytes: bytes.length, review })
    return json(await view(row.id))
  }

  // A rename (or move) or a deletion of a file on main.
  if (part === "changes" && request.method === "POST") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true, kind: "upload" })
    const body = (await readJson(request)) as {
      action?: unknown
      path?: unknown
      from?: unknown
      to?: unknown
    }
    const changes = await changesOf(env, row.id)
    const existing = async (path: string) => {
      const { found } = await repo.entry(path)
      if (found?.type !== "file") throw new HttpError(404, `${path} isn't in the vault`)
      return found
    }
    const taken = (path: string) => {
      if (inDraft(changes, path))
        throw new HttpError(
          409,
          `${path} is already part of this draft; take that change out first`,
        )
    }
    if (changes.length >= CHANGES_MAX)
      throw new HttpError(
        422,
        `a draft holds at most ${CHANGES_MAX} changes; send this one and start another`,
      )
    await underLimit(env, session.login, EDITS, EDITS_PER_DAY, "changes to uploads")
    const now = Date.now()
    if (body.action === "rename") {
      const from = vaultPath(body.from)
      const to = vaultPath(body.to)
      if (from === to) throw new HttpError(422, "choose a new name or folder")
      if (extension(from) !== extension(to))
        throw new HttpError(
          422,
          `a moved file keeps its type: ${to} must end in .${extension(from)}`,
        )
      taken(from)
      taken(to)
      const source = await existing(from)
      const { found, clash } = await repo.entry(to)
      if (found) throw new HttpError(409, `${to} is already in the vault`)
      // Only a rename of the file itself may change just the case of its name.
      if (clash && `${to.slice(0, to.lastIndexOf("/") + 1)}${clash}` !== from)
        throw new HttpError(
          409,
          `${clash} is already there: names that differ only in case break the vault on Windows and macOS`,
        )
      await insertChange(env, {
        draft_id: row.id,
        path: to,
        action: "rename",
        from_path: from,
        base_sha: source.sha,
        size: null,
        content_type: typeOf(to).mime,
        review: null,
        staged_at: now,
      })
      record("uploads.rename", from, { draft: row.id, to })
    } else if (body.action === "delete") {
      const target = vaultPath(body.path)
      taken(target)
      const source = await existing(target)
      await insertChange(env, {
        draft_id: row.id,
        path: target,
        action: "delete",
        from_path: null,
        base_sha: source.sha,
        size: null,
        content_type: null,
        review: null,
        staged_at: now,
      })
      record("uploads.delete", target, { draft: row.id })
    } else throw new HttpError(422, "action must be rename or delete")
    await touch(env, row.id)
    return json(await view(row.id))
  }

  // Take a change out of the draft.
  if (part === "changes" && request.method === "DELETE") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true, kind: "upload" })
    const target = url.searchParams.get("path") ?? ""
    const change = (await changesOf(env, row.id)).find((c) => c.path === target)
    if (!change) throw new HttpError(404, `${target} isn't part of this draft`)
    await env.DB.prepare("DELETE FROM upload_changes WHERE draft_id = ? AND path = ?")
      .bind(row.id, target)
      .run()
    if (change.action === "add" || change.action === "replace")
      await env.ARTIFACTS.delete(stagedKey(row.id, target))
    await touch(env, row.id)
    record("uploads.unstage", target, { draft: row.id, action: change.action })
    return json(await view(row.id))
  }

  // Send the draft to GitHub: its pull request is opened, or revised, and merges in the hour after.
  if (part === "send" && request.method === "POST") {
    requireMutation(request, env)
    const row = await ownDraft(env, id, session, { change: true, kind: "upload" })
    const changes = await changesOf(env, row.id)
    if (!changes.length) throw new HttpError(422, "add a file, a rename or a deletion first")
    await underLimit(env, session.login, ["uploads.send"], SENDS_PER_DAY, "sends")
    const { display_name } = await navIdentity(env, session)
    await send(env, repo, row, changes, display_name)
    const sent = await view(row.id)
    record("uploads.send", row.id, {
      pull: sent.pull?.number,
      changes: changes.length,
      due_at: sent.due_at,
      revision: row.sent_at !== null,
    })
    return json(sent)
  }

  throw new HttpError(405, "method not allowed")
}
