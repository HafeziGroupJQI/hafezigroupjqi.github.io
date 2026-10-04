import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isoDay, pagePath, resetViews } from "../src/ratings/views"
import { as } from "./helpers"

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM page_votes"),
    env.DB.prepare("DELETE FROM page_views"),
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
