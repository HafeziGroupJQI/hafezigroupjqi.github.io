import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { pruneAudit } from "../src/audit"
import { ORIGIN, SITE, as, auditRows, signIn } from "./helpers"
import worker from "./worker"

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

const postJson = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: SITE },
  body: JSON.stringify(body),
})

describe("audit log", () => {
  it("records sign-ins", async () => {
    await signIn()
    const rows = await auditRows("login = 'dev' AND action = 'auth.login'")
    expect(rows.at(-1)).toMatchObject({ action: "auth.login", status: 200 })
  })

  it("records a GitHub account the org rule turns away", async () => {
    const github = { AUTH_MODE: "github" }
    const started = (await (
      await call("/api/auth/start", postJson({ next: "/" }), github)
    ).json()) as {
      authorize_url: string
      nonce: string
    }
    const state = new URL(started.authorize_url).searchParams.get("state")!
    const res = await call(
      "/api/auth/exchange",
      postJson({ code: "code-outsider", state, nonce: started.nonce }),
      github,
    )
    expect(res.status).toBe(403)
    const rows = await auditRows("login = 'outsider' AND action = 'auth.denied'")
    expect(rows[0].status).toBe(403)
  })

  it("records a generic row for writes no route described, with the final status", async () => {
    const alice = await as("alice-audit")
    const created = await alice.json("/api/calendar/events", {
      method: "POST",
      body: JSON.stringify({
        title: "Audit me",
        start: "2026-09-20T12:00:00",
        end: "2026-09-20T13:00:00",
      }),
    })
    expect(created.status).toBe(201)
    await alice.fetch("/api/calendar/events", { method: "POST", body: "{not json" })
    const rows = await auditRows("login = 'alice-audit' AND action = 'api.POST'")
    await expect.poll(async () => (await auditRows("login = 'alice-audit'")).length).toBe(2)
    expect(rows[0]).toMatchObject({ target: "/api/calendar/events", status: 201 })
    const all = await auditRows("login = 'alice-audit'")
    expect(all.map((r) => r.status)).toEqual([201, 422])
  })

  it("records logouts and private document views, but not reads", async () => {
    const bob = await as("bob-audit")
    expect(
      (await bob.fetch("/api/calendar/events?start=2026-09-01T00:00:00Z&end=2026-09-02T00:00:00Z"))
        .status,
    ).toBe(200)
    expect((await bob.fetch("/api/auth/logout", { method: "POST" })).status).toBe(200)
    const rows = await auditRows("login = 'bob-audit'")
    expect(rows.map((r) => r.action)).toEqual(["auth.logout"])
  })

  it("prunes rows past the retention window", async () => {
    await env.DB.prepare(
      "INSERT INTO audit_log (at, login, action) VALUES (?, 'ancient', 'auth.login')",
    )
      .bind(Date.now() - 400 * 86_400_000)
      .run()
    await pruneAudit(env as any)
    const { results } = await env.DB.prepare(
      "SELECT * FROM audit_log WHERE login = 'ancient'",
    ).all()
    expect(results).toEqual([])
  })
})

describe("admin console", () => {
  it("is closed to plain members", async () => {
    const carol = await as("carol")
    expect((await carol.fetch("/api/admin/audit")).status).toBe(403)
    const session = await carol.json("/api/session")
    expect(session.body.user.is_admin).toBe(false)
  })

  it("lets an org owner promote a member, effective on the next request", async () => {
    const owner = await as("olivia", "owner")
    const dave = await as("dave")
    expect((await dave.fetch("/api/admin/audit")).status).toBe(403)
    const promoted = await owner.json("/api/admin/admins", {
      method: "POST",
      body: JSON.stringify({ login: "@dave" }),
    })
    expect(promoted.status).toBe(201)
    expect((await dave.fetch("/api/admin/audit")).status).toBe(200)
    expect((await dave.json("/api/session")).body.user.is_admin).toBe(true)
    const list = await owner.json("/api/admin/admins")
    expect(list.body.admins.map((a: any) => a.login)).toContain("dave")
    expect((await owner.fetch("/api/admin/admins/dave", { method: "DELETE" })).status).toBe(200)
    expect((await dave.fetch("/api/admin/audit")).status).toBe(403)
    const rows = await auditRows("login = 'olivia' AND action LIKE 'admin.%'")
    expect(rows.map((r) => [r.action, r.target])).toEqual([
      ["admin.promote", "dave"],
      ["admin.demote", "dave"],
    ])
  })

  it("filters and pages the audit log, newest first, and exports CSV", async () => {
    const owner = await as("olivia", "owner")
    for (let i = 0; i < 3; i++)
      await env.DB.prepare(
        "INSERT INTO audit_log (at, login, action, target) VALUES (?, 'erin', 'gpt.message', ?)",
      )
        .bind(Date.now() + i, `c${i}`)
        .run()
    const first = await owner.json("/api/admin/audit?login=erin&action=gpt&limit=2")
    expect(first.body.rows.map((r: any) => r.target)).toEqual(["c2", "c1"])
    const next = await owner.json(
      `/api/admin/audit?login=erin&action=gpt&limit=2&before_id=${first.body.next_before_id}`,
    )
    expect(next.body.rows.map((r: any) => r.target)).toEqual(["c0"])
    expect(next.body.next_before_id).toBeNull()
    const csv = await owner.fetch("/api/admin/audit.csv?login=erin")
    expect(csv.headers.get("content-type")).toContain("text/csv")
    const lines = (await csv.text()).trim().split("\n")
    expect(lines[0]).toContain("time_utc")
    expect(lines).toHaveLength(4)
  })

  it("sets and clears monthly GPT budgets and reports usage", async () => {
    const owner = await as("olivia", "owner")
    const set = await owner.json("/api/admin/budgets/frank", {
      method: "PUT",
      body: JSON.stringify({ monthly_tokens: 500000 }),
    })
    expect(set.status).toBe(200)
    const usage = await owner.json("/api/admin/usage")
    expect(usage.body.members.find((m: any) => m.login === "frank").monthly_tokens).toBe(500000)
    await owner.json("/api/admin/budgets/frank", {
      method: "PUT",
      body: JSON.stringify({ monthly_tokens: null }),
    })
    const after = await owner.json("/api/admin/usage")
    expect(after.body.members.find((m: any) => m.login === "frank")).toBeUndefined()
  })
})
