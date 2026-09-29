import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { issueLabTicket } from "../src/compute/tokens"
import { ORIGIN, as, auditRows } from "./helpers"
import worker, { anthropicCalls, anthropicScript } from "./worker"

type Client = Awaited<ReturnType<typeof as>>

function parseSse(text: string) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const name = chunk.match(/^event: (.*)$/m)?.[1] ?? "message"
      const data = chunk.match(/^data: (.*)$/m)?.[1]
      return { name, data: data ? JSON.parse(data) : null }
    })
}

/** Call the Worker with ANTHROPIC_API_KEY set, so turns go to the scripted Claude stub. */
async function keyed(
  client: Client,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
  overrides: Record<string, string> = {},
) {
  const ctx = createExecutionContext()
  const response = await (worker as ExportedHandler).fetch!(
    new Request(ORIGIN + path, {
      ...init,
      headers: { ...client.headers, ...(init.headers ?? {}) },
    }) as any,
    { ...env, ANTHROPIC_API_KEY: "test-key", ...overrides } as any,
    ctx,
  )
  const text = await response.text()
  await waitOnExecutionContext(ctx)
  return {
    status: response.status,
    text,
    events: response.headers.get("content-type")?.includes("event-stream") ? parseSse(text) : [],
  }
}

async function send(client: Client, id: string, body: object) {
  const response = await client.fetch(`/api/gpt/conversations/${id}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    text,
    events: response.headers.get("content-type")?.includes("event-stream") ? parseSse(text) : [],
  }
}

async function newChat(client: Client, body: object = {}) {
  const created = await client.json("/api/gpt/conversations", {
    method: "POST",
    body: JSON.stringify(body),
  })
  expect(created.status).toBe(201)
  return created.body as {
    id: string
    model: string
    origin_slug: string | null
    project_id: string | null
  }
}

async function uploadTo(
  client: Client,
  path: string,
  name: string,
  type: string,
  content: string | Uint8Array,
) {
  const form = new FormData()
  form.append("file", new File([content], name, { type }))
  return SELF.fetch(ORIGIN + path, {
    method: "POST",
    headers: { authorization: client.headers.authorization, origin: client.headers.origin },
    body: form,
  })
}

beforeEach(() => {
  anthropicCalls.splice(0)
  anthropicScript.splice(0)
})

describe("Hafezi GPT bootstrap and lookup", () => {
  it("lists models, skills, topics and the member's usage", async () => {
    const alice = await as("alice")
    const { status, body } = await alice.json("/api/gpt/bootstrap")
    expect(status).toBe(200)
    expect(body.models.map((m: any) => m.id)).toEqual(["claude-sonnet-5", "claude-opus-5-5"])
    expect(body.default_model).toBe("claude-sonnet-5")
    expect(body.skills.map((s: any) => s.name)).toContain("scpi-helper")
    expect(body.topics.project).toEqual([{ tag: "project/topo-automation", count: 2 }])
    expect(body.usage).toEqual({ used: 0, budget: null, cost_usd: 0 })
    expect(body.offline).toBe(true)
  })

  it("finds pages and private documents for @-mentions, never tag listings", async () => {
    const alice = await as("alice")
    const { body } = await alice.json("/api/gpt/pages?q=santec")
    expect(body[0]).toMatchObject({ ref: "equipment/santec-tsl", kind: "page" })
    expect(body.some((r: any) => r.ref.startsWith("tags/"))).toBe(false)
    const docs = await alice.json("/api/gpt/pages?q=manual")
    expect(docs.body).toContainEqual(
      expect.objectContaining({
        ref: "resources/files/equipment/laser/manual.pdf",
        kind: "document",
      }),
    )
  })
})

describe("projects", () => {
  it("keeps private projects private and lets only the owner or an admin edit group ones", async () => {
    const alice = await as("alice")
    const bob = await as("bob")
    const secret = await alice.json("/api/gpt/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Mine", visibility: "private" }),
    })
    const shared = await alice.json("/api/gpt/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Topo automation",
        visibility: "group",
        topics: ["project/topo-automation"],
        pinned: ["equipment/santec-tsl"],
      }),
    })
    expect(shared.status).toBe(201)
    expect((await bob.fetch(`/api/gpt/projects/${secret.body.id}`)).status).toBe(404)
    const listed = await bob.json("/api/gpt/projects")
    expect(listed.body.map((p: any) => p.id)).toContain(shared.body.id)
    expect(listed.body.map((p: any) => p.id)).not.toContain(secret.body.id)

    const detail = await bob.json(`/api/gpt/projects/${shared.body.id}`)
    expect(detail.body.can_edit).toBe(false)
    expect(detail.body.knowledge.included.map((i: any) => i.slug)).toEqual([
      "equipment/santec-tsl",
      "resources/library/instrument-control-and-calibration",
      "resources/projects/topo-automation-plan",
    ])
    expect(
      (
        await bob.fetch(`/api/gpt/projects/${shared.body.id}`, {
          method: "PUT",
          body: JSON.stringify({ name: "Hijacked" }),
        })
      ).status,
    ).toBe(403)
    const owner = await as("olivia", "owner")
    expect(
      (
        await owner.fetch(`/api/gpt/projects/${shared.body.id}`, {
          method: "PUT",
          body: JSON.stringify({ name: "Renamed", visibility: "group" }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await alice.json("/api/gpt/projects", {
          method: "POST",
          body: JSON.stringify({ name: "Bad", pinned: ["nowhere"] }),
        })
      ).status,
    ).toBe(422)
    const rows = await auditRows("login = 'alice' AND action = 'gpt.project.create'")
    expect(rows).toHaveLength(2)
  })
})

describe("offline turns (no API key)", () => {
  it("streams a reply, stores both turns, titles the chat and audits metadata only", async () => {
    const alice = await as("alice")
    const chat = await newChat(alice)
    expect(chat.model).toBe("claude-sonnet-5")
    const { status, events } = await send(alice, chat.id, {
      text: "How do I sweep the Santec laser?",
      mentions: ["equipment/santec-tsl"],
    })
    expect(status).toBe(200)
    expect(events.map((e) => e.name)).toEqual(["start", "delta", "turn", "usage", "title", "done"])
    expect(events[1].data.text).toContain(
      "[Santec TSL tunable laser](https://public.example/equipment/santec-tsl)",
    )
    const { body } = await alice.json(`/api/gpt/conversations/${chat.id}`)
    expect(body.access).toBe("owner")
    expect(body.conversation.title).toBe("How do I sweep the Santec laser?")
    expect(body.turns.map((t: any) => t.role)).toEqual(["user", "assistant"])
    expect(body.turns[0].mentions[0]).toMatchObject({ ref: "equipment/santec-tsl", kind: "page" })
    const [row] = await auditRows(
      "login = 'alice' AND action = 'gpt.message' AND target = ?",
      chat.id,
    )
    const detail = JSON.parse(row.detail_json)
    expect(detail.mentions).toEqual(["equipment/santec-tsl"])
    expect(row.detail_json).not.toContain("sweep")
  })

  it("rejects unknown mentions and files from elsewhere before streaming", async () => {
    const alice = await as("alice")
    const chat = await newChat(alice)
    expect((await send(alice, chat.id, { text: "hi", mentions: ["no/such/page"] })).status).toBe(
      422,
    )
    expect((await send(alice, chat.id, { text: "hi", files: ["f_nope"] })).status).toBe(404)
    expect((await send(alice, chat.id, { text: "" })).status).toBe(422)
  })

  it("enforces the monthly budget", async () => {
    const bea = await as("bea")
    const owner = await as("olivia", "owner")
    await owner.json("/api/admin/budgets/bea", {
      method: "PUT",
      body: JSON.stringify({ monthly_tokens: 100 }),
    })
    await env.DB.prepare(
      "INSERT INTO gpt_usage (login, month, input, output) VALUES ('bea', ?, 90, 20)",
    )
      .bind(new Date().toISOString().slice(0, 7))
      .run()
    const chat = await newChat(bea)
    const res = await send(bea, chat.id, { text: "hello" })
    expect(res.status).toBe(402)
  })
})

// About 1 s, but past vitest's 5 s default on a loaded machine.
describe("chat history and sharing", { timeout: 20_000 }, () => {
  it("keeps chats private until shared, read-only for readers, and forks to continue", async () => {
    const alice = await as("alice-share")
    const bob = await as("bob-share")
    const carol = await as("carol-share")
    const chat = await newChat(alice, { origin_slug: "/equipment/santec-tsl/" })
    expect(chat.origin_slug).toBe("equipment/santec-tsl")
    await send(alice, chat.id, { text: "What is this laser used for?" })

    expect((await bob.fetch(`/api/gpt/conversations/${chat.id}`)).status).toBe(404)
    expect(
      (
        await alice.json(`/api/gpt/conversations/${chat.id}/shares`, {
          method: "POST",
          body: JSON.stringify({ grantee: "@bob-share" }),
        })
      ).status,
    ).toBe(201)
    const seen = await bob.json(`/api/gpt/conversations/${chat.id}`)
    expect(seen.body.access).toBe("shared")
    expect(seen.body.shares).toEqual([])
    expect((await carol.fetch(`/api/gpt/conversations/${chat.id}`)).status).toBe(404)
    expect((await send(bob, chat.id, { text: "me too" })).status).toBe(403)
    expect(
      (
        await bob.fetch(`/api/gpt/conversations/${chat.id}/shares`, {
          method: "POST",
          body: JSON.stringify({ grantee: "*" }),
        })
      ).status,
    ).toBe(403)

    const shared = await bob.json("/api/gpt/conversations?scope=shared")
    expect(shared.body.map((c: any) => [c.id, c.shared_by])).toEqual([[chat.id, "alice-share"]])
    const byPage = await alice.json("/api/gpt/conversations?origin=equipment/santec-tsl")
    expect(byPage.body.map((c: any) => c.id)).toEqual([chat.id])

    await alice.json(`/api/gpt/conversations/${chat.id}/shares`, {
      method: "POST",
      body: JSON.stringify({ grantee: "*" }),
    })
    expect((await carol.fetch(`/api/gpt/conversations/${chat.id}`)).status).toBe(200)
    expect((await bob.json("/api/gpt/conversations?scope=shared")).body).toHaveLength(1)

    const fork = await bob.json(`/api/gpt/conversations/${chat.id}/fork`, { method: "POST" })
    expect(fork.status).toBe(201)
    const copy = await bob.json(`/api/gpt/conversations/${fork.body.id}`)
    expect(copy.body.access).toBe("owner")
    expect(copy.body.conversation.forked_from).toBe(chat.id)
    expect(copy.body.turns.map((t: any) => t.role)).toEqual(["user", "assistant"])
    expect((await send(bob, fork.body.id, { text: "follow-up" })).status).toBe(200)
    expect((await alice.json(`/api/gpt/conversations/${chat.id}`)).body.turns).toHaveLength(2)

    await alice.fetch(`/api/gpt/conversations/${chat.id}/shares/*`, { method: "DELETE" })
    await alice.fetch(`/api/gpt/conversations/${chat.id}/shares/bob-share`, { method: "DELETE" })
    expect((await bob.fetch(`/api/gpt/conversations/${chat.id}`)).status).toBe(404)
    const rows = await auditRows("login = 'alice-share' AND action LIKE 'gpt.%share'")
    expect(rows.map((r) => r.action)).toEqual([
      "gpt.share",
      "gpt.share",
      "gpt.unshare",
      "gpt.unshare",
    ])
  })
})

// About 1 s, but past vitest's 5 s default on a loaded machine.
describe("uploads", { timeout: 20_000 }, () => {
  it("stores text and PDF uploads per chat and refuses Office files", async () => {
    const alice = await as("alice-files")
    const chat = await newChat(alice)
    const text = await uploadTo(
      alice,
      `/api/gpt/conversations/${chat.id}/files`,
      "sweep.py",
      "text/x-python",
      "print('sweep')\n",
    )
    expect(text.status).toBe(201)
    const file = (await text.json()) as any
    expect(file.tokens_est).toBeGreaterThan(0)
    expect(await (await env.ARTIFACTS.get(file.r2_key))!.text()).toBe("print('sweep')\n")
    const docx = await uploadTo(
      alice,
      `/api/gpt/conversations/${chat.id}/files`,
      "notes.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "x",
    )
    expect(docx.status).toBe(415)
    const bob = await as("bob-files")
    expect((await bob.fetch(`/api/gpt/files/${file.id}`)).status).toBe(404)
    const sent = await send(alice, chat.id, { text: "What does this do?", files: [file.id] })
    expect(sent.status).toBe(200)
    const { body } = await alice.json(`/api/gpt/conversations/${chat.id}`)
    expect(body.turns[0].files).toEqual([{ id: file.id, name: "sweep.py", mime: "text/x-python" }])
  })

  it("serves uploads so they never run: text as plain text, images and PDFs as themselves", async () => {
    const alice = await as("alice-serve")
    const project = await alice.json("/api/gpt/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Figures", visibility: "group" }),
    })
    const add = async (name: string, type: string, content: string | Uint8Array) => {
      const response = await uploadTo(
        alice,
        `/api/gpt/projects/${project.body.id}/files`,
        name,
        type,
        content,
      )
      expect(response.status).toBe(201)
      return (await response.json()) as any
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'
    const html = await add("page.html", "text/html", "<script>alert(1)</script>")
    // The name says text, the type says SVG: it is stored as text, not as an active type.
    const disguised = await add("fig.txt", "image/svg+xml", svg)
    expect(disguised.mime).toBe("text/plain")
    const png = await add("plot.png", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const pdf = await add("notes.pdf", "text/html", "%PDF-1.4")
    expect(pdf.mime).toBe("application/pdf")
    // A file stored before this check, under the type its uploader claimed.
    await env.DB.prepare(
      `INSERT INTO gpt_files (id, project_id, conversation_id, owner, name, mime, size, r2_key,
         tokens_est, created_at) VALUES ('f_legacy_svg', ?, NULL, 'alice-serve', 'old.txt',
         'image/svg+xml', 10, ?, 1, 0)`,
    )
      .bind(project.body.id, disguised.r2_key)
      .run()

    const bob = await as("bob-serve")
    const served = async (id: string) => {
      const response = await bob.fetch(`/api/gpt/files/${id}`)
      expect(response.status).toBe(200)
      await response.arrayBuffer()
      return Object.fromEntries(
        ["content-type", "content-disposition", "content-security-policy"].map((h) => [
          h,
          response.headers.get(h),
        ]),
      )
    }
    const sandbox = "sandbox; default-src 'none'"
    for (const id of [html.id, disguised.id, "f_legacy_svg"])
      expect(await served(id)).toMatchObject({
        "content-type": "text/plain; charset=utf-8",
        "content-security-policy": sandbox,
      })
    expect(await served(png.id)).toEqual({
      "content-type": "image/png",
      "content-disposition": 'inline; filename="plot.png"',
      "content-security-policy": sandbox,
    })
    expect(await served(pdf.id)).toMatchObject({ "content-type": "application/pdf" })
    // A kind no longer accepted downloads instead of opening.
    await env.DB.prepare(
      "UPDATE gpt_files SET mime = 'application/x-msdownload', name = 'x' WHERE id = ?",
    )
      .bind(html.id)
      .run()
    expect(await served(html.id)).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="x"',
      "content-security-policy": sandbox,
    })
    expect(
      (await bob.fetch(`/api/gpt/files/${png.id}`)).headers.get("x-content-type-options"),
    ).toBe("nosniff")

    // The same file on the lab origin, where the lab ticket lives.
    const ticket = await issueLabTicket(
      env as any,
      { login: "alice-serve", role: "member", exp: Math.floor(Date.now() / 1000) + 3600 },
      "alice-serve",
    )
    const onLab = await SELF.fetch(
      `${ORIGIN}/lab/${ticket}/hafezi-gpt/api/gpt/files/${disguised.id}`,
    )
    expect(onLab.status).toBe(200)
    expect(onLab.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(onLab.headers.get("content-security-policy")).toBe(sandbox)
    expect(onLab.headers.get("x-content-type-options")).toBe("nosniff")
    await onLab.arrayBuffer()
  })
})

describe("skills", () => {
  it("merges repo and member skills and protects repo names", async () => {
    const alice = await as("alice-skills")
    const bob = await as("bob-skills")
    expect(
      (
        await alice.json("/api/gpt/skills", {
          method: "POST",
          body: JSON.stringify({ name: "scpi-helper", description: "x", body: "y" }),
        })
      ).status,
    ).toBe(409)
    const created = await alice.json("/api/gpt/skills", {
      method: "POST",
      body: JSON.stringify({
        name: "fit-ring",
        description: "Fit ring resonances to get Q.",
        body: "Use a Lorentzian.",
        visibility: "group",
      }),
    })
    expect(created.status).toBe(201)
    const listed = await bob.json("/api/gpt/skills")
    expect(listed.body.map((s: any) => [s.name, s.source])).toEqual([
      ["fit-ring", "member"],
      ["scpi-helper", "repo"],
    ])
    expect(
      (await bob.fetch(`/api/gpt/skills/${created.body.id}`, { method: "DELETE" })).status,
    ).toBe(403)
  })
})

describe("Claude turns (scripted API)", () => {
  it("sends a cache-friendly request, runs the tool loop, and returns cited answers", async () => {
    const alice = await as("alice-api")
    const owner = await as("olivia", "owner")
    const project = await alice.json("/api/gpt/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Topo",
        instructions: "Be brief.",
        visibility: "group",
        topics: ["project/topo-automation"],
      }),
    })
    const chat = await newChat(alice, { project_id: project.body.id })
    anthropicScript.push(
      {
        content: [
          { type: "thinking", thinking: "Look it up." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "search_site",
            input: { query: "santec wavelength" },
          },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 4000,
          cache_read_input_tokens: 0,
        },
      },
      (body: any) => {
        const results = body.messages.at(-1).content
        expect(results[0].type).toBe("tool_result")
        expect(results[0].content[0]).toMatchObject({
          type: "search_result",
          source: "https://public.example/equipment/santec-tsl",
          citations: { enabled: true },
        })
        return {
          content: [
            { type: "text", text: "Use WA to set the wavelength" },
            {
              type: "text",
              text: " (lab script tsl.py).",
              citations: [
                {
                  type: "search_result_location",
                  source: "https://public.example/equipment/santec-tsl",
                  title: "Santec TSL tunable laser",
                  cited_text: "sets wavelength with WA",
                  search_result_index: 0,
                  start_block_index: 0,
                  end_block_index: 0,
                },
              ],
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 150, output_tokens: 40, cache_read_input_tokens: 4000 },
        }
      },
    )
    const { status, events } = await keyed(alice, `/api/gpt/conversations/${chat.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "How do I set the Santec wavelength?" }),
    })
    expect(status).toBe(200)
    const names = events.map((e) => e.name)
    expect(names).toContain("thinking")
    expect(names).toContain("tool")
    expect(events.find((e) => e.name === "tool_result")!.data).toMatchObject({
      id: "tu_1",
      is_error: false,
    })
    expect(names.at(-1)).toBe("done")
    expect(events.find((e) => e.name === "title")!.data.title).toBe("Scripted title")

    const streamed = anthropicCalls.filter((c) => c.body.stream)
    expect(streamed).toHaveLength(2)
    const first = streamed[0].body
    expect(first.model).toBe("claude-sonnet-5")
    expect(first.cache_control).toEqual({ type: "ephemeral" })
    expect(first.thinking).toEqual({ type: "adaptive", display: "summarized" })
    expect(first.tools.map((t: any) => t.name)).toEqual([
      "search_site",
      "read_page",
      "list_pages",
      "read_file",
      "use_skill",
    ])
    expect(first.context_management).toEqual({ edits: [{ type: "compact_20260112" }] })
    expect(new Headers(streamed[0].headers).get("anthropic-beta")).toContain("compact-2026-01-12")
    // Persona+skills, then the project corpus with the only 1 h breakpoint, then who/when.
    const breakpoints = first.system.filter((b: any) => b.cache_control)
    expect(breakpoints).toEqual([
      expect.objectContaining({ cache_control: { type: "ephemeral", ttl: "1h" } }),
    ])
    expect(first.system[0].text).toContain("scpi-helper:")
    expect(first.system[1].text).toContain('<project name="Topo">')
    expect(first.system[1].text).toContain("Plan to automate transmission sweeps")
    expect(first.system[2].text).toContain("@alice-api")
    // The second request replays the first reply, thinking and all, unchanged.
    expect(streamed[1].body.messages[1].content[0]).toMatchObject({
      type: "thinking",
      thinking: "Look it up.",
      signature: "sig",
    })

    const { body } = await alice.json(`/api/gpt/conversations/${chat.id}`)
    const reply = body.turns[1]
    expect(reply.blocks.map((b: any) => b.type)).toEqual(["thinking", "tool", "text"])
    expect(reply.blocks[1]).toMatchObject({
      name: "search_site",
      summary: "Found 2 pages for “santec wavelength”",
    })
    expect(reply.blocks[2].text).toBe("Use WA to set the wavelength (lab script tsl.py).[^1]")
    expect(reply.blocks[2].citations[0]).toMatchObject({
      url: "https://public.example/equipment/santec-tsl",
      title: "Santec TSL tunable laser",
    })

    const usage = await owner.json("/api/admin/usage")
    const row = usage.body.members.find((m: any) => m.login === "alice-api")
    expect(row).toMatchObject({ input: 4250, output: 60, cache_read: 4000, cache_write: 4000 })
    expect(row.cost_usd).toBeGreaterThan(0)
  })

  it("puts the page a chat started on, and @-mentioned PDFs, in front of Claude", async () => {
    const alice = await as("alice-origin")
    const chat = await newChat(alice, {
      origin_slug: "equipment/santec-tsl",
      model: "claude-opus-5-5",
    })
    anthropicScript.push({
      content: [{ type: "text", text: "It sweeps." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    })
    await keyed(alice, `/api/gpt/conversations/${chat.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text: "What is this?",
        mentions: ["resources/files/equipment/laser/manual.pdf"],
      }),
    })
    const request = anthropicCalls.find((c) => c.body.stream)!.body
    expect(request.model).toBe("claude-opus-5-5")
    expect(request.output_config).toEqual({ effort: "high" })
    const content = request.messages[0].content
    expect(content[0].text).toContain("reading this page")
    expect(content[1]).toMatchObject({
      type: "document",
      title: "Santec TSL tunable laser",
      citations: { enabled: true },
    })
    expect(content[1].context).toContain("https://public.example/equipment/santec-tsl")
    expect(content[2]).toMatchObject({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: btoa("%PDF-1.4 laser") },
    })
    // Stored as a reference to an R2 snapshot, never as base64 in D1.
    const stored = await env.DB.prepare(
      "SELECT content_json FROM gpt_messages WHERE conversation_id = ? ORDER BY id LIMIT 1",
    )
      .bind(chat.id)
      .first<{ content_json: string }>()
    expect(stored!.content_json).toContain('"hafezi_blob"')
    expect(stored!.content_json).not.toContain(btoa("%PDF-1.4 laser"))
  })

  it("puts Scratchpad code context in front of Claude, and keeps only its label in history", async () => {
    const alice = await as("alice-scratch")
    const chat = await newChat(alice, { origin_slug: "scratchpad" })
    anthropicScript.push({
      content: [{ type: "text", text: "Use np.linspace." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 4 },
    })
    const context = {
      label: "analysis.ipynb · cell 3 (IPython · GDS)",
      text: "```python\nnp.arange(0, 1, 0.1\n```\n\nSyntaxError: '(' was never closed",
    }
    const sent = await keyed(alice, `/api/gpt/conversations/${chat.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Why does this fail?", context }),
    })
    expect(sent.status).toBe(200)
    const content = anthropicCalls.find((c) => c.body.stream)!.body.messages[0].content
    const texts = content.filter((b: any) => b.type === "text").map((b: any) => b.text)
    expect(texts.at(-2)).toContain("lab Scratchpad")
    expect(texts.at(-2)).toContain("analysis.ipynb · cell 3 (IPython · GDS):")
    expect(texts.at(-2)).toContain("SyntaxError: '(' was never closed")
    expect(texts.at(-1)).toBe("Why does this fail?")

    const view = await alice.json(`/api/gpt/conversations/${chat.id}`)
    const turn = (view.body as any).turns[0]
    expect(turn.context).toEqual({ label: context.label })
    expect(turn.text).toBe("Why does this fail?")
    // The audit log never gets message text, context included.
    expect(JSON.stringify(await auditRows("login = ?", "alice-scratch"))).not.toContain(
      "never closed",
    )

    const tooLong = await send(alice, chat.id, {
      text: "and this?",
      context: { label: "big", text: "x".repeat(40_001) },
    })
    expect(tooLong.status).toBe(413)
    const malformed = await send(alice, chat.id, {
      text: "and this?",
      context: { label: "no text" },
    })
    expect(malformed.status).toBe(422)
  })

  it("answers pending tool calls when it runs out of rounds, so history stays valid", async () => {
    const alice = await as("alice-rounds")
    const chat = await newChat(alice)
    for (let i = 0; i < 9; i++)
      anthropicScript.push({
        content: [
          { type: "tool_use", id: `tu_${i}`, name: "list_pages", input: { tag: "project" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      })
    const { events } = await keyed(alice, `/api/gpt/conversations/${chat.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "loop" }),
    })
    expect(events.at(-1)!.name).toBe("done")
    const rows = await env.DB.prepare(
      "SELECT role, content_json FROM gpt_messages WHERE conversation_id = ? ORDER BY id",
    )
      .bind(chat.id)
      .all<{ role: string; content_json: string }>()
    const last = rows.results.at(-1)!
    expect(last.role).toBe("user")
    expect(JSON.parse(last.content_json)[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_8",
      is_error: true,
    })
  })

  it("talks to the claude-bridge with the site's tools, pages, images and thinking, but no betas", async () => {
    const alice = await as("alice-bridge")
    const chat = await newChat(alice, {
      origin_slug: "equipment/santec-tsl",
      model: "claude-opus-5-5",
    })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const upload = await uploadTo(
      alice,
      `/api/gpt/conversations/${chat.id}/files`,
      "plot.png",
      "image/png",
      png,
    )
    const file = (await upload.json()) as any
    anthropicScript.push({
      content: [{ type: "text", text: "It is a tunable laser." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 6 },
    })
    const { events } = await keyed(
      alice,
      `/api/gpt/conversations/${chat.id}/messages`,
      { method: "POST", body: JSON.stringify({ text: "What is this?", files: [file.id] }) },
      { ANTHROPIC_BASE_URL: "https://bridge-example.trycloudflare.com" },
    )
    expect(events.at(-1)!.name).toBe("done")
    const request = anthropicCalls.find((c) => c.body.stream)!
    expect(request.url).toContain("bridge-example.trycloudflare.com")
    // The bridge emulates tool calls, so the site's tools go along (search_site, read_page, ...).
    expect(request.body.tools.map((t: any) => t.name)).toContain("search_site")
    expect(request.body.thinking).toEqual({ type: "adaptive", display: "summarized" })
    expect(request.body.output_config).toEqual({ effort: "high" })
    expect(request.body.context_management).toBeUndefined()
    expect(JSON.stringify(request.body.system)).not.toMatch(/no tools are available/)
    // The bridge passes images and PDFs to the model, and writes documents into its prompt.
    const content = request.body.messages[0].content
    const page = content.find((b: any) => b.type === "document")
    expect(page).toMatchObject({ title: "Santec TSL tunable laser", source: { type: "text" } })
    expect(page.source.data).toContain("swept-wavelength source")
    expect(content.find((b: any) => b.type === "image")).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
    })
    // No extra title request: the title comes from the message itself.
    expect(anthropicCalls.filter((c) => !c.body.stream)).toHaveLength(0)
  })
})
