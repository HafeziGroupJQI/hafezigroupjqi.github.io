import Anthropic from "@anthropic-ai/sdk"
import { audit } from "../audit"
import type { Upstream } from "../docs"
import type { DocsManifest, Env } from "../env"
import { HttpError } from "../http"
import type { Session } from "../session"
import {
  type ResolvedRef,
  fileContent,
  hydrate,
  projectKnowledge,
  refContent,
  systemBlocks,
} from "./context"
import { type Knowledge, loadKnowledge } from "./knowledge"
import { type GptModel, addUsage, emptyUsage, model as pickModel } from "./models"
import { type SkillsManifest, allSkills } from "./skills"
import { type Conversation, GptStore, type StoredMessage } from "./store"
import { TOOLS, describeCall, runTool, skillText } from "./tools"

// POST /api/gpt/conversations/:id/messages — one member turn, streamed back as Server-Sent Events.
// The browser reads this stream straight from the Worker (the members service worker cannot hold
// long streams). The tool loop runs inside this request; the turn is stored as it completes.
//
// Events: start · thinking {text} · delta {text} · tool {id,name,label} · tool_result {id,summary,
// is_error} · turn {turn} (the finished reply, with citations) · usage {…} · title {title} ·
// done {} · error {detail}

export type AnthropicFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface GptDeps {
  manifest: DocsManifest
  skills: SkillsManifest
  upstream: Upstream
  /** Outbound fetch for the Anthropic API; tests substitute a scripted stub. */
  anthropicFetch?: AnthropicFetch
}

const MAX_TOOL_ROUNDS = 8
const MAX_OUTPUT_TOKENS = 32_000
const COMPACTION_BETA = "compact-2026-01-12"

type Block = Anthropic.Beta.BetaContentBlockParam
type MessageParam = Anthropic.Beta.BetaMessageParam

export interface TurnInput {
  text: string
  mentions: string[]
  files: string[]
  skill: string | null
  model: string | null
}

