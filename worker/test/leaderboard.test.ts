import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { contributionScore, resetScores } from "../src/changes"
import {
  HOT_DECAY,
  hotScore,
  memberScore,
  rankPages,
  resetLeaderboards,
} from "../src/ratings/leaderboard"
import { isoDay } from "../src/ratings/views"
import { ORIGIN, SITE, as } from "./helpers"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NAMES: Record<string, string> = {
  ada: "Ada Lovelace",
  grace: "Grace Hopper",
  bo: "Bo Diddley",
  cy: "Cy Young",
  dee: "Dee Dee",
}

/** A merged change by `login` to a private page (its slug as the import writes it). */
const change = (at: number, login: string | null, slug: string, state = "merged") =>
  env.DB.prepare(
    `INSERT INTO changes (at, login, author, repo, path, slug, kind, state, source)
     VALUES (?, ?, ?, 'vault-private', ?, ?, 'edit', ?, 'git')`,
  ).bind(
    at,
    login,
    login ? NAMES[login] : "someone",
    `${slug.replace(/^resources\//, "")}.md`,
    slug,
    state,
  )
const vote = (path: string, login: string, value: number, at: number) =>
  env.DB.prepare("INSERT INTO page_votes (path, login, value, at) VALUES (?, ?, ?, ?)").bind(
    path,
    login,
    value,
    at,
  )
const view = (path: string, login: string, at: number) =>
  env.DB.prepare("INSERT INTO page_views (path, login, day) VALUES (?, ?, ?)").bind(
    path,
    login,
    isoDay(at),
  )

const board = async (query = "") => {
  const { status, body } = await (await as("ada")).json(`/api/leaderboard${query}`)
  expect(status).toBe(200)
  return body as { period: string; since: number | null; members: any[] }
}
const topPages = async (query = "") => {
  const { status, body } = await (await as("ada")).json(`/api/leaderboard/pages${query}`)
  expect(status).toBe(200)
  return body as { period: string; pages: any[]; hot_decay: number }
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM changes"),
    env.DB.prepare("DELETE FROM page_votes"),
    env.DB.prepare("DELETE FROM page_views"),
  ])
  resetScores()
  resetLeaderboards()
})

describe("leaderboard: members", () => {
  it("is for signed-in members only, and knows its periods", async () => {
    for (const path of ["/api/leaderboard", "/api/leaderboard/pages"]) {
      const response = await SELF.fetch(ORIGIN + path, { headers: { origin: SITE } })
      expect(response.status).toBe(401)
      expect((await (await as("ada")).json(`${path}?period=year`)).status).toBe(422)
    }
  })

  it("adds Karma and Reach from a page's votes and readers to its contributors' scores", async () => {
    const now = Date.now()
    const a = "resources/notes/a"
    const c = "resources/notes/c"
    await env.DB.batch([
      // Page a: Ada made 3 of its 4 changes this week, Grace 1. Shares 0.75 and 0.25.
      change(now - HOUR, "ada", a),
      change(now - 2 * HOUR, "ada", a),
      change(now - 3 * HOUR, "ada", a),
      change(now - 4 * HOUR, "grace", a),
      // Votes on a this week: Ada's own (+1, never counted for her), Grace +1, Bo +1, Cy −1:
      // net 2. For Ada 2 − 1 = 1, for Grace 2 − 1 = 1.
      vote(a, "ada", 1, now - HOUR),
      vote(a, "grace", 1, now - HOUR),
      vote(a, "bo", 1, now - HOUR),
      vote(a, "cy", -1, now - HOUR),
      // A vote last month counts for the month, not the week.
      vote(a, "dee", 1, now - 20 * DAY),
      // Readers of a this week: five members, each one fewer for the contributor among them.
      ...["ada", "grace", "bo", "cy", "dee"].map((login) => view(a, login, now)),
      // Bo's page c from two months ago: Ada upvoted it and read it this week.
      change(now - 60 * DAY, "bo", c),
      vote(c, "ada", 1, now - HOUR),
      view(c, "ada", now - DAY),
      // Work not merged credits no one.
      change(now - HOUR, "cy", "resources/notes/draft", "sent"),
      vote("resources/notes/draft", "ada", 1, now - HOUR),
    ])
    const week = await board("?period=week")
    expect(week.members.map((m) => [m.rank, m.login, m.total])).toEqual([
      [1, "ada", 7.1],
      [2, "bo", 3],
      [3, "grace", 2.6],
    ])
    const [ada, bo, grace] = week.members
    // Ada: contributions 1 file + 2·√2 = 3.8; karma 0.75 × 1 = 0.8; reach √(0.75 × 4) = √3 = 1.7;
    // total 3.8 + 2 × 0.8 + 1.7 = 7.1.
    expect(ada).toMatchObject({
      author: "Ada Lovelace",
      files: 1,
      changes: 3,
      score: 3.8,
      contributions: 3.8,
      karma: 0.8,
      reach: 1.7,
      total: 7.1,
      credited_votes: 0.75,
      credited_readers: 3,
    })
    // Grace: 1 + 2 × 0.3 (0.25 × 1) + √(0.25 × 4) = 1 + 0.6 + 1 = 2.6.
    expect(grace).toMatchObject({ contributions: 1, karma: 0.3, reach: 1, total: 2.6 })
    // Bo changed nothing this week, but his page was upvoted and read: 0 + 2 × 1 + √1 = 3.
    expect(bo).toMatchObject({
      author: "Bo Diddley",
      files: 0,
      changes: 0,
      last_at: null,
      contributions: 0,
      karma: 1,
      reach: 1,
      total: 3,
    })
    // The month takes Dee's vote too: net 3 on a, 2 without each contributor's own.
    const month = await board("?period=month")
    expect(month.members.find((m) => m.login === "ada")).toMatchObject({
      credited_votes: 1.5,
      karma: 1.5,
    })
  })

  it("takes a member's karma down with downvotes, and ties share a rank", async () => {
    const now = Date.now()
    await env.DB.batch([
      change(now - HOUR, "ada", "resources/a"),
      change(now - HOUR, "grace", "resources/b"),
      change(now - HOUR, "cy", "resources/c"),
      vote("resources/b", "ada", -1, now - HOUR),
      vote("resources/b", "bo", -1, now - HOUR),
      vote("resources/c", "bo", 1, now - HOUR),
      vote("resources/c", "ada", -1, now - HOUR),
    ])
    const { members } = await board("?period=week")
    expect(members.map((m) => [m.rank, m.login, m.karma, m.total])).toEqual([
      [1, "ada", 0, 1],
      [1, "cy", 0, 1],
      [3, "grace", -2, -3],
    ])
  })

  it("credits a folder's page from its index file, and the home page from index", async () => {
    const now = Date.now()
    await env.DB.batch([
      change(now - HOUR, "ada", "resources/notes/index"),
      change(now - HOUR, "grace", "index"),
      vote("resources/notes", "bo", 1, now - HOUR),
      vote("index", "bo", 1, now - HOUR),
    ])
    const { members } = await board("?period=week")
    expect(members.map((m) => [m.login, m.karma])).toEqual([
      ["ada", 1],
      ["grace", 1],
    ])
  })

  it("rounds each part, and adds the rounded parts", () => {
    expect(memberScore(3.8, { votes: 0.75, readers: 3 })).toEqual({
      karma: 0.8,
      reach: 1.7,
      total: 7.1,
    })
    expect(memberScore(0, { votes: -0.25, readers: 0 })).toEqual({
      karma: -0.2,
      reach: 0,
      total: -0.4,
    })
    expect(contributionScore(1, 3)).toBe(3.8)
  })

  it("keeps a leaderboard five minutes, and a vote shows on its isolate's at once", async () => {
    const now = Date.now()
    await env.DB.batch([change(now - HOUR, "ada", "resources/notes")])
    expect((await board("?period=week")).members[0].karma).toBe(0)
    await env.DB.batch([vote("resources/notes", "bo", 1, now)])
    expect((await board("?period=week")).members[0].karma).toBe(0)
    const response = await (
      await as("grace")
    ).json("/api/ratings", {
      method: "PUT",
      body: JSON.stringify({ path: "resources/notes", value: 1 }),
    })
    expect(response.status).toBe(200)
    expect((await board("?period=week")).members[0].karma).toBe(2)
  })
})

