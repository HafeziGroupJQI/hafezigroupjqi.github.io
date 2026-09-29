import type { Env } from "../env"
import { HttpError, readLimited, withPrivateHeaders } from "../http"
import type { AnthropicFetch } from "./chat"
import { labSession } from "./lab"
import { withLabPrompt } from "./lab-prompt"
import { type GptModel, MODELS, addUsage, emptyUsage } from "./models"
import { GptStore } from "./store"

// The lab's coding agent (jupyterlite-ai in members' labs, with the hafezi-lab provider) speaks the
// Anthropic Messages API. It reaches it here, on the lab origin, with the lab ticket as its only
// credential: the member's own lab only, as for the lab's Hafezi GPT panel (lab.ts). The request
// is rebuilt from an allowlist and sent on with the Worker's own key to the Worker's model
// endpoint: the claude-bridge today (which emulates tool calls), Anthropic's API once there is a
// key, with the lab's section added to its system prompt (lab-prompt.ts). Usage counts against
// the member's monthly Hafezi GPT budget.

const LAB_AGENT = /^\/lab\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/hafezi-gpt\/anthropic\/v1\/messages$/

export const isLabAgentPath = (path: string) => LAB_AGENT.test(path)

const HAIKU: GptModel = {
  id: "claude-haiku-4-5-20251001",
  label: "Haiku 4.5",
  blurb: "Quick code suggestions",
  input: 1,
  output: 5,
  cacheRead: 0.1,
}

/** The models the agent may ask for (its settings name one), and what they cost. */
export const AGENT_MODELS: Record<string, GptModel> = {
  ...Object.fromEntries(MODELS.map((m) => [m.id, m])),
  "claude-haiku-4-5": HAIKU,
  [HAIKU.id]: HAIKU,
}

/** Sonnet 5 and Opus 5.5 refuse sampling parameters; older models take them. */
const NO_SAMPLING = new Set(["claude-sonnet-5", "claude-opus-5-5"])
const MAX_BODY = 4 * 1024 * 1024
const MAX_TOKENS = 16_000

/**
 * The request sent on: only what the agent needs, never server tools, MCP or betas, with the
 * lab's section after its system prompt.
 */
export function upstreamBody(body: Record<string, unknown>): Record<string, unknown> {
  const model = typeof body.model === "string" ? body.model : ""
  if (!AGENT_MODELS[model]) throw new HttpError(422, `model ${model || "(none)"} is not available`)
  if (!Array.isArray(body.messages) || !body.messages.length)
    throw new HttpError(422, "messages must be a non-empty list")
  const out: Record<string, unknown> = {
    model,
    messages: body.messages,
    max_tokens: Math.min(Number(body.max_tokens) || 4096, MAX_TOKENS),
    system: withLabPrompt(body.system),
  }
  for (const key of ["stream", "stop_sequences", "tool_choice"] as const)
    if (body[key] !== undefined) out[key] = body[key]
  if (Array.isArray(body.tools)) {
    // The agent's own tools, which run in the member's browser; a provider-hosted tool (web
    // search, code execution) would run on our key with no one watching.
    const tools = body.tools.filter(
      (tool) =>
        tool && typeof tool === "object" && [undefined, "custom"].includes((tool as any).type),
    )
    if (tools.length) out.tools = tools
    else delete out.tool_choice
  }
  if (!NO_SAMPLING.has(model))
    for (const key of ["temperature", "top_p", "top_k"] as const)
      if (typeof body[key] === "number") out[key] = body[key]
  return out
}

/**
 * Pick usage out of a streamed reply as it passes, and count it as it arrives: message_start's
 * input at once, then what each message_delta adds (its counts are running totals). A reply the
 * member stops halfway is still counted, up to where it got.
 */
function watchUsage(
  onUsage: (usage: Record<string, number>) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ""
  const usage: Record<string, number> = {}
  const counted: Record<string, number> = {}
  const read = (line: string) => {
    if (!line.startsWith("data:")) return
    let found: unknown
    try {
      const event = JSON.parse(line.slice(5))
      found = event?.message?.usage ?? event?.usage
    } catch {
      return // not JSON: not an event we count
    }
    if (!found || typeof found !== "object") return
    for (const [key, value] of Object.entries(found))
      if (typeof value === "number") usage[key] = value
    const added: Record<string, number> = { input_tokens: 0, output_tokens: 0 }
    let any = false
    for (const [key, value] of Object.entries(usage)) {
      const more = value - (counted[key] ?? 0)
      if (more > 0) {
        added[key] = more
        counted[key] = value
        any = true
      }
    }
    if (any) onUsage(added)
  }
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let at: number
      while ((at = buffer.indexOf("\n")) >= 0) {
        read(buffer.slice(0, at).trim())
        buffer = buffer.slice(at + 1)
      }
      controller.enqueue(chunk)
    },
    flush() {
      read(buffer.trim())
    },
  })
}

export async function labAgent(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  anthropicFetch: AnthropicFetch = (input, init) => fetch(input, init),
): Promise<Response> {
  const [, token] = url.pathname.match(LAB_AGENT) ?? []
  if (!token) throw new HttpError(404, "not found")
  if (request.method !== "POST") throw new HttpError(405, "method not allowed")
  const session = await labSession(request, url, env, token)
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "Hafezi GPT's model is not set up")
  // Counted as it is read too: a chunked body has no content-length to check.
  const bytes = await readLimited(request, MAX_BODY, "the request is too large")
  let body: Record<string, unknown>
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  } catch {
    throw new HttpError(422, "request body must be JSON")
  }
  const sent = upstreamBody(body ?? {})
  const store = new GptStore(env.DB)
  const budget = await store.usage(session.login)
  if (budget.budget !== null && budget.used >= budget.budget)
    throw new HttpError(
      402,
      "you've used this month's Hafezi GPT budget; ask a group admin to raise it",
    )
  if (env.COMPUTE_LIMIT) {
    const { success } = await env.COMPUTE_LIMIT.limit({ key: `agent:${session.login}` })
    if (!success) throw new HttpError(429, "too many requests; wait a moment")
  }
  const base = (env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "")
  const upstream = await anthropicFetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify(sent),
    signal: request.signal,
  })
  const model = AGENT_MODELS[sent.model as string]
  const record = (usage: Record<string, number>) =>
    ctx.waitUntil(
      store
        .addUsage(session.login, addUsage(emptyUsage(), model, usage as any))
        .catch((error) => console.error("recording agent usage failed", error)),
    )
  const headers = new Headers({
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  })
  if (!upstream.ok || !upstream.body)
    return withPrivateHeaders(new Response(upstream.body, { status: upstream.status, headers }))
  if (sent.stream)
    return withPrivateHeaders(
      new Response(upstream.body.pipeThrough(watchUsage(record)), { status: 200, headers }),
    )
  const text = await upstream.text()
  try {
    const usage = JSON.parse(text)?.usage
    if (usage) record(usage)
  } catch {
    // no usage to count
  }
  return withPrivateHeaders(new Response(text, { status: 200, headers }))
}
