import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { as, auditRows, setAcl } from "./helpers"
import { privateVault } from "./worker"

// /api/admin/acl: admins manage the groups and rules; every change bumps the version, is audited,
// applies at once, and is committed to vault-private as .hafezi/acl.json for the site's build.

beforeEach(async () => {
  await setAcl()
  await env.DB.prepare("DELETE FROM audit_log").run()
  privateVault.reset({ "notes/meeting.md": "x\n" })
})

const admin = () => as("boss", "owner")
const send = async (method: string, path: string, body?: object) =>
  (await admin()).json(`/api/admin/acl${path}`, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
const snapshot = () => JSON.parse(privateVault.text(".hafezi/acl.json") ?? "null")

describe("the access rules' admin API", () => {
  it("is for admins only", async () => {
    const member = await as("anishgoyal1108")
    expect((await member.json("/api/admin/acl")).status).toBe(403)
    expect(
      (
        await member.json("/api/admin/acl/rules", {
          method: "POST",
          body: JSON.stringify({ pattern: "notes/" }),
        })
      ).status,
    ).toBe(403)
  })

  it("lists the groups and rules with their versions", async () => {
    const { status, body } = await send("GET", "")
    expect(status).toBe(200)
    expect(body.groups[0]).toMatchObject({ name: "optical-rl", logins: expect.any(Array) })
    expect(body.rules[0]).toMatchObject({ id: "r1", pattern: "projects/optical-rl/" })
    expect(body.build_version).toBe(1)
    expect(typeof body.version).toBe("number")
  })

  it("makes a group and a rule that apply at once, committed for the build, and audited", async () => {
    const before = (await send("GET", "")).body.version
    expect(
      (await send("POST", "/groups", { name: "Theory", description: "the theory group" })).status,
    ).toBe(201)
    expect((await send("POST", "/groups/theory/members", { login: "@Ada" })).body).toMatchObject({
      login: "ada",
      published: { committed: true },
    })
    expect(
      (await send("POST", "/groups/theory/members", { person: "content/people/lida-xu.md" })).body
        .person,
    ).toBe("people/lida-xu")
    const outsider = await as("outsider")
    expect((await outsider.fetch("/api/site/resources/notes")).status).toBe(200)
    const made = await send("POST", "/rules", {
      pattern: "../notes",
      allow: ["group:theory", "login:Eve"],
      deny: [],
      note: "theory notes",
    })
    expect(made.status).toBe(422)
    const rule = await send("POST", "/rules", {
      pattern: "notes",
      allow: ["group:theory", "login:Eve"],
      note: "theory notes",
    })
    expect(rule.status).toBe(201)
    expect(rule.body).toMatchObject({ id: "r100", allow: ["group:theory", "login:eve"] })
    expect(rule.body.version).toBe(before + 4)
    // At once, in this isolate, without waiting for the next check of the version.
    expect((await outsider.fetch("/api/site/resources/notes")).status).toBe(404)
    expect((await (await as("ada")).fetch("/api/site/resources/notes")).status).toBe(200)
    // Committed to vault-private's main for the build.
    expect(snapshot()).toMatchObject({
      version: before + 4,
      groups: { theory: { logins: ["ada"], people: ["people/lida-xu"] } },
      rules: expect.arrayContaining([
        {
          id: "r100",
          pattern: "notes",
          allow: ["group:theory", "login:eve"],
          deny: [],
          note: "theory notes",
        },
      ]),
    })
    expect(privateVault.made.at(-1)!.message).toBe(
      `update the members site access rules (version ${before + 4})`,
    )
    const rows = await auditRows("action LIKE 'admin.acl.%'")
    expect(rows.map((row) => row.action)).toEqual([
      "admin.acl.group.create",
      "admin.acl.member.add",
      "admin.acl.member.add",
      "admin.acl.rule.create",
    ])
    expect((await send("GET", "")).body.committed_version).toBe(before + 4)
  })

  it("refuses what isn't a group, member or rule", async () => {
    for (const [method, path, body] of [
      ["POST", "/groups", { name: "Not a name!" }],
      ["POST", "/groups", { name: "optical-rl" }],
      ["POST", "/groups/optical-rl/members", { login: "not a login" }],
      ["POST", "/groups/optical-rl/members", { person: "lida-xu" }],
      ["POST", "/groups/optical-rl/members", {}],
      ["POST", "/rules", { pattern: "../x" }],
      ["POST", "/rules", { pattern: "notes/", allow: ["group:nobody"] }],
      ["POST", "/rules", { pattern: "notes/", allow: ["team:x"] }],
      ["PUT", "/rules/r404", { pattern: "notes/" }],
      ["DELETE", "/groups/optical-rl"],
    ] as const) {
      const { status } = await send(method, path, body)
      expect(status, `${method} ${path} ${JSON.stringify(body)}`).toBeGreaterThanOrEqual(404)
      expect(status).toBeLessThan(500)
    }
  })

  it("changes and removes members, rules and groups", async () => {
    expect((await send("DELETE", "/groups/optical-rl/members?login=mjalalim3")).status).toBe(200)
    expect((await send("DELETE", "/groups/optical-rl/members?login=mjalalim3")).status).toBe(404)
    expect(
      (await (await as("mjalalim3")).fetch("/api/site/resources/projects/optical-rl/notes/plan"))
        .status,
    ).toBe(404)
    const updated = await send("PUT", "/rules/r1", {
      pattern: "projects/optical-rl/",
      allow: [],
      deny: ["login:outsider"],
    })
    expect(updated.body).toMatchObject({ id: "r1", allow: [], deny: ["login:outsider"] })
    expect(
      (await (await as("mjalalim3")).fetch("/api/site/resources/projects/optical-rl/notes/plan"))
        .status,
    ).toBe(200)
    expect((await send("DELETE", "/rules/r1")).status).toBe(200)
    expect((await send("DELETE", "/groups/optical-rl")).status).toBe(200)
    expect(snapshot()).toMatchObject({ groups: {}, rules: [] })
  })

  it("explains who may read a path, and which rule says so", async () => {
    const check = async (login: string, path: string) =>
      (await send("GET", `/check?${new URLSearchParams({ login, path })}`)).body
    expect(await check("outsider", "projects/optical-rl/notes/plan.qmd")).toMatchObject({
      readable: false,
      rule: "r1",
      reason: expect.stringContaining("none of its allow list"),
    })
    expect(await check("lidaxu-physics", "projects/optical-rl/notes/plan.qmd")).toMatchObject({
      readable: true,
      rule: "r1",
      reason: expect.stringContaining("group:optical-rl"),
    })
    expect(await check("outsider", "notes/meeting.md")).toMatchObject({
      readable: true,
      rule: null,
    })
    expect(await check("boss", "projects/optical-rl/x.md")).toMatchObject({
      readable: true,
      admin: true,
    })
    // A site path is every vault path it shows (test/site/static/acl-refs.json).
    expect(await check("outsider", "/pdf/optical-plan.pdf")).toMatchObject({
      readable: false,
      rule: "r1",
    })
  })

  it("says whether the deployed site has the rules as they are", async () => {
    const status = (await (await as("anishgoyal1108")).json("/api/acl/build-status")).body
    expect(status).toMatchObject({ buildVersion: 1, d1Version: expect.any(Number) })
    expect(status.pending).toBe(status.d1Version > 1)
  })
})
