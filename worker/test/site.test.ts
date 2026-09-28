import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { MEMBER_PAGES } from "../src/app"
import { ORIGIN, SITE, member } from "./helpers"

describe("the member edition behind /api/site", () => {
  it("serves pages, assets and the private search index to members, with private headers", async () => {
    const client = await member()
    for (const path of ["/", "/resources/notes", "/resources/assets/figure.svg", "/instruments"]) {
      const response = await client.fetch("/api/site" + path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive")
      expect(response.headers.get("vary")).toContain("Authorization")
    }
    expect((await client.fetch("/api/site/resources/notes")).headers.get("cache-control")).toBe(
      "private, no-store",
    )
    const index = (await (await client.fetch("/api/site/static/contentIndex.json")).json()) as any
    expect(index["equipment/santec-tsl"].title).toBe("Santec TSL tunable laser")
    expect((await client.fetch("/api/site/nowhere")).status).toBe(404)
  })

  it("caches only content-hashed scripts, so a deploy's entry script is never stale", async () => {
    const client = await member()
    const cache = async (path: string) =>
      (await client.fetch("/api/site" + path)).headers.get("cache-control")
    expect(await cache("/static/member-tools.js")).toBe("private, no-store")
    expect(await cache("/static/chunks/gpt-UBPAR44W.js")).toBe("private, max-age=3600")
    expect(await cache("/postscript-a66fbddf.js")).toBe("private, max-age=3600")
  })

  it("reports canonical paths instead of redirecting across origins", async () => {
    const client = await member()
    const html = await client.fetch("/api/site/resources/notes.html")
    expect(html.status).toBe(204)
    expect(html.headers.get("x-canonical-path")).toBe("/resources/notes")
    expect(html.headers.get("access-control-expose-headers")).toContain("x-canonical-path")
    const vault = await client.fetch("/api/site/vault")
    expect(vault.headers.get("x-canonical-path")).toBe("/resources/")
  })

  it("is read-only", async () => {
    const client = await member()
    expect((await client.fetch("/api/site/resources/notes", { method: "POST" })).status).toBe(405)
  })
})

describe("the Worker is not a website", () => {
  for (const page of ["/", "/resources/notes", ...MEMBER_PAGES, "/devices?tab=device&code=x"]) {
    it(`sends ${page} to the github.io site`, async () => {
      const response = await SELF.fetch(ORIGIN + page, { redirect: "manual" })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(new URL(page, SITE).toString())
    })
  }

  it("never sends a path that names another host off the site", async () => {
    for (const page of ["//evil.example/path", "/%5Cevil.example/", "///evil.example"]) {
      const response = await SELF.fetch(ORIGIN + page, { redirect: "manual" })
      expect(response.status).toBe(302)
      expect(new URL(response.headers.get("location")!).origin).toBe(new URL(SITE).origin)
    }
  })
})
