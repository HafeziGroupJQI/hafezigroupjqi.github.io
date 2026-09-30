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
      // Another first character: "x" + nonce.slice(1) was the same nonce whenever it began with x.
      postJson({
        code: "code-member",
        state,
        nonce: (nonce[0] === "x" ? "y" : "x") + nonce.slice(1),
      }),
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

describe("one lowercase login for a member everywhere", () => {
  const github = { AUTH_MODE: "github" }
  const labCall = (ticket: string, path: string, init: RequestInit = {}, env = {}) =>
    call(
      `/lab/${ticket}/hafezi-gpt${path}`,
      {
        ...init,
        headers: { "content-type": "application/json", origin: ORIGIN, ...init.headers },
      },
      env,
    )

  it("signs in a mixed-case GitHub login as lowercase, for the site and the lab alike", async () => {
    const started = (await (
      await call("/api/auth/start", postJson({ next: "/" }), github)
    ).json()) as { authorize_url: string; nonce: string }
    const state = new URL(started.authorize_url).searchParams.get("state")!
    const exchanged = await call(
      "/api/auth/exchange",
      postJson({ code: "code-Mixed-Case", state, nonce: started.nonce }),
      github,
    )
    const { token, user } = (await exchanged.json()) as any
    // GitHub's casing stays only as the name shown until the member picks one.
    expect(user).toMatchObject({ login: "mixed-case", name: "Mixed-Case" })
    const site = (path: string, init: RequestInit = {}, env = {}) =>
      call(
        path,
        {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            origin: SITE,
            "content-type": "application/json",
          },
        },
        env,
      )
    const chat = (await (
      await site("/api/gpt/conversations", { method: "POST", body: "{}" })
    ).json()) as any
    expect(chat.owner).toBe("mixed-case")

    // The lab, opened from the Scratchpad with this session, is the same member: a chat it saves
    // is one of the site's conversations.
    const status = (await (await site("/api/compute/status")).json()) as any
    const ticket = new URL(status.lab).pathname.split("/")[2]
    const labChat = {
      messages: [{ type: "msg", id: "0", body: "hi", sender: "user", time: 1 }],
      users: { user: { username: "user", display_name: "User" } },
      metadata: {},
    }
    const saved = await labCall(ticket, "/api/gpt/lab-chats/Hafezi%20GPT", {
      method: "PUT",
      body: JSON.stringify(labChat),
    })
    expect(saved.status).toBe(200)
    const { conversation_id } = (await saved.json()) as any
    const listed = (await (await site("/api/gpt/conversations")).json()) as any[]
    expect(listed.map((c) => c.id)).toContain(conversation_id)
    expect(listed.map((c) => c.id)).toContain(chat.id)
    // So does a bearer from before this rule, which still carries GitHub's casing.
    const old = await sign(
      {
        typ: "session",
        login: "Mixed-Case",
        name: "Mixed-Case",
        role: "member",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      (env as any).SESSION_SECRET,
    )
    const before = await call("/api/gpt/conversations", {
      headers: { authorization: `Bearer ${old}`, origin: SITE },
    })
    expect(((await before.json()) as any[]).map((c) => c.id)).toContain(chat.id)

    // The lab's coding agent counts against the same monthly budget the site shows and admins set.
    const ask = {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    }
    const keyed = { ANTHROPIC_API_KEY: "test-key" }
    expect((await labCall(ticket, "/anthropic/v1/messages", ask, keyed)).status).toBe(200)
    const boot = (await (await site("/api/gpt/bootstrap")).json()) as any
    expect(boot.usage.used).toBe(13)
    const admin = await sign(
      { typ: "session", login: "olivia", name: "O", role: "owner", exp: Date.now() / 1000 + 60 },
      (env as any).SESSION_SECRET,
    )
    const budget = await call("/api/admin/budgets/Mixed-Case", {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}`, origin: SITE },
      body: JSON.stringify({ monthly_tokens: 5 }),
    })
    expect(budget.status).toBe(200)
    expect((await labCall(ticket, "/anthropic/v1/messages", ask, keyed)).status).toBe(402)
  })

  it("lowercases the logins already stored, merging usage and skipping taken names", async () => {
    const run = (sql: string, ...binds: unknown[]) =>
      env.DB.prepare(sql)
        .bind(...binds)
        .run()
    await run(
      `INSERT INTO gpt_conversations (id, owner, title, model, lab_name, created_at, updated_at)
       VALUES ('c_mig1', 'Zed-Mig', 't', 'm', 'Chat', 0, 0), ('c_mig2', 'zed-mig', 't', 'm', 'Chat', 0, 0),
              ('c_mig3', 'Zed-Mig', 't', 'm', NULL, 0, 0)`,
    )
    await run(
      `INSERT INTO gpt_usage (login, month, input, output, cost_usd)
       VALUES ('Zed-Mig', '2026-09', 5, 1, 0.5), ('zed-mig', '2026-09', 2, 2, 0.25)`,
    )
    await run(
      `INSERT INTO gpt_shares (conversation_id, grantee, shared_by, shared_at)
       VALUES ('c_mig2', 'Yan-Mig', 'Zed-Mig', 0), ('c_mig2', 'yan-mig', 'zed-mig', 0)`,
    )
    await run("INSERT INTO admins (login, added_by, added_at) VALUES ('Xia-Mig', 'Olivia', 0)")
    await run(
      "INSERT INTO profiles (login, path, updated_at) VALUES ('Wu-Mig', 'content/people/wu.md', 0)",
    )
    const migration = (env as any).TEST_MIGRATIONS.find((m: any) => m.name.startsWith("0008_")) as {
      queries: string[]
    }
    await env.DB.batch(migration.queries.map((q) => env.DB.prepare(q)))

    const all = async (sql: string) => (await env.DB.prepare(sql).all()).results
    expect(
      await all("SELECT id, owner FROM gpt_conversations WHERE id LIKE 'c_mig%' ORDER BY id"),
    ).toEqual([
      { id: "c_mig1", owner: "Zed-Mig" },
      { id: "c_mig2", owner: "zed-mig" },
      { id: "c_mig3", owner: "zed-mig" },
    ])
    expect(
      await all("SELECT login, input, output, cost_usd FROM gpt_usage WHERE login LIKE 'zed-mig'"),
    ).toEqual([{ login: "zed-mig", input: 7, output: 3, cost_usd: 0.75 }])
    expect(
      await all("SELECT grantee, shared_by FROM gpt_shares WHERE conversation_id = 'c_mig2'"),
    ).toEqual([{ grantee: "yan-mig", shared_by: "zed-mig" }])
    expect(await all("SELECT login, added_by FROM admins WHERE login LIKE 'xia-mig'")).toEqual([
      { login: "xia-mig", added_by: "olivia" },
    ])
    expect(await all("SELECT login FROM profiles WHERE path = 'content/people/wu.md'")).toEqual([
      { login: "wu-mig" },
    ])
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
      display_name: "Local member",
      avatar: null,
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
