import { SELF, env } from "cloudflare:test"
import { beforeAll, describe, expect, it } from "vitest"
import { issueLabTicket } from "../src/compute/tokens"
import { MAX_TEXT, MAX_TURNS, labTranscript } from "../src/gpt/lab-chats"
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

  it("answers the coding agent's site tools as text", async () => {
    const call = lab(own)
    const specs = (await (await call("/tools")).json()) as any[]
    expect(specs.map((t) => t.name)).toEqual(["search_site", "read_page", "list_pages"])
    expect(specs[0].input_schema.required).toEqual(["query"])
    const tool = (name: string, input: object) =>
      call(`/tools/${name}`, { method: "POST", body: JSON.stringify(input) })
    const found = (await (await tool("search_site", { query: "santec laser" })).json()) as any
    expect(found.is_error).toBe(false)
    expect(found.text).toContain("## Santec TSL tunable laser")
    const page = (await (await tool("read_page", { page: "equipment/santec-tsl" })).json()) as any
    expect(page.text).toContain("# Santec TSL tunable laser")
    expect(page.text).toContain("swept-wavelength source")
    const missing = (await (await tool("read_page", { page: "no/such-page" })).json()) as any
    expect(missing.is_error).toBe(true)
    // Only these three: not the chat's uploads or skills.
    expect((await tool("read_file", { file_id: "f_1" })).status).toBe(404)
    expect((await tool("search_site", [])).status).toBe(422)
  })

  it("never gives an owner's lab admin rights over other members' projects", async () => {
    const alice = await as("alice-lab")
    const project = await alice.json("/api/gpt/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Shared", visibility: "group" }),
    })
    const owner = lab(
      await issueLabTicket(env as any, { login: "olga", role: "owner", exp: exp() }, "olga"),
    )
    const url = `/projects/${project.body.id}`
    const seen = (await (await owner(url)).json()) as any
    expect(seen.can_edit).toBe(false)
    expect((await owner(url, { method: "DELETE" })).status).toBe(403)
    const rename = { method: "PUT", body: JSON.stringify({ name: "Taken" }) }
    expect((await owner(url, rename)).status).toBe(403)
    // The same owner on the site is an admin there.
    expect((await (await as("olga", "owner")).fetch(`/api/gpt${url}`, rename)).status).toBe(200)
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

