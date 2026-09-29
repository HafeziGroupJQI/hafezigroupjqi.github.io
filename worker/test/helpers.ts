import { SELF, env } from "cloudflare:test"
import { expect, vi } from "vitest"
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