export function readTurn(body: Record<string, unknown>): TurnInput {
  const text = typeof body.text === "string" ? body.text.trim() : ""
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : []
  const skill = typeof body.skill === "string" && body.skill ? body.skill.replace(/^\//, "") : null
  if (!text && !skill) throw new HttpError(422, "write a message")
  if (text.length > 100_000)
    throw new HttpError(413, "that message is too long; attach it as a file instead")
  return {
    text,
    mentions: [...new Set(list(body.mentions))],
    files: [...new Set(list(body.files))],
    skill,
    model: typeof body.model === "string" ? body.model : null,
  }
}

/** The claude-bridge: text in, text out, no tools/thinking/betas. */
const flattenForBridge = (message: MessageParam): MessageParam => {
  if (typeof message.content === "string") return message
  // The bridge keeps text blocks only, so inline text documents as tagged text.
  const content = message.content.map((block): Block => {
    if (block.type === "document" && block.source.type === "text")
      return {
        type: "text",
        text: `<document title="${block.title ?? ""}" source="${block.context ?? ""}">\n${block.source.data}\n</document>`,
      }
    if (block.type === "document" || block.type === "image")
      return {
        type: "text",
        text: `[${block.type === "image" ? "an image" : "a PDF"} (not readable through the local bridge)]`,
      }
    return block
  })
  return { ...message, content }
}

const isBridge = (env: Env) => {
  // Any Messages endpoint other than Anthropic's is the claude-bridge (~/src/claude-bridge): local
  // under wrangler dev, or tunnelled for the deployed Worker when there is no API key.
  const base = env.ANTHROPIC_BASE_URL?.trim()
  if (!base) return false
  try {
    return new URL(base).hostname !== "api.anthropic.com"
  } catch {
    return false
  }
}

export async function postMessage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  session: Session,
  conversationId: string,
  input: TurnInput,
  deps: GptDeps,
): Promise<Response> {
  const store = new GptStore(env.DB)
  const { conversation, access } = await store.conversation(conversationId, session.login)
  if (access !== "owner")
    throw new HttpError(403, "this chat was shared with you; continue it in your own chat")
  const budget = await store.usage(session.login)
  if (budget.budget !== null && budget.used >= budget.budget)
    throw new HttpError(
      402,
      "you've used this month's Hafezi GPT budget; ask a group admin to raise it",
    )

  const m = pickModel(input.model ?? conversation.model)
  const knowledge = await loadKnowledge(env, deps.manifest)
  const skills = await allSkills(deps.skills, store, session.login)
  const project = conversation.project_id
    ? await store.project(conversation.project_id, session.login).catch(() => null)
    : null
  const history = await store.messages(conversation.id)
  const firstTurn = !history.some((row) => row.meta.kind === "prompt")

  // ---- the member's message: page context, @-mentions, uploads, a /skill, then the text ----
  const blocks: Block[] = []
  const mentions: ResolvedRef["label"][] = []
  if (firstTurn && conversation.origin_slug) {
    const origin = await refContent(conversation.origin_slug, knowledge, env, deps.upstream).catch(
      () => null,
    )
    if (origin) {
      blocks.push(
        { type: "text", text: "I'm reading this page on the lab site:" },
        ...origin.blocks,
      )
      mentions.push(origin.label)
    }
  }
  for (const ref of input.mentions) {
    const resolved = await refContent(ref, knowledge, env, deps.upstream)
    blocks.push(...resolved.blocks)
    mentions.push(resolved.label)
  }
  const files: Array<{ id: string; name: string; mime: string }> = []
  for (const id of input.files) {
    const file = await store.file(id)
    if (
      !file ||
      file.owner !== session.login ||
      !(
        file.conversation_id === conversation.id ||
        (file.project_id && file.project_id === conversation.project_id)
      )
    )
      throw new HttpError(404, "attach files to this chat before sending")
    blocks.push(...(await fileContent(file, env)))
    files.push({ id: file.id, name: file.name, mime: file.mime })
  }
  if (input.skill) {
    const skill = skills.find((s) => s.name === input.skill)
    if (!skill) throw new HttpError(404, `no skill named /${input.skill}`)
    blocks.push({
      type: "text",
      text: `Use the ${skill.name} skill for this request:\n${skillText(skill)}`,
    })
  }
  blocks.push({ type: "text", text: input.text || `Run /${input.skill}.` })

  const prompt = {
    role: "user" as const,
    content: blocks as unknown[],
    meta: { kind: "prompt", text: input.text, mentions, files, skill: input.skill },
  }
  await store.appendMessages(conversation.id, [prompt])
  if (m.id !== conversation.model) await store.touchConversation(conversation.id, { model: m.id })

  // ---- stream ----
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  let detached = false
  const send = (event: string, data: unknown) => {
    if (detached) return
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {
      detached = true
    })
  }

  const run = async () => {
    send("start", { conversation_id: conversation.id, model: m.id })
    try {
      const turn = {
        history,
        prompt,
        knowledge,
        skills,
        project,
        conversation,
        model: m,
        session,
        env,
        store,
        deps,
        send,
        isDetached: () => detached,
      }
      const result = env.ANTHROPIC_API_KEY ? await converse(turn) : offline(turn)
      await store.appendMessages(conversation.id, result.rows)
      await store.addUsage(session.login, result.usage)
      const display = displayTurns([
        prompt as unknown as StoredMessage,
        ...(result.rows as unknown as StoredMessage[]),
      ])
      send("turn", display[display.length - 1] ?? null)
      send("usage", {
        ...result.usage,
        model: m.id,
        budget: budget.budget,
        used: budget.used + result.usage.input + result.usage.output,
      })
      audit(env, ctx, request, {
        login: session.login,
        role: session.role,
        action: "gpt.message",
        target: conversation.id,
        detail: {
          model: m.id,
          project: conversation.project_id,
          origin: conversation.origin_slug,
          mentions: mentions.map((x) => x.ref),
          files: files.length,
          skill: input.skill,
          tools: result.tools,
          input: result.usage.input,
          output: result.usage.output,
          cache_read: result.usage.cache_read,
          cost_usd: Number(result.usage.cost_usd.toFixed(5)),
          stopped: result.stopped || undefined,
        },
      })
      let title: string | undefined
      if (firstTurn) {
        title = await makeTitle(env, deps, input.text || `/${input.skill}`, mentions[0]?.title)
        send("title", { title })
      }
      await store.touchConversation(conversation.id, { title })
      send("done", {})
    } catch (error) {
      console.error("gpt turn failed", error)
      send("error", { detail: apiErrorDetail(error) })
    } finally {
      await writer.close().catch(() => {})
    }
  }
  ctx.waitUntil(run())
  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  })
}

