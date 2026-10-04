import { type Auditor, isAdmin } from "../audit"
import { requireMutation } from "../auth"
import type { Env } from "../env"
import { HttpError, decodeSegment, json, readJson } from "../http"
import { type Session, issueProbe } from "../session"
import {
  type AclRefs,
  aclPolicy,
  aclRefs,
  personOf,
  readSnapshot,
  siteTargets,
  useSnapshot,
} from "./index"
import { type AclPolicy, validPattern, validPrincipal } from "./policy"

// /api/admin/acl/*: the access rules' groups, members and rules (admins only; admin/routes.ts
// checks). Every change bumps acl_meta.version, is audited (admin.acl.*) and applies in this
// isolate at once and in others within seconds (index.ts). The members site's build reads the
// rules from D1 itself, and the compute host polls their version (GET /api/compute/acl) to start
// a rebuild: nothing goes into vault-private, where every member may push.

const GROUP = /^[a-z0-9][a-z0-9-]{0,63}$/
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/
const PERSON = /^people\/(?:alumni\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/
const NOTE_MAX = 500
const PRINCIPALS_MAX = 100

/** The version the deployed site was built with (static/acl-build.json), or null. */
export async function buildVersion(env: Pick<Env, "ASSETS">): Promise<number | null> {
  try {
    const response = await env.ASSETS.fetch(
      new Request("https://assets.local/static/acl-build.json"),
    )
    if (!response.ok) return null
    const version = ((await response.json()) as { version?: unknown }).version
    return typeof version === "number" ? version : null
  } catch {
    return null
  }
}

function principals(value: unknown, field: string, groups: Set<string>): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
    throw new HttpError(422, `${field} must be a list of principals`)
  const out = [...new Set((value as string[]).map((x) => x.trim()))].map((x) =>
    x.startsWith("login:") ? x.toLowerCase() : x,
  )
  if (out.length > PRINCIPALS_MAX) throw new HttpError(422, `at most ${PRINCIPALS_MAX} in ${field}`)
  for (const ref of out) {
    if (!validPrincipal(ref))
      throw new HttpError(
        422,
        `${ref} isn't a principal: group:<name>, login:<github login> or person:people/<slug>`,
      )
    if (ref.startsWith("group:") && !groups.has(ref.slice(6)))
      throw new HttpError(422, `there is no group ${ref.slice(6)}`)
  }
  return out
}

function note(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") throw new HttpError(422, "the note must be text")
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length > NOTE_MAX) throw new HttpError(422, `the note is longer than ${NOTE_MAX}`)
  return text
}

function pattern(value: unknown): string {
  const text = typeof value === "string" ? value.trim().replace(/^\/+/, "") : ""
  if (!validPattern(text))
    throw new HttpError(
      422,
      "the pattern is a path in the private vault: a file (notes/x.md), a folder (projects/x/) or a glob (notes/**/draft-*.md)",
    )
  return text
}

