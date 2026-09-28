import type { Auditor } from "../audit"
import { requireMutation } from "../auth"
import type { Env } from "../env"
import { HttpError, decodeSegment, json, readJson } from "../http"
import type { Session } from "../session"
import { type Page, getScalar, joinPage, setScalar, splitPage } from "./frontmatter"
import { PEOPLE_PAGE, Vault, type VaultFetch, type VaultFile } from "./vault"

// A member's own settings (/settings): their People page in the public vault, edited by a commit
// there, and a photo. Each member links their GitHub login to one People page once (the page gets
// `github: <login>`); D1 keeps the link, the name and the photo so the navbar shows an edit at
// once, while the People page itself changes when the vault commit is deployed.

/** Front matter a member may change on their own page. Role and group stay with the vault's editors. */
export const EDITABLE = ["title", "email", "building", "office", "scope", "profile"] as const
type Field = (typeof EDITABLE)[number]

const LIMITS: Record<Field, number> = {
  title: 100,
  email: 200,
  building: 200,
  office: 100,
  scope: 500,
  profile: 300,
}
const PHOTO_MAX = 1024 * 1024
/** Vault commits one member may make in 24 hours (each one rebuilds both sites). */
export const DAILY_COMMITS = 20

interface ProfileRow {
  login: string
  path: string
  name: string | null
  photo_url: string | null
  photo_at: number | null
}

export async function profileRow(env: Env, login: string): Promise<ProfileRow | null> {
  return env.DB.prepare("SELECT * FROM profiles WHERE login = ? COLLATE NOCASE")
    .bind(login)
    .first<ProfileRow>()
}

/** What the navbar shows for a member: their chosen name and photo, if they have set them. */
export async function navIdentity(
  env: Env,
  session: Session,
): Promise<{ display_name: string; avatar: string | null }> {
  const row = await profileRow(env, session.login)
  const avatar = row?.photo_at
    ? `/api/profile/photo/${encodeURIComponent(session.login)}?v=${row.photo_at}`
    : (row?.photo_url ?? null)
  return { display_name: row?.name || session.name || session.login, avatar }
}

