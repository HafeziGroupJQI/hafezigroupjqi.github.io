import type { Auditor } from "../audit"
import { requireMutation } from "../auth"
import type { Env } from "../env"
import { HttpError, decodeSegment, json, readJson } from "../http"
import type { Session } from "../session"
import { type Page, getScalar, splitPage } from "./frontmatter"
import { PEOPLE_PAGE, Vault, type VaultFetch } from "./vault"

// A member's own settings (/settings): their People page in the public vault, and a photo. Each
// member links their GitHub login to one People page once (the page gets `github: <login>`).
// Saving queues the edit (profile_pending); the hourly cron commits every edit that is due in one
// vault commit (publish.ts), so the site rebuilds at most once an hour and an edit can be revised
// until it goes in. D1 keeps the link, the name and the photo, so the navbar shows a saved edit at
// once, while the People page changes when the commit is deployed.

/** Front matter a member may change on their own page. Role and group stay with the vault's editors. */
export const EDITABLE = ["title", "email", "building", "office", "scope", "profile"] as const
export type Field = (typeof EDITABLE)[number]

const LIMITS: Record<Field, number> = {
  title: 100,
  email: 200,
  building: 200,
  office: 100,
  scope: 500,
  profile: 300,
}
const PHOTO_MAX = 1024 * 1024
/** Saves (edits, photos, links) one member may make in 24 hours. */
export const SAVES_PER_DAY = 60
/** The publishing window: edits go into the vault on the hour. */
export const WINDOW_MS = 3600_000

/**
 * When an edit saved at `now` is published: at the end of the hour after this one, so it can be
 * revised for at least one full hour (1 h to 1 h 59 min).
 */
export const dueAt = (now: number) => Math.floor(now / WINDOW_MS) * WINDOW_MS + 2 * WINDOW_MS

interface ProfileRow {
  login: string
  path: string
  name: string | null
  photo_url: string | null
  photo_at: number | null
}

export interface PendingRow {
  login: string
  path: string
  fields_json: string
  link: number
  photo_at: number | null
  saved_at: number
  due_at: number
}

export const photoKey = (login: string, which: "photo" | "pending") =>
  `profiles/${login.toLowerCase()}/${which}.jpg`

export async function profileRow(env: Env, login: string): Promise<ProfileRow | null> {
  return env.DB.prepare("SELECT * FROM profiles WHERE login = ? COLLATE NOCASE")
    .bind(login)
    .first<ProfileRow>()
}

async function pendingRow(env: Env, login: string): Promise<PendingRow | null> {
  return env.DB.prepare("SELECT * FROM profile_pending WHERE login = ? COLLATE NOCASE")
    .bind(login)
    .first<PendingRow>()
}

const pendingFields = (row: PendingRow | null): Partial<Record<Field, string | null>> =>
  row ? JSON.parse(row.fields_json) : {}

function pendingView(row: PendingRow | null) {
  if (!row) return null
  return {
    fields: Object.keys(pendingFields(row)),
    photo: row.photo_at !== null,
    link: row.link === 1,
    saved_at: row.saved_at,
    due_at: row.due_at,
  }
}

/** What the navbar shows for a member: their chosen name and photo, saved or published. */
export async function navIdentity(
  env: Env,
  session: Session,
): Promise<{ display_name: string; avatar: string | null }> {
  const [row, pending] = await Promise.all([
    profileRow(env, session.login),
    pendingRow(env, session.login),
  ])
  const photoAt = pending?.photo_at ?? row?.photo_at
  const avatar = photoAt
    ? `/api/profile/photo/${encodeURIComponent(session.login)}?v=${photoAt}`
    : (row?.photo_url ?? null)
  const name = pendingFields(pending).title || row?.name || session.name || session.login
  return { display_name: name, avatar }
}

