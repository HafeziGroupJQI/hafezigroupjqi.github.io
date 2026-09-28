import { SELF, env } from "cloudflare:test"
import { beforeAll, describe, expect, it } from "vitest"
import { issueLabTicket } from "../src/compute/tokens"
import { ORIGIN, as, auditRows } from "./helpers"

// Hafezi GPT in the lab's own panel: the lab origin (this Worker's origin, ORIGIN here) calls
// /lab/<ticket>/hafezi-gpt/api/gpt/..., with the lab ticket as its only credential.

const exp = () => Math.floor(Date.now() / 1000) + 3600

function lab(ticket: string) {
  const base = `${ORIGIN}/lab/${ticket}/hafezi-gpt/api/gpt`
  return (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    SELF.fetch(base + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.method && init.method !== "GET" ? { origin: ORIGIN } : {}),
        ...(init.headers ?? {}),
      },
    })
}

function events(text: string) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => chunk.match(/^event: (.*)$/m)?.[1])
}

describe("Hafezi GPT on the lab origin", () => {
  let own: string
  beforeAll(async () => {
    own = await issueLabTicket(env as any, { login: "Lena", role: "member", exp: exp() }, "lena")
  })

  it("chats as the lab's own member, in the same conversations as the site", async () => {
    const call = lab(own)
    const boot = await call("/bootstrap")
    expect(boot.status).toBe(200)
    expect(((await boot.json()) as any).models.length).toBeGreaterThan(0)

    const created = await call("/conversations", {
      method: "POST",
      body: JSON.stringify({ origin_slug: "scratchpad" }),
    })
    expect(created.status).toBe(201)
    const chat = (await created.json()) as any
    expect(chat).toMatchObject({ owner: "lena" })

    const turn = await call(`/conversations/${chat.id}/messages`, {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: JSON.stringify({
        text: "Why does my fit diverge?",
        context: { label: "fit.ipynb · cell 3 (Python 3)", text: "curve_fit(f, x, y)" },
      }),
    })
    expect(turn.status).toBe(200)
    expect(turn.headers.get("content-type")).toContain("text/event-stream")
    expect(events(await turn.text())).toContain("done")

    // The site's own app sees the same chat, with the cell chip.
    const site = await as("lena")
    const listed = await site.json("/api/gpt/conversations")
    expect(listed.body.map((c: any) => c.id)).toContain(chat.id)
    const opened = await site.json(`/api/gpt/conversations/${chat.id}`)
    expect(opened.body.turns[0].context).toEqual({ label: "fit.ipynb · cell 3 (Python 3)" })
    const rows = await auditRows("login = 'lena' AND action = 'gpt.message'")
    expect(rows.length).toBeGreaterThan(0)
  })

  it("is refused in a lab an owner opened for another member", async () => {
    const other = await issueLabTicket(
      env as any,
      { login: "olivia", role: "owner", exp: exp() },
      "lena",
    )
    const response = await lab(other)("/bootstrap")
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      detail: "Hafezi GPT is available in your own lab only",
    })
  })

  it("takes writes only from the lab page itself, and only with a valid ticket", async () => {
    const call = lab(own)
    const post = (headers: Record<string, string>) =>
      call("/conversations", { method: "POST", body: "{}", headers })
    expect((await post({ origin: "https://evil.example" })).status).toBe(403)
    expect((await post({ origin: "https://public.example" })).status).toBe(403)
    const bare = await SELF.fetch(`${ORIGIN}/lab/${own}/hafezi-gpt/api/gpt/conversations`, {
      method: "POST",
      body: "{}",
    })
    expect(bare.status).toBe(403)
    expect((await lab(own.slice(0, -2) + "xx")("/bootstrap")).status).toBe(401)
    expect((await call("/bootstrap", { headers: { "service-worker": "script" } })).status).toBe(403)
    // Only the GPT API is reachable this way.
    expect((await SELF.fetch(`${ORIGIN}/lab/${own}/hafezi-gpt/api/admin/audit`)).status).toBe(403)
  })
})
