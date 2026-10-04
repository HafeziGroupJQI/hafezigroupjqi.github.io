import { env } from "cloudflare:test"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { resetScores } from "../src/changes"
import { as, setAcl } from "./helpers"

// The site's activity (/recent, contributions, a page's pending changes): changes to restricted
// files are left out entirely for members outside their group, whether the site or the deploy's
// git import recorded them; a commit's other files still show. Scores count every change.

const COMMIT = "c0ffee0000000000000000000000000000000000"

async function seed(rows: Record<string, unknown>[]) {
  for (const [i, row] of rows.entries()) {
    const full: Record<string, unknown> = {
      at: 1_000_000 + i * 1000,
      login: "anishgoyal1108",
      author: "Anish Goyal",
      repo: "vault-private",
      kind: "edit",
      state: "merged",
      summary: "",
      source: "git",
      ...row,
    }
    const columns = Object.keys(full)
    await env.DB.prepare(
      `INSERT INTO changes (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
      .bind(...columns.map((c) => full[c]))
      .run()
  }
}

beforeAll(() => setAcl())
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM changes").run()
  resetScores()
  await seed([
    { path: "notes/meeting.md", summary: "minutes", commit_sha: COMMIT },
    {
      repo: "vault-optical-rl",
      path: "projects/optical-rl/notes/plan.qmd",
      slug: "resources/projects/optical-rl/notes/plan",
      summary: "optical rl microring policy",
      commit_sha: COMMIT,
    },
    {
      path: "projects/optical-rl/notes/old.md",
      source: "site",
      state: "sent",
      summary: "ppo plan draft",
      pr_number: 4,
    },
    {
      kind: "rename",
      from_path: "projects/optical-rl/notes/moved.md",
      path: "notes/moved.md",
      summary: "move out of optical rl",
    },
    { repo: "vault", path: "content/people/anish-goyal.md", kind: "profile", state: "merged" },
  ])
})

const feed = async (login: string, query = "", role: "member" | "owner" = "member") => {
  const { status, body } = await (await as(login, role)).json(`/api/changes${query}`)
  expect(status).toBe(200)
  return body as { changes: any[]; next: string | null }
}

describe("restricted changes in the activity feed", () => {
  it("are left out for a member outside the group, every trace of them", async () => {
    const { changes, next } = await feed("outsider")
    expect(changes.map((c) => c.path)).toEqual([
      "content/people/anish-goyal.md",
      "notes/meeting.md",
    ])
    expect(next).toBeNull()
    expect(JSON.stringify(changes)).not.toMatch(/optical|microring|ppo/i)
    // Filters too: a member's contributions, one file, the restricted vault's repository.
    expect((await feed("outsider", "?login=anishgoyal1108")).changes).toHaveLength(2)
    expect(await feed("outsider", "?path=projects/optical-rl/notes/plan.qmd")).toEqual({
      changes: [],
      next: null,
    })
    expect((await feed("outsider", "?repo=vault-optical-rl")).changes).toEqual([])
  })

  it("are there for the group and admins", async () => {
    for (const [login, role] of [
      ["mjalalim3", "member"],
      ["boss", "owner"],
    ] as const) {
      const { changes } = await feed(login, "", role)
      expect(changes).toHaveLength(5)
      expect(changes.find((c) => c.repo === "vault-optical-rl").commit.url).toBe(
        `https://github.com/HafeziGroupJQI/vault-optical-rl/commit/${COMMIT}`,
      )
    }
  })

  it("page past what a member may not see", async () => {
    await env.DB.prepare("DELETE FROM changes").run()
    const rows = []
    for (let i = 0; i < 30; i++)
      rows.push({ path: `projects/optical-rl/notes/n${i}.md`, summary: "optical" })
    rows.unshift({ path: "notes/first.md" })
    rows.push({ path: "notes/last.md" })
    await seed(rows)
    const first = await feed("outsider", "?limit=1")
    expect(first.changes.map((c) => c.path)).toEqual(["notes/last.md"])
    expect(first.next).not.toBeNull()
    const second = await feed("outsider", `?limit=1&before=${first.next}`)
    expect(second.changes.map((c) => c.path)).toEqual(["notes/first.md"])
    expect(second.next).toBeNull()
  })

  it("still count in each member's scores, which name no page", async () => {
    const outsider = await (await as("outsider")).json("/api/changes/scores?period=all")
    const member = await (await as("mjalalim3")).json("/api/changes/scores?period=all")
    expect(outsider.body.members).toEqual(member.body.members)
    const anish = outsider.body.members.find((m: any) => m.login === "anishgoyal1108")
    // Merged changes, the restricted vault's included (the sent draft isn't merged yet).
    expect(anish.changes).toBe(4)
    expect(JSON.stringify(outsider.body)).not.toMatch(/optical|microring|ppo|projects\//i)
  })
})
