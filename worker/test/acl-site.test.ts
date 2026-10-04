import { env } from "cloudflare:test"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { as, auditRows, setAcl } from "./helpers"
import { upstreamCalls } from "./worker"

// The member edition of a restricted page (the optical RL project, migration 0018's rule): every
// file that shows it is the site's 404 for anyone outside its group, and there for its people and
// admins. test/site/static/acl-refs.json is the build's map of its aliases, notebook assets and PDFs.

const RESTRICTED = [
  "/resources/projects/optical-rl/notes/plan",
  "/resources/projects/optical-rl/notes/plan.html",
  "/resources/projects/optical-rl/notes/plan.md",
  "/resources/projects/optical-rl/notes/plan.history.json",
  "/resources/projects/optical-rl/notes/plan-og-image.webp",
  "/resources/projects/optical-rl/",
  "/resources/projects/optical-rl",
  "/resources/projects/optical-rl/assets/reward.svg",
  "/resources/ppo-plan",
  "/pdf/optical-plan.pdf",
  "/notebook-assets/ab/optical.png",
  "/resources/projects/optical-rl/files/run.pdf",
]

const site = (path: string) => `/api/site${path}`

beforeAll(() => setAcl())
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_log").run()
  upstreamCalls.splice(0)
})

describe("restricted pages on the member edition", () => {
  it("are the site's own 404 for a member outside the group, and audited", async () => {
    const outsider = await as("outsider")
    const missing = await outsider.fetch(site("/nowhere"))
    const notFound = await missing.text()
    for (const path of RESTRICTED) {
      const response = await outsider.fetch(site(path))
      expect(response.status, path).toBe(404)
      expect(await response.text(), path).toBe(notFound)
      expect(response.headers.get("x-canonical-path"), path).toBeNull()
      expect(response.headers.get("cache-control")).toBe("private, no-store")
    }
    const head = await outsider.fetch(site(RESTRICTED[0]), { method: "HEAD" })
    expect(head.status).toBe(404)
    // The document was never fetched from GitHub, nor its cache looked at.
    expect(upstreamCalls).toEqual([])
    const rows = await auditRows("action = 'acl.deny'")
    expect(rows[0]).toMatchObject({ login: "outsider", target: RESTRICTED[0] })
  })

  it("are there for the group's people and for admins", async () => {
    for (const reader of [await as("mjalalim3"), await as("boss", "owner")]) {
      for (const path of RESTRICTED) {
        const response = await reader.fetch(site(path))
        // Redirects to the canonical path come back as 204 with it.
        expect([200, 204], path).toContain(response.status)
      }
      expect(await (await reader.fetch(site(RESTRICTED[0]))).text()).toContain("microring")
    }
  })

  it("leave what other pages share, and everything unrestricted, alone", async () => {
    const outsider = await as("outsider")
    for (const path of [
      "/notebook-assets/ab/shared.png",
      "/pdf/meeting.pdf",
      "/resources/notes",
      "/resources/notes.md",
      "/resources/assets/figure.svg",
      "/resources/files/equipment/laser/manual.pdf",
      "/",
    ])
      expect((await outsider.fetch(site(path))).status, path).toBe(200)
  })

  it("keep the build's maps of restricted pages from members, not admins", async () => {
    const outsider = await as("mjalalim3")
    for (const path of [
      "/static/acl-refs.json",
      "/static/contentIndex.offsets.json",
      "/static/acl-index/r1.json",
    ])
      expect((await outsider.fetch(site(path))).status, path).toBe(404)
    const admin = await as("boss", "owner")
    expect((await admin.fetch(site("/static/acl-refs.json"))).status).toBe(200)
  })

  it("open once a member joins the group, and close when they leave, without a deploy", async () => {
    const newcomer = await as("newcomer")
    expect((await newcomer.fetch(site(RESTRICTED[0]))).status).toBe(404)
    await setAcl({
      groups: { "optical-rl": { logins: ["newcomer"] } },
      rules: [{ id: "r1", pattern: "projects/optical-rl/", allow: ["group:optical-rl"] }],
    })
    expect((await newcomer.fetch(site(RESTRICTED[0]))).status).toBe(200)
    await setAcl()
    expect((await newcomer.fetch(site(RESTRICTED[0]))).status).toBe(404)
  })
})
