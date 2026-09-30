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
    // GitHub logins are case-insensitive: "Dave" is dave, and is added only once.
    for (let i = 0; i < 2; i++)
      await owner.json("/api/admin/admins", {
        method: "POST",
        body: JSON.stringify({ login: "Dave" }),
      })
    expect((await dave.fetch("/api/admin/audit")).status).toBe(200)
    expect((await owner.json("/api/admin/admins")).body.admins).toHaveLength(1)
    expect((await owner.fetch("/api/admin/admins/DAVE", { method: "DELETE" })).status).toBe(200)
    expect((await dave.fetch("/api/admin/audit")).status).toBe(403)
    const rows = await auditRows("login = 'olivia' AND action LIKE 'admin.%'")
    expect(rows.map((r) => [r.action, r.target])).toEqual([
      ["admin.promote", "dave"],
      ["admin.demote", "dave"],
      ["admin.promote", "dave"],
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
    // A negative limit is still one page, not the whole log.
    const negative = await owner.json("/api/admin/audit?login=erin&action=gpt&limit=-1")
    expect(negative.body.rows.map((r: any) => r.target)).toEqual(["c2"])
    const csv = await owner.fetch("/api/admin/audit.csv?login=erin")
    expect(csv.headers.get("content-type")).toContain("text/csv")
    const lines = (await csv.text()).trim().split("\n")
    expect(lines[0]).toContain("time_utc")
    expect(lines).toHaveLength(4)
  })

  it("lets admins read members' Hafezi GPT conversations", async () => {
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO gpt_conversations (id, owner, title, model, created_at, updated_at)
       VALUES ('c-mia-1', 'mia', 'Ring resonator loss', 'claude-sonnet-5', ?1, ?1)`,
    )
      .bind(now)
      .run()
    await env.DB.prepare(
      `INSERT INTO gpt_messages (conversation_id, role, content_json, meta_json, created_at)
       VALUES ('c-mia-1', 'user', ?1, ?4, ?3), ('c-mia-1', 'assistant', ?2, '{}', ?3)`,
    )
      .bind(
        JSON.stringify([{ type: "text", text: "Why is my Q so low?" }]),
        JSON.stringify([{ type: "text", text: "Check the **bend loss** first." }]),
        now,
        // Stored the way chat.ts stores a prompt: the display text lives in meta.
        JSON.stringify({ kind: "prompt", text: "Why is my Q so low?" }),
      )
      .run()

    const member = await as("nora", "member")
    expect((await member.fetch("/api/admin/gpt/members")).status).toBe(403)
    expect((await member.fetch("/api/admin/gpt/conversations/c-mia-1")).status).toBe(403)

    const owner = await as("olivia", "owner")
    const members = await owner.json("/api/admin/gpt/members")
    expect(members.body.members.find((m: any) => m.login === "mia")).toMatchObject({
      conversations: 1,
      messages: 2,
    })
    const list = await owner.json("/api/admin/gpt/conversations?login=mia")
    expect(list.body.conversations.map((c: any) => [c.id, c.title, c.messages])).toEqual([
      ["c-mia-1", "Ring resonator loss", 2],
    ])
    expect((await owner.fetch("/api/admin/gpt/conversations?login=../x")).status).toBe(422)
    const chat = await owner.json("/api/admin/gpt/conversations/c-mia-1")
    expect(chat.body.conversation).toMatchObject({ owner: "mia", title: "Ring resonator loss" })
    expect(chat.body.turns[0]).toMatchObject({ role: "user", text: "Why is my Q so low?" })
    expect(chat.body.turns[1].role).toBe("assistant")
    expect(JSON.stringify(chat.body.turns[1].blocks)).toContain("bend loss")
    expect((await owner.fetch("/api/admin/gpt/conversations/nope")).status).toBe(404)
    // Reading is not recorded: after a later audited write lands, olivia has only that row.
    await owner.json("/api/admin/budgets/mia", {
      method: "PUT",
      body: JSON.stringify({ monthly_tokens: 1000 }),
    })
    const rows = await auditRows("login = 'olivia' AND target = 'mia'")
    expect(rows.map((r) => r.action)).toEqual(["admin.budget"])
    const { results } = await env.DB.prepare(
      "SELECT action, target FROM audit_log WHERE login = 'olivia' AND (target LIKE '%gpt%' OR target = 'c-mia-1')",
    ).all()
    expect(results).toEqual([])
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

  it("splits a month's GPT usage by model and source, ghost text apart, and by day", async () => {
    const owner = await as("olivia", "owner")
    const insert = env.DB.prepare(
      `INSERT INTO gpt_usage_daily
         (login, day, model, source, input, output, cache_read, cache_write, cost_usd, requests)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    )
    const haiku = "claude-haiku-4-5-20251001"
    await env.DB.batch([
      insert.bind("gia", "2031-02-01", haiku, "completion", 100, 10, 0.25, 40),
      insert.bind("hal", "2031-02-01", haiku, "completion", 50, 5, 0.125, 20),
      insert.bind("gia", "2031-02-03", "claude-sonnet-5", "agent", 1000, 100, 3, 2),
      insert.bind("gia", "2031-02-03", "offline", "chat", 0, 0, 0, 1),
      insert.bind("gia", "2031-03-01", "claude-sonnet-5", "chat", 9, 9, 9, 9), // the next month
    ])
    const { body } = await owner.json("/api/admin/usage?month=2031-02")
    const sums = (input: number, output: number, cost_usd: number, requests: number) => ({
      input,
      output,
      cache_read: 0,
      cache_write: 0,
      cost_usd,
      requests,
    })
    expect(body.models).toEqual([
      { model: "claude-sonnet-5", label: "Sonnet 5", source: "agent", ...sums(1000, 100, 3, 2) },
      { model: haiku, label: "Haiku 4.5", source: "completion", ...sums(150, 15, 0.375, 60) },
      { model: "offline", label: "offline", source: "chat", ...sums(0, 0, 0, 1) },
    ])
    expect(body.days.map((d: any) => [d.day, d.label, d.source, d.cost_usd, d.requests])).toEqual([
      ["2031-02-01", "Haiku 4.5", "completion", 0.375, 60],
      ["2031-02-03", "Sonnet 5", "agent", 3, 2],
      ["2031-02-03", "offline", "chat", 0, 1],
    ])
  })
})
