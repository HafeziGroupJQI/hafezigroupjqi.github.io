import { createHandler } from "../src/app"
import manifest from "./fixtures/docs-manifest.json"
import skills from "./fixtures/gpt-skills.json"

// The Durable Object class must be exported from the test entry module too.
export { DeviceHub } from "../src/devices/hub"
export { ComputeRelay } from "../src/compute/relay"

// The test Worker shares the isolate with the tests, so they can inspect the GitHub blob calls.
export const upstreamCalls: string[] = []
export const upstreamBodies: Record<string, [number, string]> = {
  "0123456789abcdef0123456789abcdef01234567": [200, "%PDF-1.4 laser"],
  fedcba9876543210fedcba9876543210fedcba98: [500, "boom"],
  aaaabbbbccccddddeeeeffff0000111122223333: [200, "<svg></svg>"],
}

// A stand-in for GitHub OAuth + REST during sign-in (AUTH_MODE=github tests).
export const githubCalls: string[] = []
export const githubAccounts: Record<string, { org?: object; team?: object }> = {
  "code-owner": { org: { state: "active", role: "admin" } },
  "code-member": { team: { state: "active" } },
  "code-outsider": {},
}
let lastCode = ""

// A stand-in for the Claude API. Each streamed request takes the next scripted reply (a Message,
// or a function of the request body returning one) and answers with real Messages SSE events.
export const anthropicCalls: any[] = []
export const anthropicScript: Array<object | ((body: any) => object)> = []

function sse(message: any): string {
  const events: object[] = []
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...message.usage,
  }
  events.push({
    type: "message_start",
    message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } },
  })
  message.content.forEach((block: any, index: number) => {
    if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "", citations: block.citations ? [] : null },
      })
      for (const piece of block.text.match(/.{1,12}/gs) ?? [])
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: piece },
        })
      for (const citation of block.citations ?? [])
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "citations_delta", citation },
        })
    } else if (block.type === "thinking") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      })
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking },
      })
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "sig" },
      })
    } else if (block.type === "tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      })
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      })
    }
    events.push({ type: "content_block_stop", index })
  })
  events.push({
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  })
  events.push({ type: "message_stop" })
  return events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")
}

export default createHandler(manifest, {
  skills,
  anthropic: async (input, init) => {
    const body = JSON.parse(String(init?.body))
    anthropicCalls.push({ url: String(input), headers: init?.headers, body })
    if (!body.stream)
      return Response.json({
        id: "msg_title",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "Scripted title" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 },
      })
    const next = anthropicScript.shift()
    if (!next)
      return Response.json(
        { type: "error", error: { type: "invalid_request_error", message: "no scripted reply" } },
        { status: 400 },
      )
    const message = {
      id: `msg_${anthropicCalls.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      stop_sequence: null,
      ...(typeof next === "function" ? next(body) : next),
    }
    return new Response(sse(message), { headers: { "content-type": "text/event-stream" } })
  },
  github: async (input, init) => {
    githubCalls.push(input)
    if (input === "https://github.com/login/oauth/access_token") {
      const { code } = JSON.parse(String(init.body)) as { code: string }
      lastCode = code
      return Response.json(code in githubAccounts ? { access_token: `gho_${code}` } : {})
    }
    const account = githubAccounts[lastCode] ?? {}
    if (input.endsWith("/user")) return Response.json({ login: lastCode.slice(5), name: null })
    if (input.includes("/user/memberships/orgs/"))
      return account.org ? Response.json(account.org) : new Response("", { status: 404 })
    if (input.includes("/teams/"))
      return account.team ? Response.json(account.team) : new Response("", { status: 404 })
    return new Response("", { status: 404 })
  },
  upstream: async (input) => {
    upstreamCalls.push(input)
    const sha = input.split("/").pop() ?? ""
    const [status, body] = upstreamBodies[sha] ?? [404, "missing"]
    return new Response(body, { status })
  },
})
