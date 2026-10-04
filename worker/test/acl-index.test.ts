import { describe, expect, it } from "vitest"
import { resetContentIndex, splice } from "../src/acl/content-index"
import { as, setAcl } from "./helpers"

// static/contentIndex.json (search, graph, explorer, the editor's completion) as each member may
// read it: the build left the optical RL plan out and put it in static/acl-index/r1.json.

const PLAN = "resources/projects/optical-rl/notes/plan"
const TOPO = "resources/projects/topo-automation-plan"

const index = async (login: string, role: "member" | "owner" = "member") => {
  const response = await (await as(login, role)).fetch("/api/site/static/contentIndex.json")
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  const text = await response.text()
  return { text, entries: JSON.parse(text) as Record<string, any> }
}

describe("the content index for each member", () => {
  it("splices in the shards of the rules a member may read, for them and admins only", async () => {
    await setAcl()
    resetContentIndex()
    const outsider = await index("outsider")
    expect(Object.keys(outsider.entries)).not.toContain(PLAN)
    expect(outsider.text).not.toMatch(/microring|optical/i)
    for (const login of ["lidaxu-physics", "boss"]) {
      const member = await index(login, login === "boss" ? "owner" : "member")
      expect(member.entries[PLAN].title).toBe("Optical RL plan")
      expect(member.entries["equipment/santec-tsl"].title).toBe("Santec TSL tunable laser")
      expect(Object.keys(member.entries)).toHaveLength(Object.keys(outsider.entries).length + 1)
    }
  })

  it("cuts out what a live rule newer than the build keeps from a member", async () => {
    await setAcl({
      groups: { topo: { logins: ["ada"] } },
      rules: [
        { id: "r1", pattern: "projects/optical-rl/", allow: ["group:topo"] },
        { id: "r2", pattern: "projects/topo-automation-plan", allow: ["group:topo"] },
        { id: "r3", pattern: "index", deny: ["login:eve"] },
        { id: "r4", pattern: "library/", deny: ["login:eve"] },
      ],
    })
    resetContentIndex()
    const outsider = await index("outsider")
    expect(Object.keys(outsider.entries)).not.toContain(TOPO)
    expect(Object.keys(outsider.entries)).not.toContain(PLAN)
    expect(outsider.entries.index).toBeDefined()
    const eve = await index("eve")
    // Two entries side by side cut: the index stays JSON. A rule names vault paths, which the
    // public site's pages ("index", the home page) are not.
    expect(Object.keys(eve.entries)).not.toContain(
      "resources/library/instrument-control-and-calibration",
    )
    expect(Object.keys(eve.entries)).not.toContain(TOPO)
    expect(Object.keys(eve.entries)).toContain("index")
    const ada = await index("ada")
    expect(ada.entries[TOPO].title).toBe("Topo automation plan")
    expect(ada.entries[PLAN].title).toBe("Optical RL plan")
    await setAcl()
    resetContentIndex()
  })

  it("splices any set of entries into valid JSON", () => {
    const base = '{"a":{"x":1},"b":{"y":"}"},"c":{}}'
    const at = { a: [1, 12], b: [13, 26], c: [27, 33] } as Record<string, [number, number]>
    expect(base.slice(...at.b)).toBe('"b":{"y":"}"}')
    const pick = (...keys: string[]) => keys.map((key) => at[key])
    for (const cuts of [
      [],
      ["a"],
      ["b"],
      ["c"],
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
      ["a", "b", "c"],
    ])
      for (const added of [[], ['"z":{"q":2}', '"w":[]']]) {
        const out = JSON.parse(splice(base, pick(...cuts), added))
        expect(Object.keys(out).sort()).toEqual(
          [
            ...["a", "b", "c"].filter((k) => !cuts.includes(k)),
            ...(added.length ? ["z", "w"] : []),
          ].sort(),
        )
      }
  })
})
