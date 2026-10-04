import assert from "node:assert/strict"
import test from "node:test"
import { QUERIES, snapshotFromRows, wranglerRows } from "./export-snapshot.mjs"
import { canRead, normalizeSnapshot } from "./policy.mjs"

// D1's rows for the seeded optical rl group and rule (worker/migrations/0018_acl.sql), plus a
// second group and rule.
const rows = {
  meta: [{ version: 7 }],
  groups: [
    { id: 3, name: "hr" },
    { id: 1, name: "optical-rl" },
  ],
  members: [
    { group_id: 1, login: "AnishGoyal1108", person: null },
    { group_id: 1, login: "lidaxu-physics", person: null },
    { group_id: 3, login: "mohammad", person: null },
    { group_id: 1, login: null, person: "people/pavel-dolgirev" },
    { group_id: 9, login: "orphan", person: null },
  ],
  rules: [
    {
      id: "r1",
      pattern: "projects/optical-rl/",
      allow_json: '["group:optical-rl"]',
      deny_json: "[]",
      note: "the optical rl project (vault-optical-rl)",
    },
    {
      id: "r2",
      pattern: "notes/hr/",
      allow_json: '["group:hr"]',
      deny_json: '["login:mallory"]',
      note: "",
    },
  ],
}

test("the snapshot is made from D1's rows as the Worker makes it", () => {
  assert.deepEqual(snapshotFromRows(rows), {
    version: 7,
    groups: {
      hr: { logins: ["mohammad"], people: [] },
      "optical-rl": {
        logins: ["anishgoyal1108", "lidaxu-physics"],
        people: ["people/pavel-dolgirev"],
      },
    },
    rules: [
      {
        id: "r1",
        pattern: "projects/optical-rl/",
        allow: ["group:optical-rl"],
        deny: [],
        note: "the optical rl project (vault-optical-rl)",
      },
      { id: "r2", pattern: "notes/hr/", allow: ["group:hr"], deny: ["login:mallory"], note: "" },
    ],
  })
  const acl = normalizeSnapshot(snapshotFromRows(rows))
  assert.deepEqual(canRead(acl, "projects/optical-rl/notes/x.md", { login: "anishgoyal1108" }), {
    readable: true,
    rule: "r1",
  })
  assert.deepEqual(canRead(acl, "projects/optical-rl/notes/x.md", { login: "mohammad" }), {
    readable: false,
    rule: "r1",
  })
  // No tables' rows yet: no rules.
  assert.deepEqual(snapshotFromRows({}), { version: 0, groups: {}, rules: [] })
  assert.match(QUERIES.rules, /ORDER BY CAST\(substr\(id, 2\) AS INTEGER\), id/)
})

test("a rule whose principals aren't a JSON list stops the export, never opens the rule", () => {
  for (const allow_json of ["{", '"group:x"', "[1]", "null"])
    assert.throws(
      () => snapshotFromRows({ ...rows, rules: [{ ...rows.rules[0], allow_json }] }),
      /acl_rules r1: allow_json is not a JSON list of principals/,
    )
})

test("wrangler's JSON output gives the query's rows", () => {
  const out = `[\n  {\n    "results": [{ "version": 7 }],\n    "success": true,\n    "meta": {}\n  }\n]`
  assert.deepEqual(wranglerRows(`some banner\n${out}`), [{ version: 7 }])
  assert.throws(() => wranglerRows('[{"success": false}]'), /d1 query failed/)
})
