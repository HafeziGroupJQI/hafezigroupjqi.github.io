import { SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { isPassiveType } from "../src/docs"
import { ORIGIN, member } from "./helpers"
import { upstreamCalls } from "./worker"

const PDF_SHA = "0123456789abcdef0123456789abcdef01234567"
const PDF = "/api/site/resources/files/equipment/laser/manual.pdf"

beforeEach(() => upstreamCalls.splice(0))

describe("private documents", () => {
  it("requires a bearer session", async () => {
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
    // Browsers won't show a PDF in a sandboxed document.
    expect(first.headers.get("content-security-policy")).toBeNull()
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
    // A notebook page's download link (?raw) saves the file.
    const raw = await client.fetch(`${PDF}?raw=1`)
    expect(raw.headers.get("content-disposition")).toBe('attachment; filename="manual.pdf"')
  })

  it("serves active types under a sandbox policy, by each path's own type", async () => {
    const client = await member()
    const svg = await client.fetch("/api/site/resources/files/figures/beam.svg")
    expect(svg.headers.get("content-type")).toBe("image/svg+xml")
    expect(svg.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff")
    // The members service worker re-issues the response with both (frontend/members/sw-route.js).
    expect(svg.headers.get("access-control-expose-headers")).toMatch(
      /content-security-policy.*x-content-type-options/,
    )
    expect(await svg.text()).toBe("<svg></svg>")
    // The same blob at a .txt path comes from the cache, but as plain text, which runs nothing.
    const text = await client.fetch("/api/site/resources/files/figures/beam.txt")
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(text.headers.get("content-security-policy")).toBeNull()
    expect(text.headers.get("x-content-type-options")).toBe("nosniff")
    expect(upstreamCalls).toHaveLength(1)
    // From the cache, the SVG keeps its policy.
    const again = await client.fetch("/api/site/resources/files/figures/beam.svg")
    expect(again.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
  })

  it("lets only PDFs, raster images, audio, video and plain text go unsandboxed", () => {
    for (const type of [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "audio/mpeg",
      "video/mp4",
      "text/plain; charset=utf-8",
    ])
      expect(isPassiveType(type), type).toBe(true)
    for (const type of [
      "image/svg+xml",
      "Image/SVG+XML; charset=utf-8",
      "text/html",
      "application/xhtml+xml",
      "text/xml",
      "application/xml",
      "application/octet-stream",
      "application/x-ipynb+json",
      "text/markdown; charset=utf-8",
      "",
    ])
      expect(isPassiveType(type), type).toBe(false)
  })

  it("reports an unavailable store and ignores unknown or synthetic paths", async () => {
    const client = await member()
    expect((await client.fetch("/api/site/resources/files/data/results.docx")).status).toBe(502)
    expect((await client.fetch("/api/site/resources/files/missing.pdf")).status).toBe(404)
    expect((await client.fetch(`/api/site/__docs/${PDF_SHA}`)).status).toBe(404)
    expect(upstreamCalls).toHaveLength(1)
  })
})
