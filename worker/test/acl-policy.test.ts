import { describe, expect, it } from "vitest"
import {
  AclPolicy,
  type AclSnapshot,
  globRegex,
  patternKind,
  validPattern,
  validPrincipal,
} from "../src/acl/policy"
import vectors from "./acl-vectors.json"

// The shared vectors: the site's build (tools/acl/policy.mjs) passes the same file.
describe("the access policy's shared vectors", () => {
  for (const [index, { snapshot, cases }] of (
    vectors as unknown as {
      snapshot: AclSnapshot
      cases: {
        path: string
        login: string
        person?: string
        admin?: boolean
        readable: boolean
        rule: string | null
      }[]
    }[]
  ).entries()) {
    const policy = new AclPolicy(snapshot)
    for (const c of cases)
      it(`#${index}: ${c.login}${c.person ? ` (${c.person})` : ""}${c.admin ? " as admin" : ""} on ${c.path}`, () => {
        expect(policy.decide({ login: c.login, person: c.person, admin: c.admin }, c.path)).toEqual(
          { readable: c.readable, rule: c.rule },
        )
      })
  }
})

describe("the access policy", () => {
  it("tells a pattern's kind", () => {
    expect(patternKind("notes/x.md")).toBe("exact")
    expect(patternKind("projects/optical-rl/")).toBe("folder")
    expect(patternKind("notes/*.md")).toBe("glob")
  })

  it("reads globs: one segment, any depth, a folder's glob", () => {
    expect(globRegex("notes/*.md").test("notes/a.md")).toBe(true)
    expect(globRegex("notes/*.md").test("notes/a/b.md")).toBe(false)
    expect(globRegex("notes/**").test("notes/a/b.md")).toBe(true)
    expect(globRegex("**/x.md").test("x.md")).toBe(true)
    expect(globRegex("a/**/x.md").test("a/b/c/x.md")).toBe(true)
    expect(globRegex("*/drafts/").test("p/drafts/one/two.md")).toBe(true)
    expect(globRegex("notes/a+b(1).md").test("notes/a+b(1).md")).toBe(true)
  })

  it("checks what an admin may write as a rule", () => {
    expect(validPrincipal("group:optical-rl")).toBe(true)
    expect(validPrincipal("login:anishgoyal1108")).toBe(true)
    expect(validPrincipal("person:people/lida-xu")).toBe(true)
    expect(validPrincipal("person:people/alumni/old-member")).toBe(true)
    expect(validPrincipal("login:Anish")).toBe(false)
    expect(validPrincipal("person:lida-xu")).toBe(false)
    expect(validPrincipal("team:x")).toBe(false)
    expect(validPattern("projects/optical-rl/")).toBe(true)
    expect(validPattern("notes/**/draft-*.md")).toBe(true)
    expect(validPattern("/notes/x.md")).toBe(false)
    expect(validPattern("notes/../x.md")).toBe(false)
    expect(validPattern("notes//x.md")).toBe(false)
    expect(validPattern("")).toBe(false)
  })
})
