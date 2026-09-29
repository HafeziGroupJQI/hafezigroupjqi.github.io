import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { issueLabTicket } from "../src/compute/tokens"
import { upstreamBody } from "../src/gpt/lab-agent"
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
    expect(Object.keys(call.body).sort()).toEqual(["max_tokens", "messages", "model", "tools"])
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

  it("offers only the site's models, and no sampling knobs where the model refuses them", () => {
    expect(() => upstreamBody({ model: "claude-3-opus", messages: hello })).toThrow(/not available/)
    expect(() => upstreamBody({ model: "claude-sonnet-5", messages: [] })).toThrow(/non-empty/)
    const haiku = upstreamBody({
      model: "claude-haiku-4-5",
      messages: hello,
      temperature: 0.1,
      max_tokens: 10_000_000,
      tools: [{ type: "code_execution_20250825", name: "code_execution" }],
      tool_choice: { type: "any" },
    })
    expect(haiku).toEqual({
      model: "claude-haiku-4-5",
      messages: hello,
      max_tokens: 16_000,
      temperature: 0.1,
    })
  })
})
