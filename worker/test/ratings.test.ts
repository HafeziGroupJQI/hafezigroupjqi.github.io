import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM page_votes"),
    env.DB.prepare("DELETE FROM page_views"),
  ])
})

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
