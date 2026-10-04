import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"

// Migration 0018: the access rules' tables with the optical RL project's group and rule, and the
// site's activity taking changes to restricted vaults' repositories.
describe("migration 0018", () => {
  it("seeds the optical rl group and the rule over its mount", async () => {
    const members = await env.DB.prepare(
      `SELECT m.login, m.person FROM acl_group_members m JOIN acl_groups g ON g.id = m.group_id
       WHERE g.name = 'optical-rl' ORDER BY m.login, m.person`,
    ).all<{ login: string | null; person: string | null }>()
    expect(members.results.filter((m) => m.login).map((m) => m.login)).toEqual([
      "anishgoyal1108",
      "lidaxu-physics",
      "mjalalim3",
    ])
    expect(members.results.filter((m) => m.person).map((m) => m.person)).toEqual([
      "people/anish-goyal",
      "people/lida-xu",
      "people/mahmoud-jalali-mehrabad",
      "people/mohammad-hafezi",
      "people/pavel-dolgirev",
      "people/shi-yuan-ma",
    ])
    const rule = await env.DB.prepare("SELECT * FROM acl_rules WHERE id = 'r1'").first<any>()
    expect(rule).toMatchObject({ pattern: "projects/optical-rl/", deny_json: "[]" })
    expect(JSON.parse(rule.allow_json)).toEqual(["group:optical-rl"])
    expect(
      await env.DB.prepare("SELECT version, next_rule FROM acl_meta WHERE id = 1").first(),
    ).toEqual({ version: 1, next_rule: 2 })
  })

  it("keeps changes' checks, indexes and visibility, and takes every vault's repository", async () => {
    const insert = (repo: string, state = "merged") =>
      env.DB.prepare(
        `INSERT INTO changes (at, author, repo, path, kind, state, source)
         VALUES (1, 'someone', ?, 'projects/optical-rl/notes/a.md', 'edit', ?, 'git')`,
      )
        .bind(repo, state)
        .run()
    await insert("vault-optical-rl")
    await insert("vault-private")
    await insert("vault")
    await expect(insert("elsewhere")).rejects.toThrow(/CHECK/)
    await expect(insert("vault-private", "lost")).rejects.toThrow(/CHECK/)
    const rows = await env.DB.prepare(
      "SELECT repo, visibility FROM changes WHERE author = 'someone' ORDER BY id",
    ).all()
    expect(rows.results).toEqual([
      { repo: "vault-optical-rl", visibility: "members" },
      { repo: "vault-private", visibility: "members" },
      { repo: "vault", visibility: "public" },
    ])
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'changes' ORDER BY name",
    ).all<{ name: string }>()
    expect(indexes.results.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        "changes_at",
        "changes_commit",
        "changes_draft",
        "changes_login",
        "changes_page",
      ]),
    )
    await env.DB.prepare("DELETE FROM changes WHERE author = 'someone'").run()
  })
})
