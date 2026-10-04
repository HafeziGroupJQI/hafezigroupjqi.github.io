import { SELF, env } from "cloudflare:test"
import { expect, vi } from "vitest"
import { resetAcl } from "../src/acl/index"
import { SESSION_MAX_AGE, sign } from "../src/session"

export const ORIGIN = "https://members.test"

type Init = RequestInit & { headers?: Record<string, string> }

/** The github.io site in tests (PUBLIC_SITE_URL in test/wrangler.jsonc): the browser origin. */
export const SITE = "https://public.example"

/** Sign in through the dev-mode start/exchange flow and return a bearer-token client. */
export async function signIn() {
  const post = (path: string, body: unknown) =>
    SELF.fetch(ORIGIN + path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: SITE },
      body: JSON.stringify(body),
    })
  const started = (await (await post("/api/auth/start", { next: "/" })).json()) as {
    state: string
    nonce: string
  }
  const exchanged = await post("/api/auth/exchange", started)
  expect(exchanged.status).toBe(200)
  return ((await exchanged.json()) as { token: string }).token
}

export async function member() {
  return client(await signIn())
}

/** A client signed in as `login` just now (a bearer minted with the test SESSION_SECRET, no GitHub). */
export async function as(login: string, role: "member" | "owner" = "member") {
  const session = {
    typ: "session",
    login,
    name: login,
    role,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  }
  return client(await sign(session, (env as any).SESSION_SECRET))
}

/** Audit rows are written in waitUntil; wait until the expected rows land. */
export async function auditRows(where: string, ...binds: unknown[]) {
  const query = () =>
    env.DB.prepare(
      `SELECT action, login, target, status, detail_json FROM audit_log WHERE ${where} ORDER BY id`,
    )
      .bind(...binds)
      .all()
      .then((r) => r.results as any[])
  let rows = await query()
  await vi.waitFor(async () => {
    rows = await query()
    if (!rows.length) throw new Error("no audit rows yet")
  })
  return rows
}

function client(token: string) {
  const headers = {
    authorization: `Bearer ${token}`,
    origin: SITE,
    "content-type": "application/json",
  }
  const fetch = (path: string, init: Init = {}) =>
    SELF.fetch(ORIGIN + path, {
      redirect: "manual",
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    })
  const json = async (path: string, init: Init = {}) => {
    const response = await fetch(path, init)
    return { status: response.status, body: (await response.json()) as any }
  }
  return { token, headers, fetch, json }
}

export type Client = Awaited<ReturnType<typeof member>>

export async function occurrences(
  client: Client,
  start = "2026-09-01T00:00:00-04:00",
  end = "2026-10-01T00:00:00-04:00",
) {
  const response = await client.fetch(`/api/calendar/events?${new URLSearchParams({ start, end })}`)
  expect(response.status).toBe(200)
  return (await response.json()) as any[]
}

export interface AclSeed {
  groups?: Record<string, { logins?: string[]; people?: string[] }>
  rules?: { id: string; pattern: string; allow?: string[]; deny?: string[]; note?: string }[]
}

/** The optical RL group and rule, as migration 0018 seeds them. */
export const OPTICAL_ACL: AclSeed = {
  groups: {
    "optical-rl": {
      logins: ["anishgoyal1108", "lidaxu-physics", "mjalalim3"],
      people: [
        "people/mohammad-hafezi",
        "people/lida-xu",
        "people/anish-goyal",
        "people/mahmoud-jalali-mehrabad",
        "people/pavel-dolgirev",
        "people/shi-yuan-ma",
      ],
    },
  },
  rules: [{ id: "r1", pattern: "projects/optical-rl/", allow: ["group:optical-rl"] }],
}

/** Replace the access rules and groups in D1 (a new version), and forget the isolate's copy. */
export async function setAcl(seed: AclSeed = OPTICAL_ACL) {
  const db = env.DB
  await db.batch([
    db.prepare("DELETE FROM acl_group_members"),
    db.prepare("DELETE FROM acl_groups"),
    db.prepare("DELETE FROM acl_rules"),
    db.prepare("UPDATE acl_meta SET version = version + 1, next_rule = 100 WHERE id = 1"),
  ])
  for (const [name, group] of Object.entries(seed.groups ?? {})) {
    const { meta } = await db
      .prepare("INSERT INTO acl_groups (name, created_at) VALUES (?, 0)")
      .bind(name)
      .run()
    for (const login of group.logins ?? [])
      await db
        .prepare("INSERT INTO acl_group_members (group_id, login) VALUES (?, ?)")
        .bind(meta.last_row_id, login)
        .run()
    for (const person of group.people ?? [])
      await db
        .prepare("INSERT INTO acl_group_members (group_id, person) VALUES (?, ?)")
        .bind(meta.last_row_id, person)
        .run()
  }
  for (const rule of seed.rules ?? [])
    await db
      .prepare(
        "INSERT INTO acl_rules (id, pattern, allow_json, deny_json, note, updated_at) VALUES (?, ?, ?, ?, ?, 0)",
      )
      .bind(
        rule.id,
        rule.pattern,
        JSON.stringify(rule.allow ?? []),
        JSON.stringify(rule.deny ?? []),
        rule.note ?? "",
      )
      .run()
  resetAcl()
}

/** Link a login to an approved People page (content/people/<slug>.md). */
export async function approvedProfile(login: string, slug: string) {
  await env.DB.prepare(
    `INSERT INTO profiles (login, path, status, updated_at) VALUES (?, ?, 'approved', 0)
     ON CONFLICT (login) DO UPDATE SET path = excluded.path, status = 'approved'`,
  )
    .bind(login, `content/people/${slug}.md`)
    .run()
  resetAcl()
}
