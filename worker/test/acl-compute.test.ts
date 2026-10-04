import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { ORIGIN, SITE, approvedProfile, setAcl } from "./helpers"
import vectors from "./fixtures/compute-vectors.json"

// GET /api/compute/acl: the compute host (its host key, as for its tunnel) asks who may read which
// restricted vault and rule, to bind members' ~/published mounts.

const acl = (query = "", key: string | null = vectors.host_key.key) =>
  SELF.fetch(`${ORIGIN}/api/compute/acl${query}`, {
    headers: { origin: SITE, ...(key ? { authorization: `Bearer ${key}` } : {}) },
  })

beforeEach(async () => {
  await setAcl()
  for (const table of ["audit_log", "admins", "profiles"])
    await env.DB.prepare(`DELETE FROM ${table}`).run()
  for (const [login, role] of [
    ["outsider", "member"],
    ["boss", "owner"],
    ["anishgoyal1108", "member"],
  ])
    await env.DB.prepare(
      "INSERT INTO audit_log (at, login, role, action) VALUES (?, ?, ?, 'auth.login')",
    )
      .bind(Date.now(), login, role)
      .run()
  await env.DB.prepare(
    "INSERT INTO admins (login, added_by, added_at) VALUES ('probe-0a1b2c3d', 'x', 0)",
  ).run()
})

describe("the compute host's access rules", () => {
  it("are for the host's key only (a plain GET, no websocket upgrade), never with CORS", async () => {
    expect((await acl("", null)).status).toBe(401)
    expect((await acl("", "hk_wrong")).status).toBe(401)
    const response = await acl()
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("name each member's restricted vaults and rules", async () => {
    const body = (await (await acl()).json()) as any
    // What the host checks before it trusts an answer.
    for (const rule of body.rules) expect(rule.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    for (const vault of body.vaults) {
      expect(vault.repo).toMatch(/^[A-Za-z0-9._-]{1,100}$/)
      if (vault.prefix) expect(vault.prefix).toMatch(/^[^*]+\/$/)
    }
    expect(body).toMatchObject({
      vaults: [
        { repo: "vault-private", prefix: "" },
        { repo: "vault-optical-rl", prefix: "projects/optical-rl/" },
      ],
      rules: [{ id: "r1", pattern: "projects/optical-rl/" }],
    })
    expect(body.members).toEqual({
      anishgoyal1108: { admin: false, vaults: ["vault-optical-rl"], rules: ["r1"] },
      // Group members not seen signing in yet are known too.
      "lidaxu-physics": { admin: false, vaults: ["vault-optical-rl"], rules: ["r1"] },
      mjalalim3: { admin: false, vaults: ["vault-optical-rl"], rules: ["r1"] },
      outsider: { admin: false, vaults: [], rules: [] },
      boss: { admin: true, vaults: ["vault-optical-rl"], rules: ["r1"] },
      "probe-0a1b2c3d": { admin: false, vaults: [], rules: [] },
    })
  })

  it("give the rules' version in D1 as it is now, for the host's rebuilds", async () => {
    const before = ((await (await acl()).json()) as any).version
    await env.DB.prepare("UPDATE acl_meta SET version = version + 1").run()
    expect(((await (await acl()).json()) as any).version).toBe(before + 1)
  })

  it("answer for one member, by their People page too", async () => {
    await approvedProfile("pdolgirev", "pavel-dolgirev")
    expect(((await (await acl("?login=PDolgirev")).json()) as any).members).toEqual({
      pdolgirev: { admin: false, vaults: ["vault-optical-rl"], rules: ["r1"] },
    })
    expect(((await (await acl("?login=nobody")).json()) as any).members).toEqual({
      nobody: { admin: false, vaults: [], rules: [] },
    })
    expect((await acl("?login=not%20a%20login")).status).toBe(422)
  })
})