function apiErrorDetail(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError)
    return "Hafezi GPT is busy right now (rate limited). Try again in a minute."
  if (error instanceof Anthropic.AuthenticationError)
    return "Hafezi GPT isn't configured correctly (API key rejected). Tell a group admin."
  if (error instanceof Anthropic.BadRequestError)
    return `The request was rejected: ${error.message}`
  if (error instanceof Anthropic.APIError)
    return `Claude API error ${error.status ?? ""}. Try again.`
  if (error instanceof HttpError) return error.detail
  return "Something went wrong. Try again."
}

interface TurnContext {
  history: StoredMessage[]
  prompt: { role: "user"; content: unknown[]; meta: Record<string, unknown> }
  knowledge: Knowledge
  skills: Awaited<ReturnType<typeof allSkills>>
  project: Awaited<ReturnType<GptStore["project"]>> | null
  conversation: Conversation
  model: GptModel
  session: Session
  env: Env
  store: GptStore
  deps: GptDeps
  send: (event: string, data: unknown) => void
  isDetached: () => boolean
}

interface TurnResult {
  rows: Array<{ role: "user" | "assistant"; content: unknown[]; meta: Record<string, unknown> }>
  usage: ReturnType<typeof emptyUsage>
  tools: string[]
  stopped: boolean
}

function client(env: Env, deps: GptDeps): Anthropic {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    fetch: deps.anthropicFetch,
    maxRetries: 2,
  })
}

