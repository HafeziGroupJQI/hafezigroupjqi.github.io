import { beforeAll, describe, expect, it } from "vitest"
import { as, setAcl } from "./helpers"

// Links to restricted pages on other pages (test/site/resources/hub.html), from the rules as they
// are now: a member who can't read the page gets "restricted page" in place of each link to it,
// and the build's data-acl blocks of rules they can't read are gone.

const hub = async (login: string, role: "member" | "owner" = "member") => {
  const response = await (await as(login, role)).fetch("/api/site/resources/hub")
  expect(response.status).toBe(200)
  return response.text()
}

beforeAll(() => setAcl())

describe("links to restricted pages", () => {
  it("become plain text for a member outside the group, data-acl blocks gone", async () => {
    const page = await hub("outsider")
    for (const gone of [
      "projects/optical-rl",
      "ppo-plan",
      "optical-plan.pdf",
      "Plan row",
      "microring",
      "Row of a rule that is gone",
    ])
      expect(page).not.toContain(gone)
    expect(page.match(/<span class="acl-hidden">restricted page<\/span>/g)).toHaveLength(4)
    // Everything else stays: other pages' links, other sites' links, the page itself.
    expect(page).toContain('<a href="notes">Private notes</a>')
    expect(page).toContain('<a href="https://example.com/elsewhere/">Elsewhere</a>')
    expect(page).toContain("<h1>Projects hub</h1>")
  })

  it("stay for the group's people and admins", async () => {
    for (const page of [await hub("anishgoyal1108"), await hub("boss", "owner")]) {
      expect(page).not.toContain("acl-hidden")
      expect(page).toContain('<a href="projects/optical-rl/notes/plan" class="internal">')
      expect(page).toContain("Plan row")
    }
    // A rule that no longer exists hides its block from members, not from admins.
    expect(await hub("anishgoyal1108")).not.toContain("Row of a rule that is gone")
    expect(await hub("boss", "owner")).toContain("Row of a rule that is gone")
  })

  it("follow a change of the rules without a deploy", async () => {
    await setAcl({
      groups: { "optical-rl": { logins: ["outsider"] } },
      rules: [{ id: "r1", pattern: "projects/optical-rl/", allow: ["group:optical-rl"] }],
    })
    expect(await hub("outsider")).toContain("Plan row")
    expect(await hub("anishgoyal1108")).not.toContain("Plan row")
    await setAcl()
  })
})