/** A member of a group, as a request names one: a login, or a People page. */
function member(body: Record<string, unknown>): { login: string } | { person: string } {
  if (typeof body.login === "string" && body.login.trim()) {
    const login = body.login.trim().replace(/^@/, "").toLowerCase()
    if (!LOGIN.test(login)) throw new HttpError(422, "enter a GitHub login")
    return { login }
  }
  if (typeof body.person === "string" && body.person.trim()) {
    const person = body.person
      .trim()
      .replace(/^\/+/, "")
      .replace(/\.md$/, "")
      .replace(/^content\//, "")
    if (!PERSON.test(person)) throw new HttpError(422, "a People page is people/<slug>")
    return { person }
  }
  throw new HttpError(422, "name a GitHub login or a People page")
}

const bump = (env: Env) =>
  env.DB.prepare("UPDATE acl_meta SET version = version + 1, updated_at = ? WHERE id = 1").bind(
    Date.now(),
  )

/** Why a reader may or may not read a path, in a sentence for the checker. */
export function explain(
  policy: AclPolicy,
  reader: { login: string; person: string | null; admin: boolean },
  path: string,
): { readable: boolean; rule: string | null; reason: string } {
  const decision = policy.decide(reader, path)
  const rule = decision.rule ? policy.byId.get(decision.rule)! : null
  const who = `${reader.login}${reader.person ? ` (${reader.person})` : ""}`
  if (reader.admin)
    return { ...decision, reason: `${reader.login} is an admin: admins read every page` }
  if (!rule) return { ...decision, reason: "no rule covers this path, so every member may read it" }
  const principals = policy.principals(reader)
  const denied = rule.deny.filter((ref) => principals.has(ref))
  const allowed = rule.allow.filter((ref) => principals.has(ref))
  const head = `rule ${rule.id} (${rule.pattern}) decides this path`
  const reason = denied.length
    ? `${head}, and its deny list names ${who} as ${denied.join(", ")}`
    : !rule.allow.length
      ? `${head}; it allows everyone not on its deny list`
      : allowed.length
        ? `${head}, and its allow list names ${who} as ${allowed.join(", ")}`
        : `${head}, and ${who} is on none of its allow list (${rule.allow.join(", ")})`
  return { ...decision, reason }
}

export async function aclAdminRoutes(
  request: Request,
  path: string,
  url: URL,
  env: Env,
  session: Session,
  record: Auditor,
): Promise<Response | null> {
  if (path !== "/acl" && !path.startsWith("/acl/")) return null
  const method = request.method
  const write = () => requireMutation(request, env)

  /** Apply a change with the version bump, and use it here at once. */
  const change = async (
    statements: D1PreparedStatement[],
    action: string,
    target: string,
    detail: Record<string, unknown> = {},
  ) => {
    await env.DB.batch([...statements, bump(env)])
    const snapshot = await readSnapshot(env)
    useSnapshot(env, snapshot)
    record(`admin.acl.${action}`, target, { ...detail, version: snapshot.version })
    return { version: snapshot.version }
  }

  const groupId = async (name: string) => {
    const row = await env.DB.prepare("SELECT id FROM acl_groups WHERE name = ?")
      .bind(name)
      .first<{ id: number }>()
    if (!row) throw new HttpError(404, `there is no group ${name}`)
    return row.id
  }
  const groupNames = async () =>
    new Set(
      (await env.DB.prepare("SELECT name FROM acl_groups").all<{ name: string }>()).results.map(
        (row) => row.name,
      ),
    )

  if (path === "/acl" && method === "GET") {
    const snapshot = await readSnapshot(env)
    const [meta, groups, rules] = await env.DB.batch<any>([
      env.DB.prepare("SELECT version, updated_at FROM acl_meta WHERE id = 1"),
      env.DB.prepare("SELECT name, description, created_by, created_at FROM acl_groups"),
      env.DB.prepare("SELECT id, created_by, updated_at FROM acl_rules"),
    ])
    const groupRows = new Map(groups.results.map((row: any) => [row.name, row]))
    const ruleRows = new Map(rules.results.map((row: any) => [row.id, row]))
    return json({
      ...meta.results[0],
      build_version: await buildVersion(env),
      groups: Object.entries(snapshot.groups).map(([name, group]) => ({
        name,
        description: (groupRows.get(name) as any)?.description ?? "",
        ...group,
      })),
      rules: snapshot.rules.map((rule) => ({ ...rule, ...(ruleRows.get(rule.id) as object) })),
    })
  }

  // Who may read a path, and which rule says so: ?login=<login>&path=<vault path or site path>.
  if (path === "/acl/check" && method === "GET") {
    const login = (url.searchParams.get("login") ?? "").trim().replace(/^@/, "").toLowerCase()
    if (!LOGIN.test(login)) throw new HttpError(422, "enter a GitHub login")
    const asked = (url.searchParams.get("path") ?? "").trim()
    if (!asked) throw new HttpError(422, "enter a path")
    const policy = await aclPolicy(env)
    const person = await personOf(env, login)
    // An org owner is an admin by their sign-in's role, which only their own session carries.
    const admin = await isAdmin(env, login === session.login ? session : { login, role: "member" })
    const reader = { login, person, admin }
    // A site path (/resources/…, /pdf/…) is every vault path it shows; else it is a vault path.
    let paths = [asked.replace(/^\/+/, "")]
    if (asked.startsWith("/")) {
      const refs: AclRefs = await aclRefs(env)
      const targets = siteTargets(refs, asked)
      paths = [...targets.all, ...targets.any]
    }
    const answers = paths.map((p) => ({ path: p, ...explain(policy, reader, p) }))
    const decisive = answers.find((a) => !a.readable) ?? answers[0]
    return json({
      login,
      person,
      admin,
      path: asked,
      readable: decisive ? decisive.readable : true,
      rule: decisive?.rule ?? null,
      reason: decisive?.reason ?? "nothing restricted is at this path",
      paths: answers,
      version: policy.version,
    })
  }

  // A probe session: a bearer for a new synthetic member (probe-<8 hex>) for 30 minutes, never an
  // admin and refused every change (src/app.ts), for seeing the site as someone outside a group
  // would, and, added to a group, as someone in it. Its token is shown this once.
  if (path === "/acl/probe" && method === "POST") {
    write()
    const probe = await issueProbe(env)
    record("admin.acl.probe", probe.login, { exp: probe.exp })
    return json(probe, 201)
  }

  if (path === "/acl/groups" && method === "POST") {
    write()
    const body = (await readJson(request)) as Record<string, unknown>
    const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : ""
    if (!GROUP.test(name))
      throw new HttpError(422, "a group's name is lowercase letters, digits and dashes")
    const description = note(body.description)
    if ((await groupNames()).has(name)) throw new HttpError(409, `there is a group ${name} already`)
    const result = await change(
      [
        env.DB.prepare(
          "INSERT INTO acl_groups (name, description, created_by, created_at) VALUES (?, ?, ?, ?)",
        ).bind(name, description, session.login, Date.now()),
      ],
      "group.create",
      name,
    )
    return json({ name, description, logins: [], people: [], ...result }, 201)
  }

  const group = path.match(/^\/acl\/groups\/([^/]+)(\/members)?$/)
  if (group) {
    write()
    const name = decodeSegment(group[1])
    const id = await groupId(name)
    if (!group[2] && method === "PATCH") {
      const body = (await readJson(request)) as Record<string, unknown>
      const description = note(body.description)
      return json({
        name,
        description,
        ...(await change(
          [
            env.DB.prepare("UPDATE acl_groups SET description = ? WHERE id = ?").bind(
              description,
              id,
            ),
          ],
          "group.update",
          name,
        )),
      })
    }
    if (!group[2] && method === "DELETE") {
      const used = (await readSnapshot(env)).rules.filter((rule) =>
        [...rule.allow, ...rule.deny].includes(`group:${name}`),
      )
      if (used.length)
        throw new HttpError(
          409,
          `rules ${used.map((rule) => rule.id).join(", ")} name this group: change them first`,
        )
      return json({
        deleted: name,
        ...(await change(
          [env.DB.prepare("DELETE FROM acl_groups WHERE id = ?").bind(id)],
          "group.delete",
          name,
        )),
      })
    }
    if (group[2] && method === "POST") {
      const who = member((await readJson(request)) as Record<string, unknown>)
      const result = await change(
        [
          env.DB.prepare(
            `INSERT OR IGNORE INTO acl_group_members (group_id, login, person, added_by, added_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).bind(
            id,
            "login" in who ? who.login : null,
            "person" in who ? who.person : null,
            session.login,
            Date.now(),
          ),
        ],
        "member.add",
        name,
        who,
      )
      return json({ group: name, ...who, ...result }, 201)
    }
    if (group[2] && method === "DELETE") {
      const who = member({
        login: url.searchParams.get("login"),
        person: url.searchParams.get("person"),
      })
      const { results } = await env.DB.prepare(
        "SELECT 1 FROM acl_group_members WHERE group_id = ? AND (login = ? OR person = ?)",
      )
        .bind(id, "login" in who ? who.login : null, "person" in who ? who.person : null)
        .all()
      if (!results.length) throw new HttpError(404, "not a member of this group")
      const result = await change(
        [
          env.DB.prepare(
            "DELETE FROM acl_group_members WHERE group_id = ? AND (login = ? OR person = ?)",
          ).bind(id, "login" in who ? who.login : null, "person" in who ? who.person : null),
        ],
        "member.remove",
        name,
        who,
      )
      return json({ group: name, removed: who, ...result })
    }
    throw new HttpError(405, "method not allowed")
  }

  if (path === "/acl/rules" && method === "POST") {
    write()
    const body = (await readJson(request)) as Record<string, unknown>
    const groups = await groupNames()
    const fields = {
      pattern: pattern(body.pattern),
      allow: principals(body.allow, "allow", groups),
      deny: principals(body.deny, "deny", groups),
      note: note(body.note),
    }
    const meta = await env.DB.prepare("SELECT next_rule FROM acl_meta WHERE id = 1").first<{
      next_rule: number
    }>()
    const id = `r${meta?.next_rule ?? 1}`
    const result = await change(
      [
        env.DB.prepare(
          `INSERT INTO acl_rules (id, pattern, allow_json, deny_json, note, created_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          fields.pattern,
          JSON.stringify(fields.allow),
          JSON.stringify(fields.deny),
          fields.note,
          session.login,
          Date.now(),
        ),
        env.DB.prepare("UPDATE acl_meta SET next_rule = next_rule + 1 WHERE id = 1"),
      ],
      "rule.create",
      id,
      fields,
    )
    return json({ id, ...fields, ...result }, 201)
  }

  const rule = path.match(/^\/acl\/rules\/(r\d+)$/)
  if (rule) {
    write()
    const id = rule[1]
    const exists = await env.DB.prepare("SELECT 1 FROM acl_rules WHERE id = ?").bind(id).first()
    if (!exists) throw new HttpError(404, `there is no rule ${id}`)
    if (method === "PUT") {
      const body = (await readJson(request)) as Record<string, unknown>
      const groups = await groupNames()
      const fields = {
        pattern: pattern(body.pattern),
        allow: principals(body.allow, "allow", groups),
        deny: principals(body.deny, "deny", groups),
        note: note(body.note),
      }
      const result = await change(
        [
          env.DB.prepare(
            `UPDATE acl_rules SET pattern = ?, allow_json = ?, deny_json = ?, note = ?,
               updated_at = ? WHERE id = ?`,
          ).bind(
            fields.pattern,
            JSON.stringify(fields.allow),
            JSON.stringify(fields.deny),
            fields.note,
            Date.now(),
            id,
          ),
        ],
        "rule.update",
        id,
        fields,
      )
      return json({ id, ...fields, ...result })
    }
    if (method === "DELETE")
      return json({
        deleted: id,
        ...(await change(
          [env.DB.prepare("DELETE FROM acl_rules WHERE id = ?").bind(id)],
          "rule.delete",
          id,
        )),
      })
    throw new HttpError(405, "method not allowed")
  }

  throw new HttpError(404, "not found")
}

/** GET /api/acl/build-status: the rules' version in D1 and the one the deployed site was built with. */
export async function buildStatus(env: Env): Promise<Response> {
  const meta = await env.DB.prepare("SELECT version FROM acl_meta WHERE id = 1").first<{
    version: number
  }>()
  const build = await buildVersion(env)
  return json({
    d1Version: meta?.version ?? 0,
    buildVersion: build,
    pending: build === null || build < (meta?.version ?? 0),
  })
}
