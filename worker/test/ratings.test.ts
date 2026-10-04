import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { VOTES_PER_DAY } from "../src/ratings/routes"
import { isoDay, pagePath, resetViews } from "../src/ratings/views"
import { ORIGIN, SITE, as, auditRows } from "./helpers"

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM page_votes"),
    env.DB.prepare("DELETE FROM page_views"),
    env.DB.prepare("DELETE FROM audit_log WHERE action = 'rating.vote'"),
  ])
  resetViews()
})

const views = async () =>
  (
    await env.DB.prepare("SELECT path, login, day FROM page_views ORDER BY path, login").all<{
      path: string
      login: string
      day: string
    }>()
  ).results

describe("ratings: the tables", () => {
  it("keeps one vote of +1 or -1 per member and page, whatever the login's case", async () => {
    const vote = (login: string, value: number) =>
      env.DB.prepare("INSERT INTO page_votes (path, login, value, at) VALUES ('notes', ?, ?, 1)")
        .bind(login, value)
        .run()
    await vote("ada", 1)
    await expect(vote("Ada", -1)).rejects.toThrow()
    await expect(vote("grace", 2)).rejects.toThrow()
    await expect(vote("grace", 0)).rejects.toThrow()
  })

  it("keeps one view per member, page and day", async () => {
    const view = (login: string, day: string) =>
      env.DB.prepare("INSERT OR IGNORE INTO page_views (path, login, day) VALUES ('notes', ?, ?)")
        .bind(login, day)
        .run()
    await view("ada", "2026-10-04")
    await view("ADA", "2026-10-04")
    await view("ada", "2026-10-05")
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM page_views").first<{ n: number }>()
    expect(row?.n).toBe(2)
  })
})

describe("ratings: a page's readers", () => {
  it("keys a page by its site path, without slashes, .html or index", () => {
    expect(pagePath("/")).toBe("index")
    expect(pagePath("/index.html")).toBe("index")
    expect(pagePath("/resources/notes")).toBe("resources/notes")
    expect(pagePath("resources/notes/")).toBe("resources/notes")
    expect(pagePath("/resources/notes.html")).toBe("resources/notes")
    expect(pagePath("/resources/notes/index")).toBe("resources/notes")
    expect(pagePath("/research/index.html")).toBe("research")
    expect(pagePath("/people/ada%20lovelace")).toBe("people/ada lovelace")
    // An "index" inside a name is the name's own.
    expect(pagePath("/notes/reindex")).toBe("notes/reindex")
    for (const bad of ["/a/../b", "/a//b", "/%E0%A4%A", "/a\\b", "/a%00b", "/" + "x".repeat(600)])
      expect(pagePath(bad), bad).toBeNull()
  })

  it("records a member's day on each page they open, once, after answering", async () => {
    const ada = await as("ada")
    for (const path of ["/resources/notes", "/resources/notes", "/", "/resources/"])
      expect((await ada.fetch("/api/site" + path)).status, path).toBe(200)
    expect((await (await as("Grace")).fetch("/api/site/resources/notes")).status).toBe(200)
    const today = isoDay(Date.now())
    await vi.waitFor(async () => expect(await views()).toHaveLength(4))
    expect(await views()).toEqual([
      { path: "index", login: "ada", day: today },
      { path: "resources", login: "ada", day: today },
      { path: "resources/notes", login: "ada", day: today },
      { path: "resources/notes", login: "grace", day: today },
    ])
  })

  it("leaves out assets, missing pages, tool pages, HEAD requests and probe sessions", async () => {
    const ada = await as("ada")
    for (const path of [
      "/resources/assets/figure.svg",
      "/static/contentIndex.json",
      "/resources/notes.md",
      "/nowhere",
      "/calendar",
    ])
      await ada.fetch("/api/site" + path)
    await ada.fetch("/api/site/instruments", { method: "HEAD" })
    await (await as("probe-1a2b")).fetch("/api/site/resources/notes")
    // A page opened last lands after all of those: none of them wrote a row.
    await ada.fetch("/api/site/instruments")
    await vi.waitFor(async () => expect(await views()).toHaveLength(1))
    expect((await views()).map((row) => row.path)).toEqual(["instruments"])
  })
})

