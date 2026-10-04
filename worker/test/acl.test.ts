import { env as testEnv } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import {
  type AclRefs,
  RECHECK_MS,
  aclPolicy,
  aclViewer,
  canReadSitePath,
  canReadVaultPath,
  canSee,
  canWrite,
  deny,
  personOf,
  readSnapshot,
  resetAcl,
  siteTargets,
  viewerFor,
} from "../src/acl/index"
import type { Auditor } from "../src/audit"
import type { Session } from "../src/session"
import { approvedProfile, setAcl } from "./helpers"

const env = testEnv as any

const session = (login: string, role: "member" | "owner" = "member"): Session => ({
  typ: "session",
  login,
  name: login,
  role,
  exp: Math.floor(Date.now() / 1000) + 3600,
})

const PLAN = "projects/optical-rl/notes/plan.qmd"

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM profiles").run()
  await env.DB.prepare("DELETE FROM admins").run()
  await setAcl()
})

describe("the live access rules", () => {
  it("reads the rules and groups from D1 as the build's snapshot", async () => {
    const snapshot = await readSnapshot(env)
    expect(snapshot.groups["optical-rl"].logins).toEqual([
      "anishgoyal1108",
      "lidaxu-physics",
      "mjalalim3",
    ])
    expect(snapshot.groups["optical-rl"].people).toContain("people/pavel-dolgirev")
    expect(snapshot.rules).toEqual([
      {
        id: "r1",
        pattern: "projects/optical-rl/",
        allow: ["group:optical-rl"],
        deny: [],
        note: "",
      },
    ])
  })

  it("keeps its copy until the version moves, asking at most every few seconds", async () => {
    const first = await aclPolicy(env)
    await env.DB.prepare("UPDATE acl_rules SET pattern = 'notes/' WHERE id = 'r1'").run()
    // Same version: the copy stands, however often it is asked.
    expect(await aclPolicy(env, Date.now() + RECHECK_MS + 1)).toBe(first)
    await env.DB.prepare("UPDATE acl_meta SET version = version + 1").run()
    // Within the window nothing asks D1; after it, the new version is read.
    expect(await aclPolicy(env)).toBe(first)
    const next = await aclPolicy(env, Date.now() + 2 * RECHECK_MS + 1)
    expect(next).not.toBe(first)
    expect(next.rules[0].pattern).toBe("notes/")
  })

  it("lets the group in by login or by an approved People page, and admins everywhere", async () => {
    expect(await canReadVaultPath(env, session("anishgoyal1108"), PLAN)).toBe(true)
    expect(await canReadVaultPath(env, session("outsider"), PLAN)).toBe(false)
    expect(await canReadVaultPath(env, session("outsider"), "notes/meeting.md")).toBe(true)
    // An owner, and a member an admin promoted.
    expect(await canReadVaultPath(env, session("boss", "owner"), PLAN)).toBe(true)
    await env.DB.prepare(
      "INSERT INTO admins (login, added_by, added_at) VALUES ('ad', 'x', 0)",
    ).run()
    expect(await canReadVaultPath(env, session("ad"), PLAN)).toBe(true)
    // A lab session is never an admin's.
    expect(await canReadVaultPath(env, { ...session("boss", "owner"), lab: true }, PLAN)).toBe(
      false,
    )
    // Pavel has no login in the group: his People page lets him in once his claim is approved.
    expect(await canReadVaultPath(env, session("pdolgirev"), PLAN)).toBe(false)
    await env.DB.prepare(
      `INSERT INTO profiles (login, path, status, updated_at)
       VALUES ('pdolgirev', 'content/people/pavel-dolgirev.md', 'pending', 0)`,
    ).run()
    resetAcl()
    expect(await personOf(env, "pdolgirev")).toBeNull()
    expect(await canReadVaultPath(env, session("pdolgirev"), PLAN)).toBe(false)
    await approvedProfile("pdolgirev", "pavel-dolgirev")
    expect(await personOf(env, "PDolgirev")).toBe("people/pavel-dolgirev")
    expect(await canReadVaultPath(env, session("pdolgirev"), PLAN)).toBe(true)
  })

  it("needs read access to every path a change touches to write it", async () => {
    const member = session("anishgoyal1108")
    const outsider = session("outsider")
    expect(await canWrite(env, member, [PLAN, "notes/a.md"])).toBe(true)
    expect(await canWrite(env, outsider, ["notes/a.md", null])).toBe(true)
    expect(await canWrite(env, outsider, ["notes/a.md", PLAN])).toBe(false)
  })

  it("keys a reader's view by the rules they may read", async () => {
    const [member, outsider, other, admin] = await Promise.all([
      aclViewer(env, session("anishgoyal1108")),
      aclViewer(env, session("outsider")),
      aclViewer(env, session("other")),
      aclViewer(env, session("boss", "owner")),
    ])
    expect(outsider.key).toBe(other.key)
    expect(member.key).not.toBe(outsider.key)
    expect(admin.open).toBe(true)
    expect(member.canReadRule("r1")).toBe(true)
    expect(outsider.canReadRule("r1")).toBe(false)
    expect(outsider.canReadRule("r404")).toBe(false)
    // No rules at all: everyone sees everything.
    await setAcl({})
    const open = await aclViewer(env, session("outsider"))
    expect(open.open).toBe(true)
  })

  it("audits refusals sparingly", () => {
    const rows: string[] = []
    const record = ((action: string, target: string) => {
      rows.push(`${action} ${target}`)
    }) as unknown as Auditor
    const now = 1_000_000_000
    expect(deny(record, "x", "a", now)).toBe(true)
    expect(deny(record, "x", "a", now + 1000)).toBe(false)
    expect(deny(record, "x", "a", now + 11 * 60_000)).toBe(true)
    for (let i = 0; i < 40; i++) deny(record, "y", `p${i}`, now + 12 * 60_000)
    // Two for x, then 30 in the next minute at most.
    expect(rows.length).toBe(32)
    expect(rows[0]).toBe("acl.deny a")
  })
})