async function converse(t: TurnContext): Promise<TurnResult> {
  const { env, deps, model: m } = t
  const bridge = isBridge(env)
  const api = client(env, deps)
  const files = t.project ? await t.store.projectFiles(t.project.id) : []
  const corpus = t.project ? await projectKnowledge(t.project, t.knowledge, files, env) : null
  const system = systemBlocks({
    skills: t.skills,
    project: t.project,
    knowledge: corpus?.text ?? "",
    user: { login: t.session.login, name: t.session.name },
  })
  const blobs = new Map<string, string>()
  const messages: MessageParam[] = await hydrate(
    [...t.history, t.prompt].map((row) => ({ role: row.role, content: row.content as Block[] })),
    env,
    blobs,
  )
  const result: TurnResult = { rows: [], usage: emptyUsage(), tools: [], stopped: false }
  const opened = new Map<string, ResolvedRef["label"]>()

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const params: Anthropic.Beta.MessageCreateParamsStreaming = bridge
      ? {
          model: m.id,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          messages: messages.map(flattenForBridge),
          stream: true,
        }
      : {
          model: m.id,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          messages,
          tools: TOOLS,
          // Automatic caching on the conversation tail; the system prompt carries its own 1 h breakpoint.
          cache_control: { type: "ephemeral" },
          thinking: { type: "adaptive", display: "summarized" },
          ...(m.effort ? { output_config: { effort: m.effort } } : {}),
          betas: [COMPACTION_BETA],
          context_management: { edits: [{ type: "compact_20260112" }] },
          stream: true,
        }
    const stream = api.beta.messages.stream(params)
    for await (const event of stream) {
      if (t.isDetached()) {
        stream.abort()
        break
      }
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") t.send("delta", { text: event.delta.text })
        else if (event.delta.type === "thinking_delta")
          t.send("thinking", { text: event.delta.thinking })
      } else if (
        event.type === "content_block_start" &&
        event.content_block.type === "compaction"
      ) {
        t.send("thinking", { text: "\n(Summarizing earlier messages to make room…)\n" })
      }
    }
    if (t.isDetached()) {
      // The member pressed Stop (or left): keep what was written, never half a tool call.
      const partial =
        stream.currentMessage?.content.filter((b) => b.type === "text" && b.text) ?? []
      if (partial.length)
        result.rows.push({
          role: "assistant",
          content: partial,
          meta: { kind: "reply", model: m.id, stopped: true },
        })
      result.stopped = true
      break
    }
    const message = await stream.finalMessage()
    addUsage(result.usage, m, message.usage)
    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    )
    result.rows.push({
      role: "assistant",
      content: message.content,
      meta: {
        kind: "reply",
        model: m.id,
        stop_reason: message.stop_reason,
        tools: toolUses.map((u) => ({
          id: u.id,
          name: u.name,
          label: describeCall(u.name, u.input as Record<string, unknown>),
        })),
      },
    })
    messages.push({ role: "assistant", content: message.content as Block[] })
    if (message.stop_reason === "refusal") {
      t.send("delta", { text: "\n\n*Claude declined to answer this request.*" })
      break
    }
    if (message.stop_reason === "pause_turn") continue
    if (message.stop_reason !== "tool_use" || !toolUses.length) break
    if (message.stop_reason === "tool_use" && round === MAX_TOOL_ROUNDS) {
      // Out of rounds: answer the pending calls so the stored history stays valid, and stop.
      result.rows.push({
        role: "user",
        content: toolUses.map((use) => ({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: "Tool limit for this turn reached.",
        })),
        meta: {
          kind: "tool_results",
          tools: toolUses.map((u) => ({
            id: u.id,
            name: u.name,
            summary: "Skipped: tool limit reached",
            is_error: true,
          })),
        },
      })
      t.send("delta", {
        text: "\n\n*I hit the limit of tool calls for one message. Ask me to continue.*",
      })
      break
    }

    // Run this round's tools together and answer them in one user message.
    for (const use of toolUses)
      t.send("tool", {
        id: use.id,
        name: use.name,
        label: describeCall(use.name, use.input as Record<string, unknown>),
      })
    const outcomes = await Promise.all(
      toolUses.map((use) =>
        runTool(use.name, (use.input ?? {}) as Record<string, unknown>, {
          env,
          knowledge: t.knowledge,
          store: t.store,
          skills: t.skills,
          conversation: t.conversation,
          upstream: deps.upstream,
          opened,
        }),
      ),
    )
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((use, i) => ({
      type: "tool_result",
      tool_use_id: use.id,
      content: outcomes[i].content,
      ...(outcomes[i].isError ? { is_error: true } : {}),
    }))
    toolUses.forEach((use, i) => {
      result.tools.push(use.name)
      t.send("tool_result", {
        id: use.id,
        summary: outcomes[i].summary,
        is_error: !!outcomes[i].isError,
      })
    })
    result.rows.push({
      role: "user",
      content: results,
      meta: {
        kind: "tool_results",
        tools: toolUses.map((u, i) => ({
          id: u.id,
          name: u.name,
          summary: outcomes[i].summary,
          is_error: !!outcomes[i].isError,
        })),
      },
    })
    messages.push({ role: "user", content: await hydrate(results as Block[], env, blobs) })
  }
  const last = [...result.rows].reverse().find((r) => r.role === "assistant")
  if (last)
    last.meta = {
      ...last.meta,
      usage: result.usage,
      opened: [...opened.values()],
      corpus_tokens: corpus?.tokens ?? 0,
    }
  return result
}