describe("the lab's AI chats, kept as Hafezi GPT conversations", () => {
  const chat = (title?: string) => ({
    messages: [
      { type: "msg", id: "0", body: "", sender: "Hafezi GPT", time: 1 },
      { type: "msg", id: "1", body: "Plot the ring resonance", sender: "user", time: 2 },
      { type: "msg", id: "2", body: "Adding a cell.", sender: "Hafezi GPT", time: 3 },
      { type: "msg", id: "3", body: "", sender: "Hafezi GPT", time: 4, mime_model: { data: {} } },
      { type: "msg", id: "4", body: "Done: it's cell 2.", sender: "Hafezi GPT", time: 5 },
      { type: "msg", id: "5", body: "Thanks", sender: "user", time: 6, attachments: ["0"] },
    ],
    users: {
      user: { username: "user", display_name: "User" },
      "Hafezi GPT": { username: "Hafezi GPT", display_name: "Hafezi GPT", bot: true },
    },
    attachments: { "0": { type: "notebook", value: "rings.ipynb" } },
    metadata: { provider: "hafezi", autosave: true, ...(title ? { title } : {}) },
  })

  it("saves a lab chat by name, restores it exactly, and shows its text in /gpt read-only", async () => {
    const ticket = await issueLabTicket(
      env as any,
      { login: "rhea", role: "member", exp: exp() },
      "rhea",
    )
    const call = lab(ticket)
    const name = encodeURIComponent("Hafezi GPT")
    expect((await call(`/lab-chats/${name}`)).status).toBe(404)
    const body = JSON.stringify(chat())
    const saved = await call(`/lab-chats/${name}`, { method: "PUT", body })
    expect(saved.status).toBe(200)
    const { conversation_id } = (await saved.json()) as any
    expect(await (await call(`/lab-chats/${name}`)).text()).toBe(body)

    // Saving again replaces the text rather than adding to it, and takes the lab's title.
    await call(`/lab-chats/${name}`, { method: "PUT", body: JSON.stringify(chat("Ring plots")) })
    expect(
      ((await (await call("/lab-chats")).json()) as any[]).map((c) => [c.name, c.title]),
    ).toEqual([["Hafezi GPT", "Ring plots"]])

    const site = await as("rhea")
    const listed = await site.json("/api/gpt/conversations")
    expect(listed.body.find((c: any) => c.id === conversation_id)).toMatchObject({
      lab_name: "Hafezi GPT",
      title: "Ring plots",
    })
    const opened = await site.json(`/api/gpt/conversations/${conversation_id}`)
    expect(opened.body.turns.map((t: any) => [t.role, t.text ?? t.blocks[0].text])).toEqual([
      ["user", "Plot the ring resonance"],
      ["assistant", "Adding a cell.\n\nDone: it's cell 2."],
      ["user", "Thanks"],
    ])
    const post = await site.fetch(`/api/gpt/conversations/${conversation_id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "more" }),
    })
    expect(post.status).toBe(409)
    // A fork is an ordinary chat that continues on the site.
    const fork = await site.json(`/api/gpt/conversations/${conversation_id}/fork`, {
      method: "POST",
    })
    expect(fork.body.lab_name ?? null).toBeNull()

    const gone = await call(`/lab-chats/${name}`, { method: "DELETE" })
    expect(gone.status).toBe(200)
    expect((await call(`/lab-chats/${name}`)).status).toBe(404)
    expect((await site.fetch(`/api/gpt/conversations/${conversation_id}`)).status).toBe(404)
  })

  it("reads a name typed two ways as one chat, and refuses invisible characters", async () => {
    const call = lab(
      await issueLabTicket(env as any, { login: "uma", role: "member", exp: exp() }, "uma"),
    )
    const put = (name: string) =>
      call(`/lab-chats/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify(chat()),
      })
    const composed = "Caf\u00e9"
    const decomposed = "Cafe\u0301"
    const first = (await (await put(decomposed)).json()) as any
    const second = (await (await put(` ${composed} `)).json()) as any
    expect(second).toMatchObject({ name: composed, conversation_id: first.conversation_id })
    expect(((await (await call("/lab-chats")).json()) as any[]).map((c) => c.name)).toEqual([
      composed,
    ])
    expect((await call(`/lab-chats/${encodeURIComponent(decomposed)}`)).status).toBe(200)
    // A right-to-left override or a zero-width space would pass for another chat's name.
    for (const name of ["txt.\u202eexe", "Caf\u200be", "a\u0085b", "\u2066x"])
      expect((await put(name)).status, JSON.stringify(name)).toBe(422)
  })

  it("leaves a chat's time alone when the lab saves it unchanged", async () => {
    const call = lab(
      await issueLabTicket(env as any, { login: "xan", role: "member", exp: exp() }, "xan"),
    )
    const body = JSON.stringify(chat("Same"))
    const put = async (text: string) =>
      (await (await call("/lab-chats/Kept", { method: "PUT", body: text })).json()) as any
    const first = await put(body)
    const updatedAt = async () =>
      (
        await env.DB.prepare("SELECT updated_at FROM gpt_conversations WHERE id = ?")
          .bind(first.conversation_id)
          .first<{ updated_at: number }>()
      )?.updated_at
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await put(body)).toEqual(first)
    expect(await updatedAt()).toBe(first.updated_at)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const changed = await put(JSON.stringify(chat("Changed")))
    expect(changed.updated_at).toBeGreaterThan(first.updated_at)
    expect(await updatedAt()).toBe(changed.updated_at)
  })

  it("creates only, never overwrites, when a save says If-None-Match: *", async () => {
    const call = lab(
      await issueLabTicket(env as any, { login: "vic", role: "member", exp: exp() }, "vic"),
    )
    const put = (name: string, title: string, headers: Record<string, string> = {}) =>
      call(`/lab-chats/${name}`, { method: "PUT", body: JSON.stringify(chat(title)), headers })
    const created = await put("Notes", "Mine", { "if-none-match": "*" })
    expect(created.status).toBe(200)
    // A rename onto a taken name: the lab's own chat stays as it was.
    await put("Other", "Theirs")
    const onto = await put("Notes", "Theirs", { "if-none-match": "*" })
    expect(onto.status).toBe(409)
    expect(((await (await call("/lab-chats/Notes")).json()) as any).metadata.title).toBe("Mine")
    // Without the header, a save still replaces the chat (autosave).
    expect((await put("Notes", "Revised")).status).toBe(200)
    expect(((await (await call("/lab-chats/Notes")).json()) as any).metadata.title).toBe("Revised")
  })

  it("keeps a save's d1 batch small: the latest turns, each of bounded length", async () => {
    const users = {
      user: { username: "user" },
      bot: { username: "bot", bot: true },
    }
    const msg = (sender: string, body: string) => ({ type: "msg", sender, body })
    const long = labTranscript(
      {
        messages: Array.from({ length: 1000 }, (_, i) => msg(i % 2 ? "bot" : "user", `m${i}`)),
        users,
      },
      "m",
    )
    expect(long.length).toBeLessThanOrEqual(MAX_TURNS)
    expect(long[0].role).toBe("user")
    expect((long.at(-1)!.content[0] as any).text).toBe("m999")
    // Hundreds of tool-call replies in a row merge into one message, which stays bounded.
    const chatty = labTranscript(
      {
        messages: [
          msg("user", "go"),
          ...Array.from({ length: 300 }, () => msg("bot", "x".repeat(2000))),
        ],
        users,
      },
      "m",
    )
    expect(chatty).toHaveLength(2)
    expect((chatty[1].content[0] as any).text.length).toBe(MAX_TEXT)
    // Saved as a whole, the chat still lands.
    const call = lab(
      await issueLabTicket(env as any, { login: "wes", role: "member", exp: exp() }, "wes"),
    )
    const saved = await call("/lab-chats/big", {
      method: "PUT",
      body: JSON.stringify({
        messages: Array.from({ length: 1000 }, (_, i) => msg(i % 2 ? "bot" : "user", `m${i}`)),
        users,
      }),
    })
    expect(saved.status).toBe(200)
  })

  it("keeps each member's lab chats apart and refuses bad names and bodies", async () => {
    const mine = lab(
      await issueLabTicket(env as any, { login: "sam", role: "member", exp: exp() }, "sam"),
    )
    const theirs = lab(
      await issueLabTicket(env as any, { login: "tess", role: "member", exp: exp() }, "tess"),
    )
    await mine("/lab-chats/shared-name", { method: "PUT", body: JSON.stringify(chat()) })
    expect((await theirs("/lab-chats/shared-name")).status).toBe(404)
    expect(await (await theirs("/lab-chats")).json()).toEqual([])
    expect((await mine("/lab-chats/.hidden", { method: "PUT", body: "{}" })).status).toBe(422)
    expect((await mine("/lab-chats/x", { method: "PUT", body: "not json" })).status).toBe(422)
    expect((await mine("/lab-chats/x", { method: "PUT", body: '{"messages": 1}' })).status).toBe(
      422,
    )
    const big = JSON.stringify({ ...chat(), pad: "x".repeat(5 * 1024 * 1024) })
    expect((await mine("/lab-chats/x", { method: "PUT", body: big })).status).toBe(413)
    // A chunked body has no length to check first: it is counted as it arrives.
    let sent = 0
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength
        controller.enqueue(chunk)
        if (sent > 64 * 1024 * 1024) controller.close()
      },
    })
    const chunked = await mine("/lab-chats/x", { method: "PUT", body: endless })
    expect(chunked.status).toBe(413)
    expect(sent).toBeLessThan(16 * 1024 * 1024)
  })
})
