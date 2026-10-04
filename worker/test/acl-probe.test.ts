import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { as, auditRows, client, setAcl } from "./helpers"
import { privateVault } from "./worker"

// Probe sessions: an admin mints a 30-minute bearer for a synthetic member (probe-<8 hex>) to see
// the site as someone outside a group, or, once it is added to one, inside it. A probe is never an
// admin and changes nothing.

const PLAN = "/api/site/resources/projects/optical-rl/notes/plan"

beforeEach(async () => {
  await setAcl()
  await env.DB.prepare("DELETE FROM audit_log").run()
  privateVault.reset({ "notes/meeting.md": "x\n" })
})

const mint = async () => {
  const { status, body } = await (
    await as("boss", "owner")
  ).json("/api/admin/acl/probe", { method: "POST" })
  expect(status).toBe(201)
  return body as { token: string; login: string; exp: number }
}

describe("probe sessions", () => {
  it("are minted by admins only, for 30 minutes, and audited", async () => {
    const member = await as("anishgoyal1108")
    expect((await member.json("/api/admin/acl/probe", { method: "POST" })).status).toBe(403)
    const probe = await mint()
    expect(probe.login).toMatch(/^probe-[0-9a-f]{8}$/)
    expect(probe.exp - Date.now() / 1000).toBeGreaterThan(29 * 60)
    expect(probe.exp - Date.now() / 1000).toBeLessThanOrEqual(30 * 60)
    expect((await auditRows("action = 'admin.acl.probe'"))[0]).toMatchObject({
      login: "boss",
      target: probe.login,
    })
    const session = (await client(probe.token).json("/api/session")).body.user
    expect(session).toMatchObject({ login: probe.login, role: "member", is_admin: false })
  })

  it("are never admins, even listed as one", async () => {
    const probe = await mint()
    await env.DB.prepare("INSERT INTO admins (login, added_by, added_at) VALUES (?, 'x', 0)")
      .bind(probe.login)
      .run()
    const reader = client(probe.token)
    expect((await reader.json("/api/session")).body.user.is_admin).toBe(false)
    expect((await reader.json("/api/admin/acl")).status).toBe(403)
    expect((await reader.fetch(PLAN)).status).toBe(404)
  })

  it("change nothing, but may search the site", async () => {
    const reader = client((await mint()).token)
    for (const [method, path] of [
      ["POST", "/api/uploads/drafts"],
      ["PUT", "/api/prefs"],
      ["POST", "/api/gpt/conversations"],
      ["POST", "/api/auth/logout"],
      ["DELETE", "/api/admin/acl/rules/r1"],
    ])
      expect((await reader.json(path, { method, body: "{}" })).status, path).toBe(403)
    expect((await auditRows("action = 'acl.probe.refused'")).length).toBeGreaterThan(0)
    const search = await reader.json("/api/gpt/tools/search_site", {
      method: "POST",
      body: JSON.stringify({ query: "santec" }),
    })
    expect(search.status).toBe(200)
    expect(search.body.text).toContain("Santec")
  })

  it("see a group's pages once added to it, and not after", async () => {
    const probe = await mint()
    const reader = client(probe.token)
    expect((await reader.fetch(PLAN)).status).toBe(404)
    const admin = await as("boss", "owner")
    const added = await admin.json("/api/admin/acl/groups/optical-rl/members", {
      method: "POST",
      body: JSON.stringify({ login: probe.login }),
    })
    expect(added.status).toBe(201)
    expect((await reader.fetch(PLAN)).status).toBe(200)
    await admin.json(`/api/admin/acl/groups/optical-rl/members?login=${probe.login}`, {
      method: "DELETE",
    })
    expect((await reader.fetch(PLAN)).status).toBe(404)
  })
})
