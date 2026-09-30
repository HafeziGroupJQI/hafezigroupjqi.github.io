import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { issueLabTicket } from "../src/compute/tokens"
import { COMPLETION_CONTRACT } from "../src/gpt/completion"
import { labAgent, upstreamBody } from "../src/gpt/lab-agent"
import { LAB_PROMPT } from "../src/gpt/lab-prompt"
import { VAULT_TOOLS } from "../src/gpt/lab-tools"
import { GptStore } from "../src/gpt/store"
import { ORIGIN } from "./helpers"
import worker, { anthropicCalls, anthropicScript } from "./worker"

// The lab's coding agent (jupyterlite-ai) calls a Messages API endpoint on the lab origin,
// /lab/<ticket>/hafezi-gpt/anthropic/v1/messages, with the lab ticket as its only credential.

const exp = () => Math.floor(Date.now() / 1000) + 3600

async function agent(
  ticket: string,
  body: object,
  { headers = {}, overrides = {} }: { headers?: Record<string, string>; overrides?: object } = {},
) {
  const ctx = createExecutionContext()
  const response = await (worker as ExportedHandler).fetch!(
    new Request(`${ORIGIN}/lab/${ticket}/hafezi-gpt/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    }) as any,
    { ...env, ANTHROPIC_API_KEY: "test-key", ...overrides } as any,
    ctx,
  )
  const text = await response.text()
  await waitOnExecutionContext(ctx)
  return { status: response.status, text, type: response.headers.get("content-type") ?? "" }
}

const usageOf = (login: string) =>
  env.DB.prepare("SELECT input, output FROM gpt_usage WHERE login = ?")
    .bind(login)
    .first<{ input: number; output: number }>()

const ask = { model: "claude-sonnet-5", max_tokens: 1024 }
const hello = [{ role: "user", content: "Add a cell that plots y against x." }]

describe("the lab's coding agent endpoint", () => {
  let own: string
  beforeAll(async () => {
    own = await issueLabTicket(env as any, { login: "Agnes", role: "member", exp: exp() }, "agnes")
  })
  beforeEach(() => {
    anthropicCalls.length = 0
    anthropicScript.length = 0
  })

  it("forwards a cleaned request with the Worker's key, and counts the usage", async () => {
    const reply = await agent(own, {
      ...ask,
      messages: hello,
      temperature: 0.2,
      mcp_servers: [{ type: "url", url: "https://evil.example/mcp" }],
      betas: ["something"],
      tools: [
        { name: "add_cell", input_schema: { type: "object" } },
        { type: "web_search_20250305", name: "web_search" },
      ],
    })
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.text).content).toEqual([{ type: "text", text: "Scripted title" }])
    const [call] = anthropicCalls
    expect(call.url).toBe("https://api.anthropic.com/v1/messages")
    expect(call.headers["x-api-key"]).toBe("test-key")
    expect(Object.keys(call.body).sort()).toEqual([
      "max_tokens",
      "messages",
      "model",
      "system",
      "tools",
    ])
    expect(call.body.tools.map((t: any) => t.name)).toEqual(["add_cell"])
    expect(await usageOf("agnes")).toEqual({ input: 10, output: 3 })
  })

  it("streams through, counting the streamed usage, and goes to the configured bridge", async () => {
    anthropicScript.push({
      content: [{ type: "text", text: "Done: the plot is in cell 4." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 9 },
    })
    const before = (await usageOf("agnes")) ?? { input: 0, output: 0 }
    const reply = await agent(
      own,
      { ...ask, messages: hello, stream: true },
      { overrides: { ANTHROPIC_BASE_URL: "https://bridge-example.trycloudflare.com/" } },
    )
    expect(reply.status).toBe(200)
    expect(reply.type).toContain("text/event-stream")
    expect(reply.text).toContain("message_stop")
    expect(anthropicCalls[0].url).toBe("https://bridge-example.trycloudflare.com/v1/messages")
    expect(await usageOf("agnes")).toEqual({ input: before.input + 7, output: before.output + 9 })
    // The reply never carries the key.
    expect(reply.text).not.toContain("test-key")
  })

  it("counts a streamed reply's usage as it arrives, so one stopped halfway still counts", async () => {
    const encoder = new TextEncoder()
    const event = (data: object) =>
      encoder.encode(`event: ${(data as any).type}\ndata: ${JSON.stringify(data)}\n\n`)
    let cancelled = false
    // A reply that sends its start, then a first delta's worth, and never finishes on its own.
    const hanging = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              event({
                type: "message_start",
                message: { usage: { input_tokens: 40, output_tokens: 1 } },
              }),
            )
            controller.enqueue(event({ type: "message_delta", usage: { output_tokens: 6 } }))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    const ticket = await issueLabTicket(
      env as any,
      { login: "halle", role: "member", exp: exp() },
      "halle",
    )
    const url = `${ORIGIN}/lab/${ticket}/hafezi-gpt/anthropic/v1/messages`
    const ctx = createExecutionContext()
    const response = await labAgent(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ ...ask, messages: hello, stream: true }),
      }),
      new URL(url),
      { ...env, ANTHROPIC_API_KEY: "test-key" } as any,
      ctx,
      hanging,
    )
    const reader = response.body!.getReader()
    let seen = ""
    while (!seen.includes("message_delta"))
      seen += new TextDecoder().decode((await reader.read()).value)
    // The member stops the reply.
    await reader.cancel()
    await waitOnExecutionContext(ctx)
    expect(cancelled).toBe(true)
    expect(await usageOf("halle")).toEqual({ input: 40, output: 6 })
  })

  it("counts usage by day, model and source too: ghost text apart from the agent's", async () => {
    const dora = await issueLabTicket(
      env as any,
      { login: "dora", role: "member", exp: exp() },
      "dora",
    )
    // An agent's turn, streamed: its usage comes in two counts, for one request.
    anthropicScript.push({
      content: [{ type: "text", text: "Done." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 9 },
    })
    expect((await agent(dora, { ...ask, messages: hello, stream: true })).status).toBe(200)
    // Ghost text, then a chat's title (the agent's too), both on Haiku.
    const haiku = { model: "claude-haiku-4-5", max_tokens: 64_000 }
    await agent(dora, { ...haiku, messages: [{ role: "user", content: "psi =" }] })
    const title = "Generate a concise title (no more than 10 words) for the following conversation."
    await agent(dora, {
      ...haiku,
      system: title,
      messages: [{ role: "user", content: "user: hi" }],
    })
    const { results } = await env.DB.prepare(
      `SELECT day, model, source, input, output, requests FROM gpt_usage_daily
       WHERE login = ? ORDER BY source, model`,
    )
      .bind("dora")
      .all()
    const day = new Date().toISOString().slice(0, 10)
    const row = (model: string, source: string, input: number, output: number) => ({
      day,
      model,
      source,
      input,
      output,
      requests: 1,
    })
    expect(results).toEqual([
      row("claude-haiku-4-5-20251001", "agent", 10, 3),
      row("claude-sonnet-5", "agent", 7, 9),
      row("claude-haiku-4-5-20251001", "completion", 10, 3),
    ])
    // The monthly rollup, which budgets read, has all of it.
    expect(await usageOf("dora")).toEqual({ input: 27, output: 15 })
  })

  it("counts a budget's usage even when the split by day can't be written", async () => {
    // As before migration 0015: the daily table isn't there.
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) =>
            sql.includes("gpt_usage_daily")
              ? { bind: () => ({ run: () => Promise.reject(new Error("no such table")) }) }
              : target.prepare(sql)
        const value = (target as any)[key]
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const totals = { input: 5, output: 1, cache_read: 0, cache_write: 0, cost_usd: 0.1 }
    await new GptStore(db).addUsage("ivy", totals, { model: "claude-sonnet-5", source: "chat" })
    expect(await usageOf("ivy")).toEqual({ input: 5, output: 1 })
  })

  it("refuses a body over 4 MB, chunked or not, before anything is sent on", async () => {
    const big = { ...ask, messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024) }] }
    expect((await agent(own, big)).status).toBe(413)
    let sent = 0
    const chunk = new TextEncoder().encode(" ".repeat(64 * 1024))
    const chunked = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength
        controller.enqueue(chunk)
        if (sent > 64 * 1024 * 1024) controller.close()
      },
    })
    const ctx = createExecutionContext()
    const response = await (worker as ExportedHandler).fetch!(
      new Request(`${ORIGIN}/lab/${own}/hafezi-gpt/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: chunked,
      }) as any,
      { ...env, ANTHROPIC_API_KEY: "test-key" } as any,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(413)
    expect(sent).toBeLessThan(16 * 1024 * 1024)
    expect(anthropicCalls).toHaveLength(0)
  })

  it("stops at the member's monthly budget", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO gpt_budgets (login, monthly_tokens) VALUES (?, 1)")
      .bind("agnes")
      .run()
    const reply = await agent(own, { ...ask, messages: hello })
    expect(reply.status).toBe(402)
    expect(anthropicCalls).toHaveLength(0)
    await env.DB.prepare("DELETE FROM gpt_budgets WHERE login = ?").bind("agnes").run()
  })

  it("is for the member's own lab, from the lab page, with a valid ticket", async () => {
    const other = await issueLabTicket(
      env as any,
      { login: "olivia", role: "owner", exp: exp() },
      "agnes",
    )
    expect((await agent(other, { ...ask, messages: hello })).status).toBe(403)
    const elsewhere = { headers: { origin: "https://evil.example" } }
    expect((await agent(own, { ...ask, messages: hello }, elsewhere)).status).toBe(403)
    expect((await agent(own.slice(0, -2) + "xx", { ...ask, messages: hello })).status).toBe(401)
    expect(
      (await agent(own, { ...ask, messages: hello }, { overrides: { ANTHROPIC_API_KEY: "" } }))
        .status,
    ).toBe(503)
    expect(anthropicCalls).toHaveLength(0)
  })

  it("limits ghost-text completions on their own, so they never use up the agent's allowance", async () => {
    const keys: string[] = []
    const limiter = (success: boolean) => ({
      limit: async ({ key }: { key: string }) => (keys.push(key), { success }),
    })
    const overrides = { COMPUTE_LIMIT: limiter(false), COMPLETE_LIMIT: limiter(true) }
    // What jupyterlite-ai's completer sends: a prompt to Haiku, no tools, not streamed.
    const completion = {
      model: "claude-haiku-4-5",
      max_tokens: 64_000,
      temperature: 0.3,
      system: [{ type: "text", text: "You are an AI code completion assistant." }],
      messages: [{ role: "user", content: [{ type: "text", text: "x = np." }] }],
    }
    expect((await agent(own, completion, { overrides })).status).toBe(200)
    expect(anthropicCalls[0].body.max_tokens).toBe(512)
    expect(anthropicCalls[0].body.system).toEqual([
      ...completion.system,
      { type: "text", text: COMPLETION_CONTRACT },
    ])
    expect(anthropicCalls[0].body.stop_sequences).toEqual(["\n```"])
    const tools = [{ name: "add_cell", input_schema: { type: "object" } }]
    expect((await agent(own, { ...ask, messages: hello, tools }, { overrides })).status).toBe(429)
    expect(
      (await agent(own, { ...ask, messages: hello, stream: true }, { overrides })).status,
    ).toBe(429)
    expect(keys).toEqual(["complete:agnes", "agent:agnes", "agent:agnes"])
    expect(anthropicCalls).toHaveLength(1)
  })

  it("sends a ghost-text completion with its completer's prompt, then the code-only contract, capped at 512 tokens", () => {
    const system = [{ type: "text", text: "You are an AI code completion assistant." }]
    const completion = { model: "claude-haiku-4-5", max_tokens: 64_000, system, messages: hello }
    const contract = { type: "text", text: COMPLETION_CONTRACT }
    // It stops at the fence that closes its code (jupyter-ai's stop), never at an opening one.
    const stop_sequences = ["\n```"]
    expect(upstreamBody(completion)).toEqual({
      ...completion,
      system: [...system, contract],
      max_tokens: 512,
      stop_sequences,
    })
    expect(upstreamBody({ ...completion, max_tokens: 100 }).max_tokens).toBe(100)
    const { system: _, ...bare } = completion
    expect(upstreamBody(bare)).toEqual({
      ...bare,
      system: COMPLETION_CONTRACT,
      max_tokens: 512,
      stop_sequences,
    })
    // A prompt as a string gets the contract as a paragraph; the completer's own stops stay.
    const own = upstreamBody({ ...completion, system: "Complete code.", stop_sequences: ["\n\n"] })
    expect(own.system).toBe(`Complete code.\n\n${COMPLETION_CONTRACT}`)
    expect(own.stop_sequences).toEqual(["\n\n", "\n```"])
    expect(COMPLETION_CONTRACT).toContain("Reply with code only")
    expect(COMPLETION_CONTRACT).toContain("Never ask for more context")
    // The agent's turns, which stream or carry tools, still get the lab's section.
    const tools = [{ name: "add_cell", input_schema: { type: "object" } }]
    for (const turn of [{ stream: true }, { tools }]) {
      const sent = upstreamBody({ ...completion, ...turn })
      expect(sent.system).toEqual([...system, { type: "text", text: LAB_PROMPT }])
      expect(sent.max_tokens).toBe(16_000)
    }
  })

  it("sends ghost text back as code only: fences and restated code cut, prose dropped", async () => {
    const answer = (text: string) => async () =>
      Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 5 },
      })
    const complete = async (text: string, prompt: string, system = "You complete code.") => {
      const url = `${ORIGIN}/lab/${own}/hafezi-gpt/anthropic/v1/messages`
      const ctx = createExecutionContext()
      const response = await labAgent(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 64_000,
            system,
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          }),
        }),
        new URL(url),
        { ...env, ANTHROPIC_API_KEY: "test-key" } as any,
        ctx,
        answer(text),
      )
      await waitOnExecutionContext(ctx)
      expect(response.status).toBe(200)
      return JSON.parse(await response.text()).content[0].text
    }
    // hafezi-lab's completer: jupyter-ai's template, the code before the cursor last.
    const psi =
      "The document is called `Console 1` and written in python.\n\nComplete the following code:\n\n```\npsi = "
    const prose = "I need more context to complete this code fragment. What language is this?"
    expect(await complete(prose, psi)).toBe("")
    expect(await complete("```python\npsi = np.sqrt(2)\n```", psi)).toBe("np.sqrt(2)")
    // jupyterlite-ai's console sends the bare prefix.
    expect(await complete("Could you share more of the code?", "psi =")).toBe("")
    // A chat's title is words on purpose.
    const title = "Generate a concise title (no more than 10 words) for the following conversation."
    expect(await complete("I need a title", "user: plot y", title)).toBe("I need a title")
  })

  it("leaves a chat's title request as it came: no code-only contract, no stop at a fence", () => {
    // jupyterlite-ai asks for a chat's title the way its completer asks for code (requestTitle).
    const title = {
      model: "claude-sonnet-5",
      max_tokens: 64_000,
      system: [
        {
          type: "text",
          text: "Generate a concise title (no more than 10 words) for the following conversation. Do not use formatting, quotes, or punctuation.",
        },
      ],
      messages: [{ role: "user", content: "user: plot y against x" }],
    }
    expect(upstreamBody(title)).toEqual({ ...title, max_tokens: 512 })
  })

  it("offers only the site's models, and no sampling knobs where the model refuses them", () => {
    expect(() => upstreamBody({ model: "claude-3-opus", messages: hello })).toThrow(/not available/)
    expect(() => upstreamBody({ model: "claude-sonnet-5", messages: [] })).toThrow(/non-empty/)
    const haiku = upstreamBody({
      model: "claude-haiku-4-5",
      messages: hello,
      stream: true,
      temperature: 0.1,
      max_tokens: 10_000_000,
      tools: [{ type: "code_execution_20250825", name: "code_execution" }],
      tool_choice: { type: "any" },
    })
    expect(haiku).toEqual({
      model: "claude-haiku-4-5",
      messages: hello,
      stream: true,
      max_tokens: 16_000,
      system: LAB_PROMPT,
      temperature: 0.1,
    })
  })

  it("adds the lab's section after the agent's own system prompt, in the form it came", () => {
    const system = (sent: unknown) =>
      upstreamBody({ ...ask, messages: hello, stream: true, system: sent }).system
    expect(system("You are Jupyternaut.")).toBe(`You are Jupyternaut.\n\n${LAB_PROMPT}`)
    const blocks = [
      { type: "text", text: "You are Jupyternaut." },
      { type: "text", text: "Skills: none.", cache_control: { type: "ephemeral" } },
    ]
    expect(system(blocks)).toEqual([...blocks, { type: "text", text: LAB_PROMPT }])
    expect(system(undefined)).toBe(LAB_PROMPT)
    expect(() => system({ text: "not a prompt" })).toThrow(/system must be/)
    // It names the site tools as the lab registers them (hafezi_<name>).
    for (const name of VAULT_TOOLS) expect(LAB_PROMPT).toContain(`hafezi_${name}`)
  })

  it("spells out the kernel tools' order: a kernel first, then its kernelId in args, an object", () => {
    // The agent once ran execute-in-kernel with no kernelId, then with args as a JSON string.
    const start = LAB_PROMPT.indexOf("jupyterlab-ai-commands:start-kernel")
    const run = LAB_PROMPT.indexOf("jupyterlab-ai-commands:execute-in-kernel")
    expect(start).toBeGreaterThan(0)
    expect(LAB_PROMPT).toContain("jupyterlab-ai-commands:list-kernels")
    expect(run).toBeGreaterThan(start)
    expect(LAB_PROMPT).toContain("args as an object, never a JSON string")
    expect(LAB_PROMPT).toContain('{"kernelId": "<that id>", "code": "…"}')
  })

  it("sends the lab's section upstream with the agent's request", async () => {
    const system = [
      { type: "text", text: "You are Jupyternaut.", cache_control: { type: "ephemeral" } },
    ]
    const tools = [{ name: "add_cell", input_schema: { type: "object" } }]
    const reply = await agent(own, { ...ask, messages: hello, system, tools })
    expect(reply.status).toBe(200)
    expect(anthropicCalls[0].body.system).toEqual([...system, { type: "text", text: LAB_PROMPT }])
  })
})
