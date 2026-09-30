import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import {
  contributionScore,
  draftChanges,
  rankScores,
  recordChanges,
  resetScores,
  settleChanges,
  unsentChanges,
} from "../src/changes"
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
  resetScores()
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

describe("changes: what the site records as members act", () => {
  const DRAFT = "0123456789ab"
  const MERGE = "f".repeat(40)
  const upload = (files: Parameters<typeof draftChanges>[1], at = T0) =>
    draftChanges({ id: DRAFT, login: "ada", repo: "vault-private", kind: "upload" }, files, {
      at,
      author: "Ada Lovelace",
      summary: "add notes/a.pdf and 2 more by ada lovelace",
      pull: 7,
    })
  // The draft as it stands in D1: its changes follow it only to where it is.
  const draftIs = (status: string) =>
    env.DB.prepare(
      `INSERT INTO upload_drafts (id, login, status, created_at, edited_at, updated_at)
       VALUES (?, 'ada', ?, 0, 0, 0) ON CONFLICT (id) DO UPDATE SET status = excluded.status`,
    )
      .bind(DRAFT, status)
      .run()
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM upload_drafts WHERE id = ?").bind(DRAFT).run()
  })
  const files: Parameters<typeof draftChanges>[1] = [
    { path: "notes/a.pdf", action: "add", from_path: null, size: 1200 },
    { path: "notes/b.md", action: "rename", from_path: "notes/old.md", size: null },
    { path: "notes/c.md", action: "delete", from_path: null, size: null },
  ]

  it("records a sent draft's files, moves them on as it goes, and never unmerges one", async () => {
    await recordChanges(env, upload(files)).run()
    let { changes } = await feed(`?state=sent`)
    expect(changes.map((c) => [c.kind, c.path, c.from, c.slug, c.bytes, c.pull?.number])).toEqual([
      ["delete", "notes/c.md", null, null, null, 7],
      ["rename", "notes/b.md", "notes/old.md", "resources/notes/b", null, 7],
      ["upload", "notes/a.pdf", null, null, 1200, 7],
    ])
    expect(changes[0]).toMatchObject({ login: "ada", author: "Ada Lovelace", source: "site" })
    // An admin merged it on GitHub, and the deploy's import recorded the commit first.
    await seed({
      at: T0 + 1,
      repo: "vault-private",
      path: "notes/a.pdf",
      kind: "new",
      commit_sha: MERGE,
    })
    await draftIs("merged")
    await settleChanges(env, DRAFT, "merged", { commit: MERGE, at: T0 + 2 }).run()
    ;({ changes } = await feed())
    expect(changes.map((c) => [c.path, c.state, c.commit?.sha, c.source, c.at])).toEqual([
      ["notes/c.md", "merged", MERGE, "site", T0 + 2],
      ["notes/b.md", "merged", MERGE, "site", T0 + 2],
      ["notes/a.pdf", "merged", MERGE, "site", T0 + 2],
    ])
    await draftIs("discarded")
    await settleChanges(env, DRAFT, "discarded").run()
    expect((await feed("?state=merged")).changes).toHaveLength(3)
  })

  it("replaces what a draft sent before when it is sent again", async () => {
    await recordChanges(env, upload(files)).run()
    // The check's answer came for a revision its author has replaced since: nothing moves.
    await draftIs("open")
    await settleChanges(env, DRAFT, "failed", { at: T0 + 1 }).run()
    expect((await feed("?state=sent")).changes).toHaveLength(3)
    await draftIs("failed")
    await settleChanges(env, DRAFT, "failed", { at: T0 + 1 }).run()
    expect((await feed("?state=failed")).changes).toHaveLength(3)
    await env.DB.batch([
      unsentChanges(env, DRAFT),
      recordChanges(env, upload(files.slice(0, 1), T0 + 2)),
    ])
    const { changes } = await feed()
    expect(changes.map((c) => [c.path, c.state, c.at])).toEqual([["notes/a.pdf", "sent", T0 + 2]])
  })

  it("says an edit changes its page, or makes a new one", () => {
    const edit = (action: "add" | "replace") =>
      draftChanges(
        { id: DRAFT, login: "ada", repo: "vault", kind: "edit" },
        [{ path: "content/news/launch.md", action, from_path: null, size: 90 }],
        { at: T0, author: "Ada Lovelace", summary: "fix the date", pull: null },
      )[0]
    expect(edit("replace")).toMatchObject({ kind: "edit", repo: "vault", state: "sent" })
    expect(edit("add").kind).toBe("new")
  })
})

