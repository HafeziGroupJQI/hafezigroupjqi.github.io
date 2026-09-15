import { SELF } from "cloudflare:test"
import { expect } from "vitest"

export const ORIGIN = "https://members.test"

type Init = RequestInit & { headers?: Record<string, string> }

export async function member() {
  const login = await SELF.fetch(`${ORIGIN}/auth/login`, { redirect: "manual" })
  expect(login.status).toBe(302)
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]
  const session = (await (
    await SELF.fetch(`${ORIGIN}/api/session`, { headers: { cookie } })
  ).json()) as {
    csrf: string
  }
  const headers = {
    cookie,
    origin: ORIGIN,
    "x-csrf-token": session.csrf,
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
  return { cookie, csrf: session.csrf, headers, fetch, json }
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
