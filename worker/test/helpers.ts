import { SELF } from "cloudflare:test"
import { expect } from "vitest"

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
  const token = await signIn()
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