describe("leaderboard: top pages", () => {
  it("ranks like reddit's hot: ten times the votes for each period of age", () => {
    const now = Date.UTC(2026, 9, 4)
    const week = HOT_DECAY.week
    expect(hotScore(10, now, now, week)).toBe(1)
    expect(hotScore(1, now, now, week)).toBe(0)
    expect(hotScore(0, now, now, week)).toBe(0)
    expect(hotScore(-100, now, now, week)).toBe(-2)
    expect(hotScore(10, now - week, now, week)).toBe(0)
    expect(hotScore(1, now - week / 2, now, week)).toBe(-0.5)
    // Equal hot scores go by readers, then votes, then path.
    const row = { first_vote: now, first_day: null }
    const ranked = rankPages(
      [
        { path: "b", up: 1, down: 0, viewers: 2, ...row },
        { path: "a", up: 0, down: 0, viewers: 2, ...row },
        { path: "c", up: 0, down: 0, viewers: 5, ...row },
        { path: "index", up: 10, down: 0, viewers: 0, ...row },
      ],
      now,
      week,
    )
    expect(ranked.map((page) => [page.path, page.href, page.hot])).toEqual([
      ["index", "/", 1],
      ["c", "/c", 0],
      ["b", "/b", 0],
      ["a", "/a", 0],
    ])
  })

  it("lists the period's voted and read pages, by votes and how recent they are", async () => {
    const now = Date.now()
    const ups = (path: string, n: number, at: number) =>
      Array.from({ length: n }, (_, i) => vote(path, `m${i}`, 1, at))
    await env.DB.batch([
      // Ten upvotes six days ago, against two today and one down.
      ...ups("resources/old", 10, now - 6 * DAY),
      ...ups("resources/new", 2, now - HOUR),
      vote("resources/new", "cy", -1, now - HOUR),
      // Read only, by three members yesterday: its age runs from that day's start.
      ...["ada", "bo", "cy"].map((login) => view("resources/read", login, now - DAY)),
      view("resources/new", "ada", now),
      // Last month's votes are not this week's.
      ...ups("resources/gone", 5, now - 20 * DAY),
    ])
    const { pages, period, hot_decay } = await topPages("?period=week")
    expect(period).toBe("week")
    expect(hot_decay).toBe(7 * DAY)
    // Ten votes six days ago (1 − 6/7) still beat one net vote now (0 − 1 hour), and that beats
    // none a day or two ago.
    expect(pages.map((page) => [page.rank, page.path, page.score, page.viewers])).toEqual([
      [1, "resources/old", 10, 0],
      [2, "resources/new", 1, 1],
      [3, "resources/read", 0, 3],
    ])
    expect(pages[0].hot).toBeCloseTo(1 - 6 / 7, 3)
    expect(pages[1]).toMatchObject({ up: 2, down: 1, href: "/resources/new" })
    // All time takes in the month-old page; a year is its unit of age there.
    const all = await topPages()
    expect(all.pages.map((page) => page.path)).toEqual([
      "resources/old",
      "resources/gone",
      "resources/new",
      "resources/read",
    ])
  })
})
