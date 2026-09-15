import { SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { ORIGIN, member } from "./helpers"
import { upstreamCalls } from "./worker"

const PDF_SHA = "0123456789abcdef0123456789abcdef01234567"
const PDF = "/resources/files/equipment/laser/manual.pdf"

beforeEach(() => upstreamCalls.splice(0))

describe("private documents", () => {
  it("requires a session", async () => {
    expect((await SELF.fetch(ORIGIN + PDF)).status).toBe(401)
    expect(upstreamCalls).toEqual([])
  })

  it("streams a manifest document from GitHub once and then from the cache", async () => {
    const client = await member()
    const first = await client.fetch(PDF)
    expect(first.status).toBe(200)
    expect(first.headers.get("content-type")).toBe("application/pdf")
    expect(first.headers.get("content-disposition")).toBe('inline; filename="manual.pdf"')
    expect(first.headers.get("cache-control")).toBe("private, max-age=3600")
    expect(await first.text()).toBe("%PDF-1.4 laser")
    expect(upstreamCalls).toEqual([
      `https://api.github.com/repos/HafeziGroupJQI/vault-private/git/blobs/${PDF_SHA}`,
    ])
    const second = await client.fetch(PDF)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe("%PDF-1.4 laser")
    const partial = await client.fetch(PDF, { headers: { range: "bytes=0-3" } })
    expect(partial.status).toBe(206)
    expect(await partial.text()).toBe("%PDF")
    expect(upstreamCalls).toHaveLength(1)
  })

  it("reports an unavailable store and ignores unknown or synthetic paths", async () => {
    const client = await member()
    expect((await client.fetch("/resources/files/data/results.docx")).status).toBe(502)
    expect((await client.fetch("/resources/files/missing.pdf")).status).toBe(404)
    expect((await client.fetch(`/__docs/${PDF_SHA}`)).status).toBe(404)
    expect(upstreamCalls).toHaveLength(1)
  })
})
