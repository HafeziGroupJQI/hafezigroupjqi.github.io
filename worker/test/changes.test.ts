import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import importSql from "./fixtures/changes-import.sql?raw"
import { ORIGIN, SITE, as } from "./helpers"

const T0 = Date.UTC(2026, 8, 29, 12)
const MINUTE = 60_000

interface Seed {
  at: number
  path: string
  login?: string | null
  author?: string
  repo?: "vault" | "vault-private"
  from_path?: string | null
  slug?: string | null
  kind?: string
  state?: string
  summary?: string
  commit_sha?: string | null
  pr_number?: number | null
  draft_id?: string | null
  source?: "site" | "git"
}

const COLUMNS = [
  "at",
  "login",
  "author",
  "repo",
  "path",
  "from_path",
  "slug",
  "kind",
  "state",
  "summary",
  "commit_sha",
  "pr_number",
  "draft_id",
  "source",
] as const

function insert(row: Seed, verb = "INSERT") {
  const full = {
    login: null,
    author: row.login ?? "Anish Goyal",
    repo: "vault",
    from_path: null,
    slug: null,
    kind: "edit",
    state: "merged",
    summary: "",
    commit_sha: null,
    pr_number: null,
    draft_id: null,
    source: "git",
    ...row,
  }
  return env.DB.prepare(
    `${verb} INTO changes (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
  ).bind(...COLUMNS.map((column) => full[column]))
}

const seed = async (...rows: Seed[]) => {
  for (const row of rows) await insert(row).run()
}

const feed = async (query = "") => {
  const { status, body } = await (await as("ada")).json(`/api/changes${query}`)
  expect(status).toBe(200)
  return body as { changes: any[]; next: string | null }
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM changes").run()
})

describe("changes: the members' feed", () => {
  it("is for signed-in members only", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/changes`, { headers: { origin: SITE } })
    expect(response.status).toBe(401)
  })

  it("lists the newest changes first, with their links on GitHub", async () => {
    await seed(
      {
        at: T0,
        login: "anishgoyal1108",
        author: "Anish Goyal",
        path: "content/people/anish-goyal.md",
        slug: "people/anish-goyal",
        kind: "profile",
        summary: "update people/anish-goyal from the members site settings",
        commit_sha: "f826207aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: "site",
      },
      {
        at: T0 + MINUTE,
        login: "Ada",
        author: "Ada Lovelace",
        repo: "vault-private",
        path: "notes/meeting.md",
        slug: "resources/notes/meeting",
        kind: "upload",
        state: "sent",
        summary: "replace notes/meeting.md by ada lovelace",
        pr_number: 7,
        draft_id: "0123456789ab",
        source: "site",
      },
    )
    const { changes, next } = await feed()
    expect(next).toBeNull()
    expect(changes.map((c) => c.path)).toEqual([
      "notes/meeting.md",
      "content/people/anish-goyal.md",
    ])
    expect(changes[0]).toMatchObject({
      login: "Ada",
      author: "Ada Lovelace",
      repo: "vault-private",
      slug: "resources/notes/meeting",
      kind: "upload",
      state: "sent",
      visibility: "members",
      commit: null,
      pull: { number: 7, url: "https://github.com/HafeziGroupJQI/vault-private/pull/7" },
      draft: "0123456789ab",
      source: "site",
    })
    expect(changes[1]).toMatchObject({
      visibility: "public",
      commit: {
        sha: "f826207aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        url: "https://github.com/HafeziGroupJQI/vault/commit/f826207aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      pull: null,
    })
  })

  it("filters by member, vault, file, kind and state", async () => {
    await seed(
      { at: T0, login: "ada", path: "content/a.md", kind: "new" },
      { at: T0 + 1, login: "grace", path: "content/a.md" },
      { at: T0 + 2, login: "ADA", repo: "vault-private", path: "notes/b.md", state: "sent" },
      { at: T0 + 3, path: "content/c.md", kind: "rename", from_path: "content/a.md" },
      { at: T0 + 4, login: "ada", repo: "vault-private", path: "files/d.pdf", kind: "upload" },
    )
    const paths = async (query: string) => (await feed(query)).changes.map((c) => c.path)
    // A member's contributions, whichever case their login was written in.
    expect(await paths("?login=Ada")).toEqual(["files/d.pdf", "notes/b.md", "content/a.md"])
    expect(await paths("?repo=vault-private")).toEqual(["files/d.pdf", "notes/b.md"])
    expect(await paths("?repo=vault&path=content/a.md")).toEqual(["content/a.md", "content/a.md"])
    expect(await paths("?kind=new,rename")).toEqual(["content/c.md", "content/a.md"])
    expect(await paths("?state=sent,review")).toEqual(["notes/b.md"])
    expect(await paths("?login=ada&kind=upload&state=merged")).toEqual(["files/d.pdf"])
    expect(await paths("?login=nobody")).toEqual([])
  })

  it("pages by a cursor, even through changes made at the same time", async () => {
    // One commit's files share its time.
    await seed(
      ...Array.from({ length: 7 }, (_, i) => ({
        at: T0 + (i < 4 ? 0 : i) * MINUTE,
        path: `content/p${i}.md`,
        commit_sha: "c".repeat(40),
      })),
    )
    const pages: string[][] = []
    let next: string | null = ""
    while (next !== null) {
      const page: { changes: any[]; next: string | null } = await feed(
        `?limit=3${next ? `&before=${next}` : ""}`,
      )
      pages.push(page.changes.map((c) => c.path))
      next = page.next
    }
    expect(pages.flat()).toHaveLength(7)
    expect(new Set(pages.flat()).size).toBe(7)
    expect(pages.map((page) => page.length)).toEqual([3, 3, 1])
    expect(pages[0]).toEqual(["content/p6.md", "content/p5.md", "content/p4.md"])
  })

  it("refuses filters it doesn't know, and keeps a page to at most 100", async () => {
    const client = await as("ada")
    for (const query of ["?kind=merge", "?state=open", "?repo=other", "?before=12"])
      expect((await client.json(`/api/changes${query}`)).status).toBe(422)
    await seed(...Array.from({ length: 101 }, (_, i) => ({ at: T0 + i, path: `content/${i}.md` })))
    expect((await feed("?limit=500")).changes).toHaveLength(100)
    expect((await feed("?limit=0")).changes).toHaveLength(1)
    expect((await feed()).changes).toHaveLength(50)
  })

  it("keeps one row per file of a commit, and only merged public changes public", async () => {
    const commit = "a".repeat(40)
    await seed({ at: T0, path: "content/a.md", commit_sha: commit })
    // The deploy's import skips a commit's file already recorded; files not merged have no commit.
    await insert({ at: T0, path: "content/a.md", commit_sha: commit }, "INSERT OR IGNORE").run()
    await expect(
      insert({ at: T0, path: "content/a.md", commit_sha: commit }).run(),
    ).rejects.toThrow()
    await seed(
      { at: T0 + 1, path: "content/a.md", state: "sent" },
      { at: T0 + 2, path: "content/a.md", state: "sent" },
      { at: T0 + 3, repo: "vault-private", path: "notes/a.md", commit_sha: commit },
    )
    const { changes } = await feed()
    expect(changes.map((c) => [c.repo, c.state, c.visibility])).toEqual([
      ["vault-private", "merged", "members"],
      ["vault", "sent", "members"],
      ["vault", "sent", "members"],
      ["vault", "merged", "public"],
    ])
  })

  it("takes the deploy's import twice as once, and keeps what the Worker recorded", async () => {
    // What tools/changes-import.mjs writes (tools/changes-import.test.mjs keeps them the same).
    // The Worker recorded one of its files as it merged a member's upload.
    await seed({
      at: T0,
      login: "ada",
      repo: "vault-private",
      path: "files/data.csv",
      kind: "upload",
      commit_sha: "e".repeat(40),
      draft_id: "0123456789ab",
      source: "site",
    })
    await env.DB.exec(importSql)
    await env.DB.exec(importSql)
    const { changes } = await feed()
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]))
    expect(changes).toHaveLength(4)
    expect(byPath["files/data.csv"]).toMatchObject({ source: "site", draft: "0123456789ab" })
    expect(byPath["content/lab-facilities.md"]).toMatchObject({
      source: "git",
      summary: "fix the santec laser's range; 1400-1600 nm",
      slug: "lab-facilities",
      visibility: "public",
    })
    expect(byPath["content/people/ada-lovelace.md"]).toMatchObject({
      login: "ada",
      author: "Ada Lovelace",
    })
    expect(byPath["notes/odd\nname.md"]).toMatchObject({
      kind: "rename",
      from: "notes/old.md",
      visibility: "members",
    })
  })
})
