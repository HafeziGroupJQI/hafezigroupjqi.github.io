import { SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { ORIGIN, member } from "./helpers"
import { c2Behaviour, c2Calls } from "./worker"

/** The assertion is opaque to the browser but must carry exactly what C2 will check. */
const claims = (assertion: string) => {
  const body = assertion.split(".")[0]
  const padded = body.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (body.length % 4)) % 4)
  return JSON.parse(atob(padded)) as Record<string, string>
}

beforeEach(() => {
  c2Calls.splice(0)
  c2Behaviour.mode = "ok"
})

describe("instrument gateway", () => {
  it("requires a session and never leaks to the instrument service", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/c2/instruments`)).status).toBe(401)
    expect(c2Calls).toEqual([])
  })

  it("forwards a signed identity bound to the path and method", async () => {
    const client = await member()
    const { status, body } = await client.json("/api/c2/instruments")
    expect(status).toBe(200)
    expect(body).toEqual([])
    expect(c2Calls).toHaveLength(1)
    expect(c2Calls[0].url).toBe("https://c2.test/api/instruments")
    expect(claims(c2Calls[0].assertion)).toEqual({
      login: "dev",
      role: "owner",
      aud: "c2",
      path: "/api/instruments",
      method: "GET",
    })
  })

  it("reports connected status by probing the instrument list", async () => {
    const client = await member()
    expect((await client.json("/api/c2/status")).body.state).toBe("connected")
  })

  it("polls an instrument and preserves the query string", async () => {
    const client = await member()
    expect((await client.fetch("/api/c2/instruments/device/poll", { method: "POST" })).status).toBe(200)
    expect(c2Calls.at(-1)).toMatchObject({
      url: "https://c2.test/api/instruments/device/poll",
      method: "POST",
    })
    expect(claims(c2Calls.at(-1)!.assertion).method).toBe("POST")

    await client.fetch("/api/c2/instruments/device/history?metric=voltage_ch1")
    expect(c2Calls.at(-1)!.url).toBe("https://c2.test/api/instruments/device/history?metric=voltage_ch1")
  })

  it("refuses a mutation without a matching CSRF token", async () => {
    const client = await member()
    const response = await client.fetch("/api/c2/instruments/device/poll", {
      method: "POST",
      headers: { "x-csrf-token": "wrong" },
    })
    expect(response.status).toBe(403)
    expect(c2Calls).toEqual([])
  })

  it("only exposes allowlisted instrument routes", async () => {
    const client = await member()
    // not readable, and a write target must never be reachable by GET
    expect((await client.fetch("/api/c2/shutdown")).status).toBe(404)
    expect((await client.fetch("/api/c2/instruments/device/poll")).status).toBe(404)
    expect((await client.fetch("/api/c2/instruments", { method: "DELETE" })).status).toBe(405)
    expect(c2Calls).toEqual([])
  })

  it("degrades instead of failing when the instrument PC is off", async () => {
    const client = await member()
    c2Behaviour.mode = "outage"
    expect((await client.json("/api/c2/status")).body.state).toBe("unavailable")
    expect((await client.fetch("/api/c2/instruments")).status).toBe(503)
  })

  it("does not pass an upstream rejection off as its own answer", async () => {
    const client = await member()
    c2Behaviour.mode = "reject"
    expect((await client.fetch("/api/c2/instruments")).status).toBe(502)
    c2Behaviour.mode = "garbage"
    expect((await client.fetch("/api/c2/instruments")).status).toBe(502)
  })

  it("serves the run index for reviewing past experiments", async () => {
    const client = await member()
    const { status, body } = await client.json("/api/c2/runs")
    expect(status).toBe(200)
    expect(body[0].run_id).toBe("20260915T120000-abc123")
    expect((await client.json("/api/c2/runs/20260915T120000-abc123")).status).toBe(200)
  })
})
