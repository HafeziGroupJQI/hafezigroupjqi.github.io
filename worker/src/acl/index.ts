import { type Auditor, isAdmin } from "../audit"
import type { Env } from "../env"
import { HttpError } from "../http"
import type { Session } from "../session"
import { AclPolicy, type AclRule, type AclSnapshot } from "./policy"

// The access rules at work (policy.ts says what they mean): read from D1 once per isolate and
// kept, asking D1 at most every RECHECK_MS whether acl_meta.version moved, so a change applies
// within seconds and costs requests one small query now and then. A reader is a session's login,
// its approved People page (profiles) and whether it is an admin's; site paths map to vault paths
// through the build's static/acl-refs.json (aliases, notebook assets, PDFs, pages).

/** How long a version is trusted before D1 is asked again. */
export const RECHECK_MS = 15_000
/** How long a login's People page is kept. */
const PERSON_TTL_MS = 60_000
/** How long whether a session is an admin's is kept: every file of a page asks. */
const ADMIN_TTL_MS = 30_000

interface Memo {
  db: D1Database
  version: number
  policy: AclPolicy
  checked: number
}
let memo: Memo | null = null
let loading: Promise<AclPolicy> | null = null
const people = new Map<string, { person: string | null; at: number }>()
const admins = new Map<string, { admin: boolean; at: number }>()

/** Forget what this isolate keeps (tests, and the admin API after a change). */
export function resetAcl(): void {
  memo = null
  loading = null
  people.clear()
  admins.clear()
  refsMemo = new WeakMap()
}

/** The rules and groups as D1 holds them now: the snapshot the build and the admin API see. */
export async function readSnapshot(env: Pick<Env, "DB">): Promise<AclSnapshot> {
  const [meta, groups, members, rules] = await env.DB.batch<any>([
    env.DB.prepare("SELECT version FROM acl_meta WHERE id = 1"),
    env.DB.prepare("SELECT id, name FROM acl_groups ORDER BY name"),
    env.DB.prepare("SELECT group_id, login, person FROM acl_group_members ORDER BY login, person"),
    env.DB.prepare(
      "SELECT id, pattern, allow_json, deny_json, note FROM acl_rules ORDER BY CAST(substr(id, 2) AS INTEGER), id",
    ),
  ])
  const byId = new Map<number, string>()
  const out: AclSnapshot = {
    version: (meta.results[0] as { version: number } | undefined)?.version ?? 0,
    groups: {},
    rules: [],
  }
  for (const group of groups.results as { id: number; name: string }[]) {
    byId.set(group.id, group.name)
    out.groups[group.name] = { logins: [], people: [] }
  }
  for (const member of members.results as {
    group_id: number
    login: string | null
    person: string | null
  }[]) {
    const group = out.groups[byId.get(member.group_id) ?? ""]
    if (!group) continue
    if (member.login) group.logins.push(member.login.toLowerCase())
    if (member.person) group.people.push(member.person)
  }
  for (const rule of rules.results as {
    id: string
    pattern: string
    allow_json: string
    deny_json: string
    note: string
  }[])
    out.rules.push({
      id: rule.id,
      pattern: rule.pattern,
      allow: parseList(rule.allow_json),
      deny: parseList(rule.deny_json),
      note: rule.note,
    } satisfies AclRule)
  return out
}

function parseList(raw: string): string[] {
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((x) => typeof x === "string") : []
  } catch {
    return []
  }
}

/** The live policy, from this isolate's copy while its version is current. */
export async function aclPolicy(env: Pick<Env, "DB">, now = Date.now()): Promise<AclPolicy> {
  if (memo && memo.db === env.DB) {
    if (now - memo.checked < RECHECK_MS) return memo.policy
    const row = await env.DB.prepare("SELECT version FROM acl_meta WHERE id = 1").first<{
      version: number
    }>()
    if ((row?.version ?? 0) === memo.version) {
      memo.checked = now
      return memo.policy
    }
  }
  if (!loading)
    loading = readSnapshot(env)
      .then((snapshot) => {
        const policy = new AclPolicy(snapshot)
        memo = { db: env.DB, version: snapshot.version, policy, checked: Date.now() }
        return policy
      })
      .finally(() => {
        loading = null
      })
  return loading
}