/** No API key (tests, offline dev): a deterministic reply describing what would be sent. */
function offline(t: TurnContext): TurnResult {
  const meta = t.prompt.meta as {
    mentions: ResolvedRef["label"][]
    files: Array<{ name: string }>
    skill: string | null
  }
  const lines = [
    `Hafezi GPT is running offline (no ANTHROPIC_API_KEY), so here is what I would have used.`,
    t.project
      ? `- Project: ${t.project.name} (${t.project.topics.join(", ") || "no topics"})`
      : "- No project",
    ...meta.mentions.map((x) => `- Page: [${x.title}](${x.url})`),
    ...meta.files.map((f) => `- File: ${f.name}`),
    meta.skill ? `- Skill: /${meta.skill}` : "",
    `- ${t.history.filter((r) => r.meta.kind === "prompt").length} earlier message(s) in this chat`,
  ].filter(Boolean)
  const hits = t.knowledge.search(String((t.prompt.meta as { text?: string }).text ?? ""), {
    limit: 3,
  })
  if (hits.length)
    lines.push(
      "",
      "Pages that match your question:",
      ...hits.map((h) => `- [${h.title}](${t.knowledge.url(h.slug)})`),
    )
  const text = lines.join("\n")
  t.send("delta", { text })
  const usage = emptyUsage()
  return {
    rows: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        meta: { kind: "reply", model: "offline", usage, opened: [] },
      },
    ],
    usage,
    tools: [],
    stopped: false,
  }
}

