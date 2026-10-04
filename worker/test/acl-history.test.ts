import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { as, auditRows, setAcl } from "./helpers"
import { upstreamBodies, upstreamCalls } from "./worker"

// A restricted page's history (GET /api/history/file) is as restricted as the page: refused like
// a revision that doesn't exist, before the edge cache or GitHub is asked.

const REV = "1234567890abcdef1234567890abcdef12345678"
const PLAN = "projects/optical-rl/notes/plan.qmd"
const file = (path: string, repo = "vault-private") =>
  `/api/history/file?${new URLSearchParams({ repo, rev: REV, path })}`

beforeAll(() => setAcl())
beforeEach(() => {
  upstreamCalls.splice(0)
  upstreamBodies[`plan.qmd?ref=${REV}`] = [200, "PPO on the microring"]
})

describe("a restricted page's history", () => {
  it("is not found for a member outside the group, cached or not, and audited", async () => {
    // A group member's read puts it in the edge cache first.
    const member = await as("lidaxu-physics")
    expect(await (await member.fetch(file(PLAN))).text()).toBe("PPO on the microring")
    const outsider = await as("outsider")
    for (const repo of ["vault-private", "vault-optical-rl"]) {
      const response = await outsider.json(file(PLAN, repo))
      expect(response).toEqual({
        status: 404,
        body: { detail: "that page isn't in that revision" },
      })
    }
    expect(upstreamCalls).toHaveLength(1)
    expect((await auditRows("action = 'acl.deny'"))[0]).toMatchObject({
      login: "outsider",
      target: PLAN,
    })
  })

  it("is there for the group and admins", async () => {
    for (const reader of [await as("anishgoyal1108"), await as("boss", "owner")]) {
      const response = await reader.fetch(file(PLAN))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("PPO on the microring")
    }
  })
})
