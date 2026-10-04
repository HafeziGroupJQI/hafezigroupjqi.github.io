import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import {
  aclKey,
  canRead,
  decidingRule,
  globPattern,
  normalizeSnapshot,
  patternKind,
} from "./policy.mjs"

// The vectors the Worker's policy (worker/src/acl/policy.ts) passes too.
const vectors = JSON.parse(
  fs.readFileSync(new URL("../../worker/test/acl-vectors.json", import.meta.url), "utf8"),
)

test("the build's policy passes every shared vector", () => {
  let cases = 0
  for (const { snapshot, cases: list } of vectors) {
    const normalized = normalizeSnapshot(snapshot)
    for (const { path, login, person = null, admin = false, readable, rule } of list) {
      assert.deepEqual(
        canRead(normalized, path, { login, person, admin }),
        { readable, rule },
        `${login}${person ? ` (${person})` : ""}${admin ? " (admin)" : ""} on ${path}`,
      )
      cases++
    }
  }
  assert.ok(cases > 20)
})

test("patterns: an exact file, a folder, or a glob", () => {
  assert.equal(patternKind("notes/x.md"), "exact")
  assert.equal(patternKind("notes/"), "folder")
  assert.equal(patternKind("notes/*.md"), "glob")
  assert.ok(globPattern("a/*/b.md").test("a/x/b.md"))
  assert.ok(!globPattern("a/*/b.md").test("a/x/y/b.md"))
  assert.ok(globPattern("a/**/b.md").test("a/b.md"))
  assert.ok(globPattern("a/**/b.md").test("a/x/y/b.md"))
  assert.ok(globPattern("a/**").test("a/x/y/b.md"))
  // Regular expression characters in a pattern are literal.
  assert.ok(!globPattern("a/x+(1)*.md").test("a/xx1.md"))
  assert.ok(globPattern("a/x+(1)*.md").test("a/x+(1) copy.md"))
})

test("a missing snapshot has no rules, and nothing is restricted", () => {
  const empty = normalizeSnapshot(undefined)
  assert.deepEqual(empty, { version: 0, groups: {}, rules: [] })
  assert.equal(aclKey(empty, "projects/optical-rl/notes/x.md"), null)
  assert.equal(decidingRule(empty, "x.md"), null)
})