/** Keep a snapshot just written (the admin API), so this isolate applies it at once. */
export function useSnapshot(env: Pick<Env, "DB">, snapshot: AclSnapshot): AclPolicy {
  const policy = new AclPolicy(snapshot)
  memo = { db: env.DB, version: snapshot.version, policy, checked: Date.now() }
  return policy
}

const PEOPLE_PATH = /^content\/(people\/(?:alumni\/)?[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

/** A login's People page ("people/<slug>"), once an admin approved their claim of it. */
export async function personOf(env: Pick<Env, "DB">, login: string): Promise<string | null> {
  const key = login.toLowerCase()
  const kept = people.get(key)
  if (kept && Date.now() - kept.at < PERSON_TTL_MS) return kept.person
  const row = await env.DB.prepare(
    "SELECT path FROM profiles WHERE login = ? COLLATE NOCASE AND status = 'approved'",
  )
    .bind(key)
    .first<{ path: string }>()
  const person = (row && PEOPLE_PATH.exec(row.path)?.[1]) || null
  people.set(key, { person, at: Date.now() })
  return person
}

/** Every login's approved People page, at once (the compute host's question about everyone). */
export async function peopleOf(env: Pick<Env, "DB">): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare(
    "SELECT login, path FROM profiles WHERE status = 'approved'",
  ).all<{ login: string; path: string }>()
  const out = new Map<string, string>()
  for (const row of results) {
    const person = PEOPLE_PATH.exec(row.path)?.[1]
    if (person) out.set(row.login.toLowerCase(), person)
  }
  return out
}

// ---- readers ----

export interface AclViewer {
  login: string
  person: string | null
  admin: boolean
  policy: AclPolicy
  /** Whether no rule can stop this reader (an admin, or no rules at all). */
  open: boolean
  /** The rules whose paths this reader may read, as a cache key: same key, same view. */
  key: string
  /** Whether this reader may read a vault path. */
  canRead(path: string): boolean
  /** Whether this reader may read what a rule decides (an unknown rule's: never, unless open). */
  canReadRule(id: string): boolean
}

export function viewerFor(
  policy: AclPolicy,
  reader: { login: string; person: string | null; admin: boolean },
): AclViewer {
  const open = reader.admin || policy.empty
  const principals = policy.principals(reader)
  const readable = new Set(
    policy.rules.filter((rule) => open || policy.ruleAdmits(rule, principals)).map((r) => r.id),
  )
  return {
    ...reader,
    policy,
    open,
    key: open ? `v${policy.version}:*` : `v${policy.version}:${[...readable].sort().join(",")}`,
    canRead: (path) => {
      if (open) return true
      const rule = policy.ruleFor(path)
      return !rule || readable.has(rule.id)
    },
    canReadRule: (id) => open || readable.has(id),
  }
}

/** isAdmin, kept a few seconds per login and role (a page's every file asks). */
async function adminOf(env: Env, session: Session): Promise<boolean> {
  const key = `${session.login}\n${session.role}\n${session.lab ? "lab" : ""}`
  const kept = admins.get(key)
  if (kept && Date.now() - kept.at < ADMIN_TTL_MS) return kept.admin
  const admin = await isAdmin(env, session)
  if (admins.size > 1000) admins.clear()
  admins.set(key, { admin, at: Date.now() })
  return admin
}

const viewers = new WeakMap<object, Promise<AclViewer>>()

/** The reader a session is, once per request (the session object is the request's own). */
export function aclViewer(env: Env, session: Session): Promise<AclViewer> {
  let viewer = viewers.get(session)
  if (!viewer) {
    viewer = (async () => {
      const policy = await aclPolicy(env)
      if (policy.empty)
        return viewerFor(policy, { login: session.login, person: null, admin: false })
      const [admin, person] = await Promise.all([
        adminOf(env, session),
        personOf(env, session.login),
      ])
      return viewerFor(policy, { login: session.login, person, admin })
    })()
    viewer.catch(() => viewers.delete(session))
    viewers.set(session, viewer)
  }
  return viewer
}

export async function canReadVaultPath(
  env: Env,
  session: Session,
  vaultPath: string,
): Promise<boolean> {
  return (await aclViewer(env, session)).canRead(vaultPath)
}

/** Write access: read access to every path a change touches (its file and a rename's old one). */
export async function canWrite(
  env: Env,
  session: Session,
  paths: (string | null | undefined)[],
): Promise<boolean> {
  const viewer = await aclViewer(env, session)
  return paths.every((path) => !path || viewer.canRead(path))
}

/**
 * Refuse a path the member may not read, as if it weren't there (no answer says a restricted page
 * exists), and audit it. `record` is the request's auditor.
 */
export async function requireRead(
  env: Env,
  session: Session,
  paths: (string | null | undefined)[],
  record?: Auditor,
  message = "not found",
): Promise<void> {
  const viewer = await aclViewer(env, session)
  const refused = paths.find((path): path is string => Boolean(path) && !viewer.canRead(path!))
  if (refused === undefined) return
  if (record) deny(record, session.login, refused)
  throw new HttpError(404, message)
}

// Denials are audited (acl.deny) once per member and path every DENY_EVERY_MS, and at most
// DENY_PER_MINUTE a minute per isolate: a page full of scrubbed links or a crawl doesn't flood D1.
const DENY_EVERY_MS = 10 * 60_000
const DENY_PER_MINUTE = 30
const denied = new Map<string, number>()
let denyWindow = { start: 0, count: 0 }

/** Audit a refusal (acl.deny), sparingly. Returns whether a row was written. */
export function deny(record: Auditor, login: string, target: string, now = Date.now()): boolean {
  const key = `${login}\n${target}`
  const last = denied.get(key)
  if (last !== undefined && now - last < DENY_EVERY_MS) return false
  if (now - denyWindow.start >= 60_000) denyWindow = { start: now, count: 0 }
  if (denyWindow.count >= DENY_PER_MINUTE) return false
  denyWindow.count++
  if (denied.size > 5000) denied.clear()
  denied.set(key, now)
  record("acl.deny", target)
  return true
}

// ---- site paths ----

/** The build's map from site paths to the vault paths they show (static/acl-refs.json). */
export interface AclRefs {
  version?: number
  /** Page site paths (no leading slash, no .html) → vault path. */
  pages: Record<string, string>
  /** Alias and redirect stubs' site paths → the page's vault path. */
  aliases: Record<string, string>
  /** Paths under notebook-assets/ → the pages (vault paths) that use them. */
  notebookAssets: Record<string, string[]>
  /** "pdf/<slug>.pdf" → the page's vault path. */
  pdfs: Record<string, string>
}

const EMPTY_REFS: AclRefs = { pages: {}, aliases: {}, notebookAssets: {}, pdfs: {} }
let refsMemo = new WeakMap<object, Promise<AclRefs>>()

/** The build's acl-refs.json, once per isolate (it changes only with a deploy); none: empty. */
export function aclRefs(env: Pick<Env, "ASSETS">): Promise<AclRefs> {
  let refs = refsMemo.get(env.ASSETS)
  if (!refs) {
    refs = env.ASSETS.fetch(new Request("https://assets.local/static/acl-refs.json"))
      .then(async (response) => {
        if (!response.ok) return EMPTY_REFS
        const raw = (await response.json()) as Partial<AclRefs>
        return {
          version: raw.version,
          pages: raw.pages ?? {},
          aliases: raw.aliases ?? {},
          notebookAssets: raw.notebookAssets ?? {},
          pdfs: raw.pdfs ?? {},
        }
      })
      .catch(() => EMPTY_REFS)
    refsMemo.set(env.ASSETS, refs)
  }
  return refs
}

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

/**
 * The vault paths a site path shows: `all` must each be readable (a page, its Markdown source,
 * history, social image, PDF or alias; anything under resources/, by its own path too, so a
 * folder's rule covers its images and folder pages), `any` one of them (a notebook asset, shared
 * by the pages that use it). Neither: nothing restricted.
 */
export function siteTargets(refs: AclRefs, sitePath: string): { all: string[]; any: string[] } {
  const path = sitePath.replace(/^\/+/, "").replace(/[?#].*$/, "")
  if (path.startsWith("notebook-assets/"))
    return { all: [], any: own(refs.notebookAssets, path.slice("notebook-assets/".length)) ?? [] }
  const all = new Set<string>()
  const pdf = path.startsWith("pdf/") ? own(refs.pdfs, path) : undefined
  if (pdf) all.add(pdf)
  const bare = path.replace(/\.html$/, "")
  const page = bare
    .replace(/(?:\.history\.json|-og-image\.webp|\.md)$/, "")
    .replace(/(^|\/)$/, "$1index")
  for (const key of new Set([bare, page, page.replace(/(^|\/)index$/, "")])) {
    const vault = own(refs.pages, key) ?? own(refs.aliases, key)
    if (vault) all.add(vault)
  }
  if (path.startsWith("resources/")) {
    for (const guess of new Set([bare, page])) {
      const vault = guess.slice("resources/".length)
      if (!vault) continue
      all.add(vault)
      // A folder's page: its rule is the folder's ("dir/").
      if (!/\.[a-z0-9]+$/i.test(vault.split("/").pop()!))
        all.add(vault.replace(/\/index$/, "").replace(/\/?$/, "/"))
    }
  }
  return { all: [...all], any: [] }
}

/** Whether a reader may see a site path. */
export function canSee(viewer: AclViewer, refs: AclRefs, sitePath: string): boolean {
  if (viewer.open) return true
  const { all, any } = siteTargets(refs, sitePath)
  return all.every(viewer.canRead) && (!any.length || any.some(viewer.canRead))
}

export async function canReadSitePath(
  env: Env,
  session: Session,
  sitePath: string,
): Promise<boolean> {
  const viewer = await aclViewer(env, session)
  if (viewer.open) return true
  return canSee(viewer, await aclRefs(env), sitePath)
}

/** What a link to a restricted page becomes for a member who can't read it. */
export const HIDDEN_LINK = '<span class="acl-hidden">restricted page</span>'

/**
 * A page as a member may see it: each link to a page they can't read is a plain "restricted page",
 * and each element the build marked as showing a restricted page (data-acl="<rule>": folder rows,
 * transclusions, list items) whose rule they can't read is gone. HTMLRewriter streams it.
 */
export function scrubLinks(
  page: Response,
  viewer: AclViewer,
  refs: AclRefs,
  sitePath: string,
  siteUrl: string,
): Response {
  const base = new URL(sitePath, "https://members.invalid")
  const site = new URL(siteUrl).origin
  return new HTMLRewriter()
    .on("a[href]", {
      element(link) {
        let target: URL
        try {
          target = new URL(link.getAttribute("href")!, base)
        } catch {
          return
        }
        if (target.origin !== base.origin && target.origin !== site) return
        let path: string
        try {
          path = decodeURIComponent(target.pathname)
        } catch {
          return
        }
        if (!canSee(viewer, refs, path)) link.replace(HIDDEN_LINK, { html: true })
      },
    })
    .on("[data-acl]", {
      element(block) {
        if (!viewer.canReadRule(block.getAttribute("data-acl") ?? "")) block.remove()
      },
    })
    .transform(page)
}
