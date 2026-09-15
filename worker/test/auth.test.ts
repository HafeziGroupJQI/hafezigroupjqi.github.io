import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { decide, safeNext } from "../src/auth"
import { ORIGIN, member } from "./helpers"

describe("authorization rules", () => {
  it("admits org owners and active team members only", () => {
    expect(decide({ state: "active", role: "admin" }, null)).toEqual([true, "owner"])
    expect(decide(null, { state: "active" })).toEqual([true, "member"])
    expect(decide({ state: "active", role: "member" }, { state: "pending" })[0]).toBe(false)
    expect(decide(null, null)[0]).toBe(false)
  })

  it("keeps the post-login target on this site", () => {
    expect(safeNext("/journal-club/?page=2")).toBe("/journal-club/?page=2")
    const backslash = "/" + String.fromCharCode(92) + "attacker.example"
    for (const unsafe of ["https://attacker.example", "//attacker.example", backslash, ""])
      expect(safeNext(unsafe)).toBe("/")
  })
})

describe("request gate", () => {
  it("sends anonymous page requests to the login and refuses everything else", async () => {
    for (const path of ["/resources/notes", "/calendar", "/instruments", "/resources/"]) {
      const response = await SELF.fetch(ORIGIN + path, { redirect: "manual" })
      expect(response.status, path).toBe(302)
      expect(response.headers.get("location")).toBe(`/auth/login?next=${encodeURIComponent(path)}`)
    }
    expect((await SELF.fetch(`${ORIGIN}/resources/assets/figure.svg`)).status).toBe(401)
    expect((await SELF.fetch(`${ORIGIN}/static/contentIndex.json`)).status).toBe(401)
    expect((await SELF.fetch(`${ORIGIN}/api/calendar/events`)).status).toBe(401)
    expect(await (await SELF.fetch(`${ORIGIN}/api/session`)).json()).toEqual({
      user: null,
      csrf: null,
    })
    expect(await (await SELF.fetch(`${ORIGIN}/api/health`)).json()).toMatchObject({ ok: true })
  })

  it("serves member pages with private headers and returns to the public site on logout", async () => {
    const client = await member()
    expect((await client.json("/api/session")).body.user).toEqual({
      login: "dev",
      name: "Local member",
      role: "owner",
    })
    const pages = ["/", "/resources/notes", "/resources/assets/figure.svg", "/instruments"]
    for (const path of pages) {
      const response = await client.fetch(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get("vary")).toContain("Cookie")
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive")
      expect(response.headers.get("cache-control")).toBe("private, no-store")
    }
    expect((await client.fetch("/resources/notes.html")).headers.get("location")).toBe(
      "/resources/notes",
    )
    expect(await (await client.fetch("/static/contentIndex.json")).json()).toBe("secret")
    expect((await client.fetch("/vault")).headers.get("location")).toBe("/resources/")
    expect((await client.fetch("/nowhere")).status).toBe(404)
    const logout = await client.fetch("/auth/logout")
    expect(logout.status).toBe(302)
    expect(logout.headers.get("location")).toBe("https://public.example")
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0")
  })

  it("rejects tampered sessions and unsafe next targets", async () => {
    const client = await member()
    const tampered = client.cookie.slice(0, -2) + "xx"
    const response = await SELF.fetch(`${ORIGIN}/api/calendar/events`, {
      headers: { cookie: tampered },
    })
    expect(response.status).toBe(401)
    const login = await SELF.fetch(`${ORIGIN}/auth/login?next=//evil.example`, {
      redirect: "manual",
    })
    expect(login.headers.get("location")).toBe("/")
    const returning = await SELF.fetch(`${ORIGIN}/auth/login?next=%2Fresources%2Fnotes`, {
      redirect: "manual",
    })
    expect(returning.headers.get("location")).toBe("/resources/notes")
  })
})
