import { type Auditor, isAdmin } from "./audit"
import { requireMutation } from "./auth"
import type { Env } from "./env"
import { fileHeaders, storedMime, uploadKind } from "./gpt/context"
import { newId } from "./gpt/store"
import { HttpError, decodeSegment, json, readLimited } from "./http"
import type { Session } from "./session"

// Site announcements (D1 announcements, migration 0020). Admins write them in Markdown on
// /announcements (frontend/announcements/), attach files (R2, under announcements/<id>/) and choose
// when each goes live: publish_at, in ms, null for a draft. Every member gets a live one once, in a
// spotlight on the first page they open (GET /pending), until they dismiss it on any device; the
// page keeps all of them. Drafts, scheduled ones and their files are the admins' alone.

/** How long a live announcement is still shown in the spotlight: a new member isn't flooded. */
export const PENDING_DAYS = 30
/** At most this many in the spotlight at once, newest first. */
export const PENDING_MAX = 5
export const MAX_TITLE = 200
export const MAX_BODY_BYTES = 50_000
export const MAX_FILE_BYTES = 25 * 1024 * 1024
/** Files per announcement. */
export const MAX_FILES = 30
// Up to 2100-01-01: a ms timestamp, not seconds or a typo.
const MAX_PUBLISH_AT = 4_102_444_800_000