describe("changes: contribution scores", () => {
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR
  const scores = async (query = "") => {
    const { status, body } = await (await as("ada")).json(`/api/changes/scores${query}`)
    expect(status).toBe(200)
    return body as { period: string; since: number | null; members: any[] }
  }
  const page = (at: number, login: string, name: string, extra: Partial<Seed> = {}): Seed => ({
    at,
    login,
    author: login?.toLowerCase() === "ada" ? "Ada Lovelace" : "Grace Hopper",
    repo: "vault-private",
    path: `notes/${name}.md`,
    slug: `resources/notes/${name}`,
    ...extra,
  })

  it("is for signed-in members only, and knows its periods", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/changes/scores`, { headers: { origin: SITE } })
    expect(response.status).toBe(401)
    expect((await (await as("ada")).json("/api/changes/scores?period=year")).status).toBe(422)
  })

  it("scores files in full and repeat changes less: files + 2 × √(changes − files)", () => {
    expect(contributionScore(1, 1)).toBe(1)
    expect(contributionScore(3, 7)).toBe(7)
    expect(contributionScore(2, 5)).toBe(5.5)
    expect(contributionScore(10, 10)).toBe(10)
    // Ties share a rank, and the next one skips it.
    const row = { added: 0, removed: 0, active_days: 1, last_at: 1, files_added: 0 }
    const created = { pages_created: 0, pages_edited: 0 }
    const ranked = rankScores([
      { login: "c", author: "Cy", files: 1, changes: 1, ...row, ...created },
      { login: "b", author: "Bo", files: 3, changes: 7, ...row, ...created },
      { login: "a", author: "Al", files: 7, changes: 7, ...row, ...created },
    ])
    expect(ranked.map((member) => [member.rank, member.login, member.score])).toEqual([
      [1, "a", 7],
      [1, "b", 7],
      [3, "c", 1],
    ])
  })

  it("ranks members by week, month and all time, and leaves out changes without a member", async () => {
    const now = Date.now()
    await seed(
      // Ada: three files this week, one of them changed three times; one more last month.
      page(now - HOUR, "ada", "a", { kind: "new" }),
      page(now - 2 * HOUR, "ada", "a"),
      page(now - 3 * DAY, "Ada", "a"),
      page(now - 2 * DAY, "ada", "b", { kind: "new" }),
      { ...page(now - 2 * DAY, "ada", "c"), path: "notes/c.pdf", slug: null, kind: "upload" },
      page(now - 20 * DAY, "ada", "d"),
      // Grace: one file this month, long ago two more.
      page(now - 10 * DAY, "grace", "g"),
      page(now - 90 * DAY, "grace", "h", { kind: "new" }),
      page(now - 90 * DAY, "grace", "i", { kind: "new" }),
      // Never ranked: the site's own commit, and work that isn't in the vault.
      page(now - HOUR, null as unknown as string, "x", { author: "hafezi members site" }),
      page(now - HOUR, "grace", "y", { state: "sent" }),
      page(now - HOUR, "grace", "z", { state: "discarded" }),
    )
    const week = await scores("?period=week")
    expect(week.period).toBe("week")
    expect(week.members).toHaveLength(1)
    expect(week.members[0]).toMatchObject({
      rank: 1,
      login: "ada",
      author: "Ada Lovelace",
      changes: 5,
      files: 3,
      score: contributionScore(3, 5),
      pages_created: 2,
      pages_edited: 2,
      files_added: 1,
    })
    expect(week.members[0].active_days).toBeGreaterThanOrEqual(2)
    expect(week.members[0].last_at).toBe(now - HOUR)
    const month = await scores("?period=month")
    expect(month.members.map((m) => [m.rank, m.login, m.files, m.changes])).toEqual([
      [1, "ada", 4, 6],
      [2, "grace", 1, 1],
    ])
    const all = await scores()
    expect(all.period).toBe("all")
    expect(all.since).toBeNull()
    expect(all.members.map((m) => [m.login, m.files, m.changes, m.score])).toEqual([
      ["ada", 4, 6, contributionScore(4, 6)],
      ["grace", 3, 3, 3],
    ])
    expect(JSON.stringify(all)).not.toContain("hafezi members site")
  })

  it("counts a bulk commit once per folder, not once per file", async () => {
    const now = Date.now()
    const bulk = "b".repeat(40)
    const rows: Seed[] = []
    // One import of 60 files into two folders, and an ordinary commit of two files.
    for (let i = 0; i < 60; i++)
      rows.push({
        at: now - DAY,
        login: "grace",
        author: "Grace Hopper",
        repo: "vault-private",
        path: `files/equipment/${i < 40 ? "laser" : "scope"}/manual-${i}.pdf`,
        kind: "new",
        commit_sha: bulk,
      })
    for (const name of ["a", "b"])
      rows.push(page(now - HOUR, "grace", name, { commit_sha: "c".repeat(40) }))
    await seed(...rows)
    const [grace] = (await scores("?period=week")).members
    expect(grace).toMatchObject({ files: 4, changes: 4, score: 4, files_added: 60 })
  })

  it("keeps a leaderboard for five minutes without asking the database again", async () => {
    const now = Date.now()
    await seed(page(now - HOUR, "ada", "a"))
    expect((await scores("?period=week")).members).toHaveLength(1)
    await seed(page(now - HOUR, "grace", "g"))
    expect((await scores("?period=week")).members).toHaveLength(1)
    // Another period is its own, and a fresh look sees the new change.
    expect((await scores("?period=month")).members).toHaveLength(2)
    resetScores()
    expect((await scores("?period=week")).members).toHaveLength(2)
  })
})
