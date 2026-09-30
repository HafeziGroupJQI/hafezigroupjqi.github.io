import { SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { historyPath } from "../src/history"
import { ORIGIN, SITE, as } from "./helpers"
import { upstreamBodies, upstreamCalls } from "./worker"

const REV = "1234567890abcdef1234567890abcdef12345678"
const CONTENTS = "https://api.github.com/repos/HafeziGroupJQI/vault-private/contents"

const file = (path: string, rev = REV, repo = "vault-private") =>
  `/api/history/file?${new URLSearchParams({ repo, rev, path })}`

beforeEach(() => upstreamCalls.splice(0))

describe("history: a private page as it was", () => {
  it("is for signed-in members only", async () => {
    const response = await SELF.fetch(ORIGIN + file("notes/meeting.md"), {
      headers: { origin: SITE },
    })
    expect(response.status).toBe(401)
    expect(upstreamCalls).toEqual([])
  })

  it("comes from GitHub once, as sandboxed text, then from the cache", async () => {
    const page = "---\ntitle: Lab meeting\n---\n\n<img src=x onerror=alert(1)>\n"
    upstreamBodies[`meeting.md?ref=${REV}`] = [200, page]
    const client = await as("ada")
    const first = await client.fetch(file("notes/meeting.md"))
    expect(first.status).toBe(200)
    expect(first.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(first.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
    expect(first.headers.get("x-content-type-options")).toBe("nosniff")
    expect(first.headers.get("cache-control")).toBe("private, no-store")
    expect(await first.text()).toBe(page)
    expect(upstreamCalls).toEqual([`${CONTENTS}/notes/meeting.md?ref=${REV}`])
    const second = await client.fetch(file("notes/meeting.md"))
    expect(await second.text()).toBe(page)
    expect(second.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
    expect(upstreamCalls).toHaveLength(1)
  })

  it("asks GitHub for the file's path part by part", async () => {
    upstreamBodies[`2026%20kickoff.qmd?ref=${REV}`] = [200, "qmd"]
    const client = await as("ada")
    const response = await client.fetch(file("journal-club/2026 kickoff.qmd"))
    expect(await response.text()).toBe("qmd")
    expect(upstreamCalls).toEqual([`${CONTENTS}/journal-club/2026%20kickoff.qmd?ref=${REV}`])
  })

  it("answers only for pages of the private vault at a commit", async () => {
    const client = await as("ada")
    for (const [path, rev, repo] of [
      ["notes/data.csv", REV, "vault-private"],
      ["code/guide/intro.nb", REV, "vault-private"],
      ["notes/README.md", REV, "vault-private"],
      [".github/workflows/validate.yml", REV, "vault-private"],
      ["notes/../tools/secret.md", REV, "vault-private"],
      ["tools/notes.md", REV, "vault-private"],
      ["notes/meeting.md", "main", "vault-private"],
      ["notes/meeting.md", REV.slice(0, 7), "vault-private"],
      ["content/index.md", REV, "vault"],
    ])
      expect((await client.fetch(file(path, rev, repo))).status, `${repo} ${path} ${rev}`).toBe(422)
    expect(upstreamCalls).toEqual([])
    expect(historyPath("code/run.ipynb")).toBe("code/run.ipynb")
  })

  it("says so when the page isn't in that revision", async () => {
    const client = await as("ada")
    const response = await client.json(file("notes/not-yet.md"))
    expect(response).toEqual({ status: 404, body: { detail: "that page isn't in that revision" } })
  })
})
