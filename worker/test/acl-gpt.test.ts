import { beforeEach, describe, expect, it } from "vitest"
import { resetContentIndex } from "../src/acl/content-index"
import { resetKnowledge } from "../src/gpt/knowledge"
import { as, setAcl } from "./helpers"

// Hafezi GPT and restricted pages: what a member searches, lists, reads and @-mentions is what they
// may read. The optical RL plan is in the build's shard for r1 (test/site/static/acl-index/r1.json),
// its PDF in the docs manifest under projects/optical-rl/.

const PLAN = "resources/projects/optical-rl/notes/plan"
const RUN = "resources/projects/optical-rl/files/run.pdf"

beforeEach(async () => {
  await setAcl()
  resetContentIndex()
  resetKnowledge()
})

const tool = async (
  login: string,
  name: string,
  input: object,
  role: "member" | "owner" = "member",
) =>
  (
    await (
      await as(login, role)
    ).json(`/api/gpt/tools/${name}`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).body as { text: string; summary: string; is_error: boolean }

const mentions = async (login: string, q: string, role: "member" | "owner" = "member") =>
  ((await (await as(login, role)).json(`/api/gpt/pages?q=${q}`)).body as any[]).map((r) => r.ref)

describe("Hafezi GPT and restricted pages", () => {
  it("finds nothing restricted for a member outside the group", async () => {
    // (A search that finds nothing says what was asked, so look for what the page says.)
    const search = (await tool("outsider", "search_site", { query: "microring heater" })).text
    expect(search).not.toMatch(/Optical RL plan|heater currents|optical-rl/i)
    const read = await tool("outsider", "read_page", { page: PLAN })
    expect(read.is_error).toBe(true)
    expect(read.text).not.toContain("microring")
    expect((await tool("outsider", "read_page", { page: RUN })).is_error).toBe(true)
    const listed = await tool("outsider", "list_pages", { tag: "project" })
    expect(listed.text).not.toContain("optical")
    expect(await mentions("outsider", "optical")).toEqual([])
    expect(await mentions("outsider", "run.pdf")).toEqual([])
    // What isn't restricted is found as ever.
    expect((await tool("outsider", "search_site", { query: "santec" })).text).toContain("Santec")
  })

  it("finds it for the group and admins", async () => {
    for (const [login, role] of [
      ["anishgoyal1108", "member"],
      ["boss", "owner"],
    ] as const) {
      expect(
        (await tool(login, "search_site", { query: "microring heater" }, role)).text,
      ).toContain("Optical RL plan")
      expect((await tool(login, "read_page", { page: PLAN }, role)).text).toContain(
        "heater currents",
      )
      expect(await mentions(login, "optical", role)).toContain(PLAN)
      expect(await mentions(login, "run.pdf", role)).toContain(RUN)
    }
  })

  it("follows the live rules: a page the build left open is hidden once a rule covers it", async () => {
    await setAcl({
      groups: { topo: { logins: ["ada"] } },
      rules: [{ id: "r2", pattern: "projects/topo-automation-plan", allow: ["group:topo"] }],
    })
    expect(
      (await tool("outsider", "search_site", { query: "topo automation" })).text,
    ).not.toContain("Topo automation plan")
    expect((await tool("ada", "search_site", { query: "topo automation" })).text).toContain(
      "Topo automation plan",
    )
  })
})
