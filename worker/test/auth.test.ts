import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { decide, safeNext } from "../src/auth"
import { sign } from "../src/session"
import { ORIGIN, SITE, member, signIn } from "./helpers"
import worker, { githubCalls } from "./worker"

// Call the Worker with a modified env (the test wrangler.jsonc runs AUTH_MODE=dev).
async function call(path: string, init: RequestInit = {}, overrides: Record<string, string> = {}) {
  const ctx = createExecutionContext()
  const response = await (worker as ExportedHandler).fetch!(
    new Request(ORIGIN + path, { redirect: "manual", ...init }) as any,
    { ...env, ...overrides } as any,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return response
}

const postJson = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: SITE, ...headers },
  body: JSON.stringify(body),
})

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

describe("github sign-in (start → GitHub → github.io callback → exchange)", () => {
  const github = { AUTH_MODE: "github" }
  beforeEach(() => githubCalls.splice(0))

  async function start(next = "/resources/notes") {
    const response = await call("/api/auth/start", postJson({ next }), github)
    expect(response.status).toBe(200)
    return (await response.json()) as { authorize_url: string; nonce: string }
  }

  it("sends GitHub back to the github.io callback, never the Worker", async () => {
    const { authorize_url, nonce } = await start()
    const authorize = new URL(authorize_url)
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${SITE}/auth/callback`)
    expect(authorize.searchParams.get("scope")).toBe("read:org")
    expect(nonce.length).toBeGreaterThan(20)
  })

  it("exchanges the code for a bearer token with the org/team role", async () => {
    for (const [code, role] of [
      ["code-owner", "owner"],
      ["code-member", "member"],
    ]) {
      const { authorize_url, nonce } = await start()
      const state = new URL(authorize_url).searchParams.get("state")!
      const response = await call("/api/auth/exchange", postJson({ code, state, nonce }), github)
      expect(response.status, code).toBe(200)
      const body = (await response.json()) as {
        token: string
        user: { role: string }
        next: string
      }
      expect(body.user.role).toBe(role)
      expect(body.next).toBe("/resources/notes")
      const session = await call("/api/session", {
        headers: { authorization: `Bearer ${body.token}`, origin: SITE },
      })
      expect(((await session.json()) as { user: { role: string } }).user.role).toBe(role)
    }
    const exchangeCall = githubCalls.find((c) => c.includes("access_token"))
    expect(exchangeCall).toBeDefined()
  })

  it("refuses outsiders, a wrong nonce, and an unknown code", async () => {
    let { authorize_url, nonce } = await start()
    let state = new URL(authorize_url).searchParams.get("state")!
    const outsider = await call(
      "/api/auth/exchange",
      postJson({ code: "code-outsider", state, nonce }),
      github,
    )
    expect(outsider.status).toBe(403)
    expect(((await outsider.json()) as { detail: string }).detail).toContain("not a member")
    ;({ authorize_url, nonce } = await start())
    state = new URL(authorize_url).searchParams.get("state")!
    const wrongNonce = await call(
      "/api/auth/exchange",
      postJson({ code: "code-member", state, nonce: "x" + nonce.slice(1) }),
      github,
    )
    expect(wrongNonce.status).toBe(400)
    const noToken = await call(
      "/api/auth/exchange",
      postJson({ code: "code-nobody", state, nonce }),
      github,
    )
    expect(noToken.status).toBe(502)
  })
})

describe("bearer sessions", () => {
  it("answers anonymous calls with 401 and an empty session", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/calendar/events`)).status).toBe(401)
    expect((await SELF.fetch(`${ORIGIN}/api/site/resources/notes`)).status).toBe(401)
    expect(await (await SELF.fetch(`${ORIGIN}/api/session`)).json()).toEqual({ user: null })
    expect(await (await SELF.fetch(`${ORIGIN}/api/health`)).json()).toMatchObject({ ok: true })
  })

  it("answers a JSON null body with 422, not a 500", async () => {
    for (const path of ["/api/auth/start", "/api/auth/exchange"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      })
      expect(response.status).toBe(422)
    }
  })

  it("answers a malformed escape in the path with 400, not a 500", async () => {
    const client = await member()
    for (const path of ["/api/gpt/conversations/%E0%A4", "/api/calendar/events/%E0%A4"])
      expect((await client.fetch(path)).status, path).toBe(400)
  })

  it("identifies the signed-in member", async () => {
    const client = await member()
    expect((await client.json("/api/session")).body.user).toEqual({
      login: "dev",
      name: "Local member",
      role: "owner",
      is_admin: true,
    })
  })

  it("rejects tampered tokens and never accepts a login state as a session", async () => {
    const token = await signIn()
    const tampered = token.slice(0, -2) + (token.endsWith("xx") ? "yy" : "xx")
    const bad = await SELF.fetch(`${ORIGIN}/api/calendar/events`, {
      headers: { authorization: `Bearer ${tampered}` },
    })
    expect(bad.status).toBe(401)
    const secret = (env as any).SESSION_SECRET as string
    const exp = Math.floor(Date.now() / 1000) + 600
    const state = await sign({ typ: "state", nonce: "n", next: "/", exp }, secret)
    const asSession = await SELF.fetch(`${ORIGIN}/api/session`, {
      headers: { authorization: `Bearer ${state}` },
    })
    expect(await asSession.json()).toEqual({ user: null })
    // …and a session token is not a login state.
    const replay = await SELF.fetch(
      `${ORIGIN}/api/auth/exchange`,
      postJson({ state: token, nonce: "n" }),
    )
    expect(replay.status).toBe(400)
  })

  it("keeps member tokens away from the device-key agent routes", async () => {
    const token = await signIn()
    const response = await SELF.fetch(`${ORIGIN}/api/agent/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ts_ns: "1", statuses: {} }),
    })
    expect(response.status).toBe(401)
  })
})

describe("CORS for the github.io site", () => {
  it("answers preflights from the site and refuses other origins", async () => {
    const ok = await SELF.fetch(`${ORIGIN}/api/devices`, {
      method: "OPTIONS",
      headers: { origin: SITE, "access-control-request-method": "POST" },
    })
    expect(ok.status).toBe(204)
    expect(ok.headers.get("access-control-allow-origin")).toBe(SITE)
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization")
    const evil = await SELF.fetch(`${ORIGIN}/api/devices`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    })
    expect(evil.status).toBe(403)
    expect(evil.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("labels responses for the site only, and allows extra dev origins by config", async () => {
    const client = await member()
    const response = await client.fetch("/api/session")
    expect(response.headers.get("access-control-allow-origin")).toBe(SITE)
    expect(response.headers.get("vary")).toContain("Origin")
    const foreign = await client.fetch("/api/session", {
      headers: { origin: "https://evil.example" },
    })
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull()
    const dev = await call(
      "/api/health",
      { headers: { origin: "http://localhost:8080" } },
      { ALLOWED_ORIGINS: "http://localhost:8080" },
    )
    expect(dev.headers.get("access-control-allow-origin")).toBe("http://localhost:8080")
  })

  it("rejects writes from a foreign browser origin", async () => {
    const client = await member()
    const response = await client.fetch("/api/devices", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ code_name: "evil-pc" }),
    })
    expect(response.status).toBe(403)
  })
})