describe("ratings: GET and PUT /api/ratings", () => {
  const DAY = 86_400_000
  const vote = async (login: string, value: number, path = "/resources/notes") =>
    (await as(login)).json("/api/ratings", {
      method: "PUT",
      body: JSON.stringify({ path, value }),
    })
  const rating = async (login: string, path = "resources/notes") =>
    (await as(login)).json(`/api/ratings?${new URLSearchParams({ path })}`)

  it("is for signed-in members only", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/ratings?path=resources/notes`, {
      headers: { origin: SITE },
    })
    expect(response.status).toBe(401)
  })

  it("answers a page's rating and readers, its own and each member's", async () => {
    const today = Date.now()
    await env.DB.batch(
      [
        ["ada", today],
        ["ada", today - DAY],
        ["grace", today - 3 * DAY],
        ["bo", today - 10 * DAY],
      ].map(([login, at]) =>
        env.DB.prepare(
          "INSERT INTO page_views (path, login, day) VALUES ('resources/notes', ?, ?)",
        ).bind(login, isoDay(at as number)),
      ),
    )
    const { status, body } = await rating("ada", "/resources/notes/")
    expect(status).toBe(200)
    expect(body).toEqual({
      path: "resources/notes",
      score: 0,
      up: 0,
      down: 0,
      mine: 0,
      viewers: 3,
      views7: 2,
    })
  })

  it("is a 404 for anything that isn't a page a member reads", async () => {
    for (const path of [
      "/nowhere",
      "/resources/assets/figure.svg",
      "/static/contentIndex.json",
      "/calendar",
      "/a/../resources/notes",
    ]) {
      expect((await rating("ada", path)).status, path).toBe(404)
      expect((await vote("ada", 1, path)).status, path).toBe(404)
    }
    expect((await rating("ada", "")).status).toBe(422)
    // Folders' pages and the home page are pages.
    expect((await rating("ada", "/")).body.path).toBe("index")
    expect((await rating("ada", "/resources")).body.path).toBe("resources")
  })

  it("counts each member's one vote, changes it, and takes it back with 0", async () => {
    expect((await vote("ada", 1)).body).toMatchObject({ score: 1, up: 1, down: 0, mine: 1 })
    expect((await vote("grace", 1)).body).toMatchObject({ score: 2, up: 2, mine: 1 })
    expect((await vote("bo", -1)).body).toMatchObject({ score: 1, up: 2, down: 1, mine: -1 })
    // Ada changes her mind, then takes her vote back; the same vote twice is one.
    expect((await vote("Ada", -1)).body).toMatchObject({ score: -1, up: 1, down: 2, mine: -1 })
    expect((await vote("ada", -1)).body).toMatchObject({ score: -1, up: 1, down: 2, mine: -1 })
    expect((await vote("ada", 0)).body).toMatchObject({ score: 0, up: 1, down: 1, mine: 0 })
    expect((await vote("ada", 0)).body).toMatchObject({ score: 0, mine: 0 })
    expect((await rating("grace")).body).toMatchObject({ score: 0, up: 1, down: 1, mine: 1 })
    const rows = await env.DB.prepare("SELECT login, value FROM page_votes ORDER BY login").all()
    expect(rows.results).toEqual([
      { login: "bo", value: -1 },
      { login: "grace", value: 1 },
    ])
  })

  it("keeps when a vote was cast, unless it changes", async () => {
    await vote("ada", 1)
    const at = async () =>
      (await env.DB.prepare("SELECT at FROM page_votes WHERE login = 'ada'").first<{
        at: number
      }>())!.at
    const first = await at()
    await env.DB.prepare("UPDATE page_votes SET at = at - 1000").run()
    await vote("ada", 1)
    expect(await at()).toBe(first - 1000)
    await vote("ada", -1)
    expect(await at()).toBeGreaterThan(first - 1000)
  })

  it("leaves one row for votes sent at once", async () => {
    const ada = await as("ada")
    const values = [1, -1, 1, 0, -1, 1, 1, -1, 1, 1]
    const answers = await Promise.all(
      values.map((value) =>
        ada.fetch("/api/ratings", {
          method: "PUT",
          body: JSON.stringify({ path: "resources/notes", value }),
        }),
      ),
    )
    expect(answers.map((answer) => answer.status)).toEqual(values.map(() => 200))
    const rows = await env.DB.prepare("SELECT value FROM page_votes WHERE login = 'ada'").all()
    expect(rows.results.length).toBeLessThanOrEqual(1)
    const { body } = await rating("ada")
    expect(body.up + body.down).toBe(rows.results.length)
  })

  it("refuses votes that aren't up, down or none, and other origins", async () => {
    for (const value of [2, "1", null, true, undefined])
      expect((await vote("ada", value as number)).status).toBe(422)
    const ada = await as("ada")
    const response = await ada.fetch("/api/ratings", {
      method: "PUT",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ path: "resources/notes", value: 1 }),
    })
    expect(response.status).toBe(403)
    expect((await ada.fetch("/api/ratings", { method: "POST", body: "{}" })).status).toBe(405)
  })

  it("audits each vote and holds a member to VOTES_PER_DAY a day", async () => {
    await vote("ada", 1)
    const [row] = await auditRows("action = 'rating.vote' AND login = 'ada'")
    expect(row).toMatchObject({ target: "resources/notes", detail_json: '{"value":1}' })
    const at = Date.now()
    await env.DB.batch(
      Array.from({ length: VOTES_PER_DAY }, () =>
        env.DB.prepare(
          "INSERT INTO audit_log (at, login, action, target) VALUES (?, 'grace', 'rating.vote', 'x')",
        ).bind(at),
      ),
    )
    expect((await vote("grace", 1)).status).toBe(429)
  })
})