async function makeTitle(env: Env, deps: GptDeps, text: string, page?: string): Promise<string> {
  const fallback = (text || page || "New chat").replace(/\s+/g, " ").slice(0, 60)
  if (!env.ANTHROPIC_API_KEY || isBridge(env)) return fallback
  try {
    const response = await client(env, deps).messages.create({
      model: "claude-sonnet-5",
      max_tokens: 64,
      thinking: { type: "disabled" },
      system:
        "Write a 3–7 word title for a chat that starts with the message below. Reply with the title only: no quotes, no trailing period.",
      messages: [
        {
          role: "user",
          content: (page ? `(asked on the page "${page}")\n` : "") + text.slice(0, 2000),
        },
      ],
    })
    const title = response.content
      .find((b) => b.type === "text")
      ?.text.trim()
      .replace(/^["']|["'.]$/g, "")
    return title ? title.slice(0, 80) : fallback
  } catch {
    return fallback
  }
}

// ---- history as the UI shows it ----

export interface DisplayCitation {
  title: string
  url: string
  cited_text: string
}

export type DisplayBlock =
  | { type: "text"; text: string; citations: DisplayCitation[] }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; label: string; summary?: string; is_error?: boolean }
  | { type: "compaction" }

export type DisplayTurn =
  | {
      role: "user"
      id: number
      at: number
      text: string
      mentions: ResolvedRef["label"][]
      files: Array<{ id: string; name: string; mime: string }>
      skill: string | null
    }
  | {
      role: "assistant"
      id: number
      at: number
      model: string
      blocks: DisplayBlock[]
      usage: unknown
      opened: ResolvedRef["label"][]
      stopped?: boolean
    }

/** Stored API rows → one user turn per prompt and one assistant turn per reply (tool rounds folded in). */
export function displayTurns(rows: StoredMessage[]): DisplayTurn[] {
  const out: DisplayTurn[] = []
  const docs = new Map<string, string>() // document title → site URL, for citation links
  let reply: Extract<DisplayTurn, { role: "assistant" }> | null = null
  const tools = new Map<string, Extract<DisplayBlock, { type: "tool" }>>()
  for (const row of rows) {
    for (const block of row.content as Array<Record<string, unknown>>) collectDocs(block, docs)
    const meta = row.meta ?? {}
    if (row.role === "user" && meta.kind === "prompt") {
      reply = null
      out.push({
        role: "user",
        id: row.id,
        at: row.created_at,
        text: String(meta.text ?? ""),
        mentions: (meta.mentions as ResolvedRef["label"][]) ?? [],
        files: (meta.files as Array<{ id: string; name: string; mime: string }>) ?? [],
        skill: (meta.skill as string | null) ?? null,
      })
      continue
    }
    if (row.role === "user") {
      for (const t of (meta.tools as Array<{ id: string; summary: string; is_error: boolean }>) ??
        []) {
        const chip = tools.get(t.id)
        if (chip) Object.assign(chip, { summary: t.summary, is_error: t.is_error })
      }
      continue
    }
    if (!reply) {
      reply = {
        role: "assistant",
        id: row.id,
        at: row.created_at,
        model: String(meta.model ?? ""),
        blocks: [],
        usage: null,
        opened: [],
      }
      out.push(reply)
    }
    if (meta.usage) reply.usage = meta.usage
    if (meta.opened) reply.opened = meta.opened as ResolvedRef["label"][]
    if (meta.stopped) reply.stopped = true
    for (const block of row.content as Array<Record<string, unknown>>) {
      if (block.type === "text") {
        const citations = ((block.citations as Array<Record<string, unknown>>) ?? []).map((c) =>
          citation(c, docs),
        )
        const prev = reply.blocks[reply.blocks.length - 1]
        // Cited answers arrive as many small text blocks; merge them back into paragraphs.
        if (prev?.type === "text") {
          prev.text += String(block.text)
          prev.citations.push(...citations.map((c) => ({ ...c })))
          if (citations.length) prev.text += marker(prev.citations, citations)
        } else {
          const b: DisplayBlock = { type: "text", text: String(block.text), citations: [] }
          b.citations.push(...citations)
          if (citations.length) b.text += marker(b.citations, citations)
          reply.blocks.push(b)
        }
      } else if (block.type === "thinking" && block.thinking) {
        reply.blocks.push({ type: "thinking", text: String(block.thinking) })
      } else if (block.type === "tool_use") {
        const chip = {
          type: "tool" as const,
          id: String(block.id),
          name: String(block.name),
          label: describeCall(String(block.name), (block.input ?? {}) as Record<string, unknown>),
        }
        tools.set(chip.id, chip)
        reply.blocks.push(chip)
      } else if (block.type === "compaction") {
        reply.blocks.push({ type: "compaction" })
      }
    }
  }
  return out
}

/** Footnote markers like [^1][^2] for the citations just added (the UI turns them into chips). */
function marker(all: DisplayCitation[], added: DisplayCitation[]): string {
  const start = all.length - added.length
  return added.map((_, i) => `[^${start + i + 1}]`).join("")
}

function citation(c: Record<string, unknown>, docs: Map<string, string>): DisplayCitation {
  if (c.type === "search_result_location")
    return {
      title: String(c.title ?? c.source ?? ""),
      url: String(c.source ?? ""),
      cited_text: String(c.cited_text ?? ""),
    }
  const title = String(c.document_title ?? "")
  return { title, url: docs.get(title) ?? "", cited_text: String(c.cited_text ?? "") }
}

function collectDocs(block: Record<string, unknown>, docs: Map<string, string>) {
  if (
    (block.type === "document" || block.type === "hafezi_blob") &&
    typeof block.title === "string"
  ) {
    const url = String(block.context ?? "").split(" ")[0]
    if (/^https?:\/\//.test(url)) docs.set(block.title, url)
  }
  if (Array.isArray(block.content))
    for (const inner of block.content)
      if (inner && typeof inner === "object") collectDocs(inner as Record<string, unknown>, docs)
}