describe("site paths", () => {
  const refs: AclRefs = {
    pages: {
      "resources/projects/optical-rl/notes/plan": PLAN,
      "resources/notes/meeting": "notes/meeting.md",
    },
    aliases: { "resources/ppo-plan": PLAN },
    notebookAssets: {
      "ab/cd.png": [PLAN, "notes/meeting.md"],
      "ef/gh.png": [PLAN],
    },
    pdfs: { "pdf/plan.pdf": PLAN },
  }

  it("names the vault paths a site path shows", () => {
    for (const path of [
      "/resources/projects/optical-rl/notes/plan",
      "/resources/projects/optical-rl/notes/plan.html",
      "/resources/projects/optical-rl/notes/plan.md",
      "/resources/projects/optical-rl/notes/plan.history.json",
      "/resources/projects/optical-rl/notes/plan-og-image.webp",
    ])
      expect(siteTargets(refs, path).all, path).toContain(PLAN)
    expect(siteTargets(refs, "/resources/ppo-plan").all).toContain(PLAN)
    expect(siteTargets(refs, "/pdf/plan.pdf").all).toEqual([PLAN])
    expect(siteTargets(refs, "/notebook-assets/ab/cd.png")).toEqual({
      all: [],
      any: [PLAN, "notes/meeting.md"],
    })
    expect(siteTargets(refs, "/resources/projects/optical-rl/").all).toContain(
      "projects/optical-rl/",
    )
    expect(siteTargets(refs, "/resources/projects/optical-rl").all).toContain(
      "projects/optical-rl/",
    )
    expect(siteTargets(refs, "/resources/projects/optical-rl/assets/a.png").all).toEqual([
      "projects/optical-rl/assets/a.png",
    ])
    expect(siteTargets(refs, "/calendar").all).toEqual([])
  })

  it("lets a reader see what every path it shows lets them read", async () => {
    const policy = await aclPolicy(env)
    const outsider = viewerFor(policy, { login: "outsider", person: null, admin: false })
    const member = viewerFor(policy, { login: "mjalalim3", person: null, admin: false })
    for (const path of [
      "/resources/projects/optical-rl/notes/plan",
      "/resources/projects/optical-rl/notes/plan.md",
      "/resources/ppo-plan",
      "/pdf/plan.pdf",
      "/notebook-assets/ef/gh.png",
      "/resources/projects/optical-rl/",
      "/resources/projects/optical-rl/assets/a.png",
    ]) {
      expect(canSee(outsider, refs, path), path).toBe(false)
      expect(canSee(member, refs, path), path).toBe(true)
    }
    // An asset another page uses too is that page's as well.
    expect(canSee(outsider, refs, "/notebook-assets/ab/cd.png")).toBe(true)
    expect(canSee(outsider, refs, "/resources/notes/meeting")).toBe(true)
    // The test build has no acl-refs.json: paths under resources/ still map to themselves.
    expect(
      await canReadSitePath(env, session("outsider"), "/resources/projects/optical-rl/x"),
    ).toBe(false)
    expect(await canReadSitePath(env, session("outsider"), "/resources/notes")).toBe(true)
  })
})