// Office documents download (fileHeaders serves any type it doesn't show as an attachment).
const OFFICE = /\.(?:docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i
const OFFICE_TYPES =
  /^application\/(?:msword|rtf|vnd\.ms-(?:excel|powerpoint)|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.oasis\.opendocument\.[a-z.]+|octet-stream|zip)$/

export type AnnouncementStatus = "draft" | "scheduled" | "live"

interface Row {
  id: string
  title: string
  body_md: string
  publish_at: number | null
  created_by: string
  created_at: number
  updated_at: number
  updated_by: string
  author_name: string | null
  author_path: string | null
  dismissed?: number | null
}

interface FileRow {
  id: string
  announcement_id: string
  name: string
  r2_key: string
  type: string
  size: number
  created_at: number
}

export const statusOf = (publishAt: number | null, now: number): AnnouncementStatus =>
  publishAt === null ? "draft" : publishAt <= now ? "live" : "scheduled"

const fileUrl = (id: string) => `/api/announcements/files/${encodeURIComponent(id)}`

const fileView = (file: FileRow) => ({
  id: file.id,
  name: file.name,
  type: file.type,
  size: file.size,
  url: fileUrl(file.id),
})

// The author as the site shows them: their People page's name once their claim is approved.
const SELECT = `SELECT a.*, p.name AS author_name, p.path AS author_path
  FROM announcements a
  LEFT JOIN profiles p ON p.login = a.created_by AND p.status = 'approved'`

function view(row: Row, files: FileRow[], now: number) {
  return {
    id: row.id,
    title: row.title,
    body_md: row.body_md,
    publish_at: row.publish_at,
    status: statusOf(row.publish_at, now),
    author: {
      login: row.created_by,
      name: row.author_name || row.created_by,
      // content/people/<slug>.md in the public vault: the page on the site.
      page: row.author_path
        ? "/" + row.author_path.replace(/^content\//, "").replace(/\.md$/, "")
        : null,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    files: files.filter((file) => file.announcement_id === row.id).map(fileView),
    ...(row.dismissed === undefined ? {} : { dismissed: row.dismissed !== null }),
  }
}

async function filesOf(env: Env, ids: string[]): Promise<FileRow[]> {
  if (!ids.length) return []
  const { results } = await env.DB.prepare(
    `SELECT * FROM announcement_files WHERE announcement_id IN (${ids.map(() => "?").join(", ")})
     ORDER BY created_at, id`,
  )
    .bind(...ids)
    .all<FileRow>()
  return results
}

async function views(env: Env, rows: Row[], now: number) {
  const files = await filesOf(
    env,
    rows.map((row) => row.id),
  )
  return rows.map((row) => view(row, files, now))
}

async function one(env: Env, id: string): Promise<Row | null> {
  return env.DB.prepare(`${SELECT} WHERE a.id = ?`).bind(id).first<Row>()
}

/** A title, body and go-live time from a request, over the announcement's current ones. */
export function readFields(
  body: unknown,
  current: { title: string; body_md: string; publish_at: number | null },
  now: number,
) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(422, "send the announcement as a JSON object")
  const sent = body as Record<string, unknown>
  for (const key of Object.keys(sent))
    if (!["title", "body_md", "publish_at"].includes(key))
      throw new HttpError(422, `unknown field: ${key}`)
  const next = { ...current }
  if (sent.title !== undefined) {
    if (typeof sent.title !== "string") throw new HttpError(422, "title must be text")
    const title = sent.title.replace(/\s+/g, " ").trim()
    if (title.length > MAX_TITLE)
      throw new HttpError(422, `the title is too long (at most ${MAX_TITLE} characters)`)
    next.title = title
  }
  if (sent.body_md !== undefined) {
    if (typeof sent.body_md !== "string") throw new HttpError(422, "body_md must be text")
    if (new TextEncoder().encode(sent.body_md).length > MAX_BODY_BYTES)
      throw new HttpError(422, `the text is too long (at most ${MAX_BODY_BYTES / 1000} kB)`)
    next.body_md = sent.body_md
  }
  if (sent.publish_at !== undefined) {
    const at = sent.publish_at
    // "now" is the Worker's clock, so a browser whose clock runs ahead doesn't schedule it.
    if (at === null || at === "now") next.publish_at = at === null ? null : now
    else if (typeof at === "number" && Number.isSafeInteger(at) && at >= 0 && at < MAX_PUBLISH_AT)
      next.publish_at = at
    else throw new HttpError(422, 'publish_at must be null, "now" or a time in ms')
  }
  if (next.publish_at !== null && !next.title)
    throw new HttpError(422, "give the announcement a title before it goes live")
  return next
}

async function readBody(request: Request): Promise<unknown> {
  const bytes = await readLimited(
    request,
    MAX_BODY_BYTES * 4 + 4096,
    "the announcement is too long",
  )
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpError(422, "request body must be JSON")
  }
}

/** The type a file is stored under, or null when it isn't one announcements take. */
export function attachmentType(mime: string, name: string): string | null {
  const kind = uploadKind(mime, name)
  if (kind) return storedMime(kind, mime)
  if (OFFICE.test(name) && (!mime || OFFICE_TYPES.test(mime)))
    return mime && mime !== "application/octet-stream" && mime !== "application/zip"
      ? mime
      : "application/octet-stream"
  return null
}

export async function announcementRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  session: Session,
  record: Auditor,
): Promise<Response | null> {
  const path = url.pathname
  if (path !== "/api/announcements" && !path.startsWith("/api/announcements/")) return null
  const method = request.method
  const now = Date.now()
  const login = session.login
  const admin = () => isAdmin(env, session)
  const requireAdmin = async () => {
    requireMutation(request, env)
    if (!(await admin())) throw new HttpError(403, "only admins can post announcements")
  }

  // ---- the spotlight: live, not dismissed by me, recent ----
  if (path === "/api/announcements/pending") {
    if (method !== "GET") throw new HttpError(405, "method not allowed")
    const { results } = await env.DB.prepare(
      `${SELECT}
       WHERE a.publish_at IS NOT NULL AND a.publish_at <= ? AND a.publish_at > ?
         AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d
                         WHERE d.announcement_id = a.id AND d.login = ?)
       ORDER BY a.publish_at DESC, a.id DESC LIMIT ?`,
    )
      .bind(now, now - PENDING_DAYS * 86_400_000, login, PENDING_MAX)
      .all<Row>()
    return json({ announcements: await views(env, results, now) })
  }

  // ---- the archive (admins: drafts and scheduled ones too) ----
  if (path === "/api/announcements") {
    if (method === "GET") {
      const isAdmin = await admin()
      const { results } = await env.DB.prepare(
        `SELECT * FROM (${SELECT}) a
         LEFT JOIN (SELECT announcement_id, at AS dismissed FROM announcement_dismissals
                    WHERE login = ?) d ON d.announcement_id = a.id
         ${isAdmin ? "" : "WHERE a.publish_at IS NOT NULL AND a.publish_at <= ?"}
         ORDER BY a.publish_at IS NULL DESC, a.publish_at DESC, a.updated_at DESC LIMIT 200`,
      )
        .bind(...(isAdmin ? [login] : [login, now]))
        .all<Row>()
      return json({ announcements: await views(env, results, now), is_admin: isAdmin, now })
    }
    if (method !== "POST") throw new HttpError(405, "method not allowed")
    await requireAdmin()
    const fields = readFields(
      await readBody(request),
      { title: "", body_md: "", publish_at: null },
      now,
    )
    const id = newId("ann")
    await env.DB.prepare(
      `INSERT INTO announcements (id, title, body_md, publish_at, created_by, created_at, updated_at,
         updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, fields.title, fields.body_md, fields.publish_at, login, now, now, login)
      .run()
    record("announcement.create", id, { title: fields.title, publish_at: fields.publish_at })
    return json(view((await one(env, id))!, [], now), 201)
  }

  // ---- attachments ----
  const fileMatch = path.match(/^\/api\/announcements\/files\/([^/]+)$/)
  if (fileMatch) {
    const file = await env.DB.prepare(
      `SELECT f.*, a.publish_at FROM announcement_files f
       JOIN announcements a ON a.id = f.announcement_id WHERE f.id = ?`,
    )
      .bind(decodeSegment(fileMatch[1]))
      .first<FileRow & { publish_at: number | null }>()
    if (method === "GET" || method === "HEAD") {
      // A draft's or a scheduled announcement's files are as hidden as it is.
      if (!file || (statusOf(file.publish_at, now) !== "live" && !(await admin())))
        throw new HttpError(404, "file not found")
      const object = await env.ARTIFACTS.get(file.r2_key)
      if (!object) throw new HttpError(404, "file not found")
      return new Response(method === "HEAD" ? null : object.body, {
        headers: {
          ...fileHeaders({ mime: file.type, name: file.name }),
          "content-length": String(object.size),
        },
      })
    }
    if (method !== "DELETE") throw new HttpError(405, "method not allowed")
    await requireAdmin()
    if (!file) throw new HttpError(404, "file not found")
    await env.DB.prepare("DELETE FROM announcement_files WHERE id = ?").bind(file.id).run()
    ctx.waitUntil(env.ARTIFACTS.delete(file.r2_key))
    record("announcement.file.delete", file.announcement_id, { file: file.id, name: file.name })
    return json({ deleted: file.id })
  }

  const match = path.match(/^\/api\/announcements\/([^/]+)(?:\/(dismiss|files))?$/)
  if (!match) throw new HttpError(404, "not found")
  const id = decodeSegment(match[1])
  const row = await one(env, id)
  const visible = row && (statusOf(row.publish_at, now) === "live" || (await admin()))
  if (!row || !visible) throw new HttpError(404, "announcement not found")

  if (match[2] === "dismiss") {
    if (method !== "POST") throw new HttpError(405, "method not allowed")
    requireMutation(request, env)
    if (statusOf(row.publish_at, now) !== "live") throw new HttpError(404, "announcement not found")
    await env.DB.prepare(
      `INSERT OR IGNORE INTO announcement_dismissals (announcement_id, login, at) VALUES (?, ?, ?)`,
    )
      .bind(id, login, now)
      .run()
    record("announcement.dismiss", id)
    return json({ dismissed: id })
  }

  if (match[2] === "files") {
    if (method !== "POST") throw new HttpError(405, "method not allowed")
    await requireAdmin()
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM announcement_files WHERE announcement_id = ?",
    )
      .bind(id)
      .first<{ n: number }>()
    if ((count?.n ?? 0) >= MAX_FILES)
      throw new HttpError(409, `an announcement can have at most ${MAX_FILES} files`)
    if (Number(request.headers.get("content-length") ?? 0) > MAX_FILE_BYTES + 64 * 1024)
      throw new HttpError(413, "files can be up to 25 MB")
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      throw new HttpError(422, "upload a file as multipart/form-data")
    }
    const file = form.get("file")
    if (!file || typeof file === "string") throw new HttpError(422, "choose a file")
    if (file.size > MAX_FILE_BYTES) throw new HttpError(413, "files can be up to 25 MB")
    const name = (file.name || "file").replace(/[\\/\r\n"]/g, "_").slice(0, 200)
    const type = attachmentType(file.type || "", name)
    if (!type)
      throw new HttpError(
        415,
        `${name}: attach images (PNG, JPEG, GIF, WebP), PDFs, text files or Office documents`,
      )
    const fileId = newId("af")
    const key = `announcements/${id}/${fileId}/${name}`
    await env.ARTIFACTS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type } })
    const stored: FileRow = {
      id: fileId,
      announcement_id: id,
      name,
      r2_key: key,
      type,
      size: file.size,
      created_at: now,
    }
    await env.DB.prepare(
      `INSERT INTO announcement_files (id, announcement_id, name, r2_key, type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(fileId, id, name, key, type, file.size, now)
      .run()
    record("announcement.file", id, { file: fileId, name, size: file.size, type })
    return json(fileView(stored), 201)
  }

  if (method === "GET") return json((await views(env, [row], now))[0])
  if (method === "PUT") {
    await requireAdmin()
    const fields = readFields(await readBody(request), row, now)
    await env.DB.prepare(
      `UPDATE announcements SET title = ?, body_md = ?, publish_at = ?, updated_at = ?,
         updated_by = ? WHERE id = ?`,
    )
      .bind(fields.title, fields.body_md, fields.publish_at, now, login, id)
      .run()
    record("announcement.update", id, { title: fields.title, publish_at: fields.publish_at })
    return json((await views(env, [(await one(env, id))!], now))[0])
  }
  if (method === "DELETE") {
    await requireAdmin()
    const files = await filesOf(env, [id])
    await env.DB.batch([
      env.DB.prepare("DELETE FROM announcement_dismissals WHERE announcement_id = ?").bind(id),
      env.DB.prepare("DELETE FROM announcement_files WHERE announcement_id = ?").bind(id),
      env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(id),
    ])
    if (files.length) ctx.waitUntil(env.ARTIFACTS.delete(files.map((file) => file.r2_key)))
    record("announcement.delete", id, { title: row.title, files: files.length })
    return json({ deleted: id })
  }
  throw new HttpError(405, "method not allowed")
}