const slugOf = (path: string) => PEOPLE_PAGE.exec(path)?.[1] ?? ""
const pageUrl = (path: string) => "/" + path.replace(/^content\//, "").replace(/\.md$/, "")
const siteUrl = (vaultPath: string | null) =>
  vaultPath && /^assets\/people\/[^/]+$/.test(vaultPath) ? `/${vaultPath}` : null

function fields(page: Page): Record<Field, string | null> {
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
       ('profile.claim', 'profile.update', 'profile.photo') AND at > ?`,
  )
    .bind(login, Date.now() - 24 * 3600 * 1000)
    .first<{ n: number }>()
  if ((row?.n ?? 0) >= DAILY_COMMITS)
    throw new HttpError(429, `at most ${DAILY_COMMITS} profile changes a day; try again tomorrow`)
}

const author = (session: Session) => ({
  name: session.name || session.login,
  email: `${session.login}@users.noreply.github.com`,
})

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

  const photo = path.match(/^\/api\/profile\/photo\/([^/]+)$/)
  if (photo && request.method === "GET") {
    const login = decodeSegment(photo[1]).toLowerCase()
    const object = await env.ARTIFACTS.get(`profiles/${login}/photo.jpg`)
    if (!object) throw new HttpError(404, "no photo")
    return new Response(object.body, {
      headers: { "content-type": "image/jpeg", "content-length": String(object.size) },
    })
  }

  if (path === "/api/profile" && request.method === "GET") {
    const row = await profileRow(env, session.login)
    const identity = await navIdentity(env, session)
    const base = { login: session.login, ...identity, vault_ready: vault.ready }
    if (!vault.ready) return json({ ...base, page: null, claimable: [] })
    if (row) {
      const page = parse(await vault.read(row.path), row.path)
      return json({
        ...base,
        page: {
          path: row.path,
          slug: slugOf(row.path),
          url: pageUrl(row.path),
          fields: fields(page),
          role: getScalar(page, "role"),
          group: getScalar(page, "group"),
          photo: siteUrl(getScalar(page, "photo")),
        },
        claimable: [],
      })
    }
    const { tree } = await vault.head()
    const { results } = await env.DB.prepare("SELECT path FROM profiles").all<{ path: string }>()
    const taken = new Set(results.map((r) => r.path))
    const claimable = (await vault.peoplePages(tree))
      .filter((p) => !taken.has(p))
      .map((p) => ({ path: p, slug: slugOf(p), alumni: p.includes("/alumni/") }))
    return json({ ...base, page: null, claimable })
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
    let page: Page | null = null
    let committed = false
    await vault.commit(
      author(session),
      async () => {
        page = parse(await vault.read(target), target)
        checkLinked(page, session.login, target)
        if (getScalar(page, "github")) return { files: [], message: "" }
        setScalar(page, "github", session.login)
        committed = true
        return {
          files: [{ path: target, content: joinPage(page) }],
          message:
            `link people/${slugOf(target)} to the github login ${session.login}`.toLowerCase(),
        }
      },
      { skipEmpty: true },
    )
    const linked = page as Page | null
    await env.DB.prepare(
      `INSERT INTO profiles (login, path, name, photo_url, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        session.login,
        target,
        linked ? getScalar(linked, "title") : null,
        linked ? siteUrl(getScalar(linked, "photo")) : null,
        Date.now(),
      )
      .run()
    record("profile.claim", target, { committed })
    return json({ path: target, committed })
  }

  if (path === "/api/profile" && request.method === "PUT") {
    requireMutation(request, env)
    const row = await profileRow(env, session.login)
    if (!row) throw new HttpError(409, "link your People page first")
    const body = (await readJson(request)) as Record<string, unknown>
    const wanted: Partial<Record<Field, string | null>> = {}
    for (const field of EDITABLE) if (field in body) wanted[field] = clean(field, body[field])
    await underDailyLimit(env, session.login)
    let changed: Field[] = []
    let title: string | null = null
    const sha = await vault.commit(
      author(session),
      async () => {
        const page = parse(await vault.read(row.path), row.path)
        checkLinked(page, session.login, row.path)
        const current = fields(page)
        changed = EDITABLE.filter((f) => f in wanted && wanted[f] !== current[f])
        for (const field of changed) setScalar(page, field, wanted[field] ?? null)
        title = getScalar(page, "title")
        return {
          files: changed.length ? [{ path: row.path, content: joinPage(page) }] : [],
          message: `update people/${slugOf(row.path)} from the members site settings`,
        }
      },
      { skipEmpty: true },
    )
    await env.DB.prepare("UPDATE profiles SET name = ?, updated_at = ? WHERE login = ?")
      .bind(title, Date.now(), row.login)
      .run()
    if (changed.length) record("profile.update", row.path, { fields: changed })
    return json({ changed, commit: sha })
  }

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
    const slug = slugOf(row.path)
    const photoPath = `assets/people/${slug}.jpg`
    await vault.commit(author(session), async () => {
      const page = parse(await vault.read(row.path), row.path)
      checkLinked(page, session.login, row.path)
      const old = getScalar(page, "photo")
      setScalar(page, "photo", photoPath)
      // The page shows its photo as the first embed (the People card reads `photo`).
      if (old && page.body.includes(`![[${old}]]`))
        page.body = page.body.replace(`![[${old}]]`, `![[${photoPath}]]`)
      else if (!page.body.includes(`![[${photoPath}]]`))
        page.body = `\n![[${photoPath}]]\n` + page.body.replace(/^\n+/, "\n")
      const files: VaultFile[] = [
        { path: `content/${photoPath}`, content: bytes },
        { path: row.path, content: joinPage(page) },
      ]
      // A photo of this person's own under another extension is replaced, not left behind.
      if (old && old !== photoPath && new RegExp(`^assets/people/${slug}\\.\\w+$`).test(old))
        files.push({ path: `content/${old}`, content: null })
      return { files, message: `update the photo on people/${slug} from the members site settings` }
    })
    const at = Date.now()
    await env.ARTIFACTS.put(`profiles/${session.login.toLowerCase()}/photo.jpg`, bytes, {
      httpMetadata: { contentType: "image/jpeg" },
    })
    await env.DB.prepare(
      "UPDATE profiles SET photo_url = ?, photo_at = ?, updated_at = ? WHERE login = ?",
    )
      .bind(`/${photoPath}`, at, at, row.login)
      .run()
    record("profile.photo", row.path, { bytes: bytes.length })
    return json({ avatar: `/api/profile/photo/${encodeURIComponent(session.login)}?v=${at}` })
  }

  throw new HttpError(404, "not found")
}