export const slugOf = (path: string) => PEOPLE_PAGE.exec(path)?.[1] ?? ""
const pageUrl = (path: string) => "/" + path.replace(/^content\//, "").replace(/\.md$/, "")
export const siteUrl = (vaultPath: string | null) =>
  vaultPath && /^assets\/people\/[^/]+$/.test(vaultPath) ? `/${vaultPath}` : null

export function fields(page: Page): Record<Field, string | null> {
  return Object.fromEntries(EDITABLE.map((key) => [key, getScalar(page, key)])) as Record<
    Field,
    string | null
  >
}

function parse(text: string | null, path: string): Page {
  const page = text === null ? null : splitPage(text)
  if (!page) throw new HttpError(409, `${path} is missing or has no front matter`)
  return page
}

function checkLinked(page: Page, login: string, path: string): void {
  const owner = getScalar(page, "github")
  if (owner && owner.toLowerCase() !== login.toLowerCase())
    throw new HttpError(409, `${path} is linked to another GitHub login (${owner})`)
}

function clean(field: Field, value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw new HttpError(422, `${field} must be text`)
  const text = value.trim()
  if (!text) {
    if (field === "title") throw new HttpError(422, "your name can't be empty")
    return null
  }
  if (/[\r\n]/.test(text)) throw new HttpError(422, `${field} must be one line`)
  if (text.length > LIMITS[field])
    throw new HttpError(422, `${field} is longer than ${LIMITS[field]} characters`)
  if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
    throw new HttpError(422, "enter an email address like name@umd.edu, or leave it empty")
  if (field === "profile" && !/^https?:\/\/\S+$/.test(text))
    throw new HttpError(422, "the profile link must start with https://")
  return text
}

async function underDailyLimit(env: Env, login: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audit_log WHERE login = ? AND action IN
       ('profile.claim', 'profile.save', 'profile.photo') AND at > ?`,
  )
    .bind(login, Date.now() - 24 * 3600 * 1000)
    .first<{ n: number }>()
  if ((row?.n ?? 0) >= SAVES_PER_DAY)
    throw new HttpError(429, `at most ${SAVES_PER_DAY} profile saves a day; try again tomorrow`)
}

/**
 * Queue a change to a member's page: merge it into their pending edit and move its due time to
 * the window after this one. A field set back to what the page already says is no longer pending;
 * an edit with nothing left in it is dropped.
 */
async function queue(
  env: Env,
  row: ProfileRow,
  published: Record<Field, string | null>,
  change: { fields?: Partial<Record<Field, string | null>>; photo?: boolean; link?: boolean },
): Promise<PendingRow | null> {
  const now = Date.now()
  const before = await pendingRow(env, row.login)
  const merged = { ...pendingFields(before), ...(change.fields ?? {}) }
  for (const field of Object.keys(merged) as Field[])
    if (merged[field] === published[field]) delete merged[field]
  const link = before?.link === 1 || change.link === true
  const photoAt = change.photo ? now : (before?.photo_at ?? null)
  if (!Object.keys(merged).length && !link && photoAt === null) {
    await env.DB.prepare("DELETE FROM profile_pending WHERE login = ?").bind(row.login).run()
    return null
  }
  const next: PendingRow = {
    login: row.login,
    path: row.path,
    fields_json: JSON.stringify(merged),
    link: link ? 1 : 0,
    photo_at: photoAt,
    saved_at: now,
    due_at: dueAt(now),
  }
  await env.DB.prepare(
    `INSERT INTO profile_pending (login, path, fields_json, link, photo_at, saved_at, due_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (login) DO UPDATE SET path = ?2, fields_json = ?3, link = ?4, photo_at = ?5,
       saved_at = ?6, due_at = ?7`,
  )
    .bind(next.login, next.path, next.fields_json, next.link, next.photo_at, now, next.due_at)
    .run()
  return next
}

export async function profileRoutes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  record: Auditor,
  vaultFetch: VaultFetch,
): Promise<Response | null> {
  const path = url.pathname
  if (path !== "/api/profile" && !path.startsWith("/api/profile/")) return null
  const vault = new Vault(env, vaultFetch)

  // A member's photo: a saved one waiting to be published, else the published one.
  const photo = path.match(/^\/api\/profile\/photo\/([^/]+)$/)
  if (photo && request.method === "GET") {
    const login = decodeSegment(photo[1])
    const object =
      (await env.ARTIFACTS.get(photoKey(login, "pending"))) ??
      (await env.ARTIFACTS.get(photoKey(login, "photo")))
    if (!object) throw new HttpError(404, "no photo")
    return new Response(object.body, {
      headers: { "content-type": "image/jpeg", "content-length": String(object.size) },
    })
  }

  if (path === "/api/profile" && request.method === "GET") {
    const row = await profileRow(env, session.login)
    const identity = await navIdentity(env, session)
    const base = { login: session.login, ...identity, vault_ready: vault.ready }
    if (!vault.ready) return json({ ...base, page: null, pending: null, claimable: [] })
    if (row) {
      const page = parse(await vault.read(row.path), row.path)
      const pending = await pendingRow(env, row.login)
      return json({
        ...base,
        page: {
          path: row.path,
          slug: slugOf(row.path),
          url: pageUrl(row.path),
          // What the member last saved: the page as published, with their pending edit over it.
          fields: { ...fields(page), ...pendingFields(pending) },
          published: fields(page),
          role: getScalar(page, "role"),
          group: getScalar(page, "group"),
          photo: siteUrl(getScalar(page, "photo")),
        },
        pending: pendingView(pending),
        claimable: [],
      })
    }
    const { tree } = await vault.head()
    const { results } = await env.DB.prepare("SELECT path FROM profiles").all<{ path: string }>()
    const taken = new Set(results.map((r) => r.path))
    const claimable = (await vault.peoplePages(tree))
      .filter((p) => !taken.has(p))
      .map((p) => ({ path: p, slug: slugOf(p), alumni: p.includes("/alumni/") }))
    return json({ ...base, page: null, pending: null, claimable })
  }

  if (path === "/api/profile/claim" && request.method === "POST") {
    requireMutation(request, env)
    const body = (await readJson(request)) as { path?: unknown }
    const target = typeof body.path === "string" ? body.path : ""
    if (!PEOPLE_PAGE.test(target) || target.endsWith("/index.md"))
      throw new HttpError(422, "choose a People page")
    const existing = await profileRow(env, session.login)
    if (existing) throw new HttpError(409, `you are already linked to ${existing.path}`)
    const other = await env.DB.prepare("SELECT login FROM profiles WHERE path = ?")
      .bind(target)
      .first<{ login: string }>()
    if (other) throw new HttpError(409, `${target} is already linked to another member`)
    await underDailyLimit(env, session.login)
    const page = parse(await vault.read(target), target)
    checkLinked(page, session.login, target)
    const row: ProfileRow = {
      login: session.login,
      path: target,
      name: getScalar(page, "title"),
      photo_url: siteUrl(getScalar(page, "photo")),
      photo_at: null,
    }
    await env.DB.prepare(
      `INSERT INTO profiles (login, path, name, photo_url, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(row.login, row.path, row.name, row.photo_url, Date.now())
      .run()
    // The page gets `github: <login>` with the next hourly commit (none if it already has it).
    const pending = getScalar(page, "github")
      ? null
      : await queue(env, row, fields(page), { link: true })
    record("profile.claim", target, { queued: pending !== null })
    return json({ path: target, pending: pendingView(pending) })
  }

  if (path === "/api/profile" && request.method === "PUT") {
    requireMutation(request, env)
    const row = await profileRow(env, session.login)
    if (!row) throw new HttpError(409, "link your People page first")
    const body = (await readJson(request)) as Record<string, unknown>
    const wanted: Partial<Record<Field, string | null>> = {}
    for (const field of EDITABLE) if (field in body) wanted[field] = clean(field, body[field])
    await underDailyLimit(env, session.login)
    const page = parse(await vault.read(row.path), row.path)
    checkLinked(page, session.login, row.path)
    const pending = await queue(env, row, fields(page), { fields: wanted })
    record("profile.save", row.path, { fields: Object.keys(wanted) })
    return json({ pending: pendingView(pending) })
  }

  // A new photo, sent when the member saves (never on choosing it): queued like any edit.
  if (path === "/api/profile/photo" && request.method === "PUT") {
    requireMutation(request, env)
    const row = await profileRow(env, session.login)
    if (!row) throw new HttpError(409, "link your People page first")
    if (!/^image\/jpeg\b/.test(request.headers.get("content-type") ?? ""))
      throw new HttpError(415, "send the photo as a JPEG")
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (bytes.length > PHOTO_MAX) throw new HttpError(413, "the photo is larger than 1 MB")
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
      throw new HttpError(422, "that file is not a JPEG image")
    await underDailyLimit(env, session.login)
    const page = parse(await vault.read(row.path), row.path)
    checkLinked(page, session.login, row.path)
    await env.ARTIFACTS.put(photoKey(session.login, "pending"), bytes, {
      httpMetadata: { contentType: "image/jpeg" },
    })
    const pending = await queue(env, row, fields(page), { photo: true })
    record("profile.photo", row.path, { bytes: bytes.length })
    return json({
      avatar: `/api/profile/photo/${encodeURIComponent(session.login)}?v=${pending!.photo_at}`,
      pending: pendingView(pending),
    })
  }

  // Take back everything saved but not yet published (a new link stays: it isn't the member's edit).
  if (path === "/api/profile/pending" && request.method === "DELETE") {
    requireMutation(request, env)
    const row = await profileRow(env, session.login)
    const before = await pendingRow(env, session.login)
    if (!row || !before) return json({ pending: null })
    await env.ARTIFACTS.delete(photoKey(session.login, "pending"))
    await env.DB.prepare("DELETE FROM profile_pending WHERE login = ?").bind(row.login).run()
    const page = parse(await vault.read(row.path), row.path)
    const pending = before.link ? await queue(env, row, fields(page), { link: true }) : null
    record("profile.discard", row.path)
    return json({ pending: pendingView(pending) })
  }

  throw new HttpError(404, "not found")
}
