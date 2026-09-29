import type { Auditor } from "../audit"
import type { Env } from "../env"
import { HttpError, decodeSegment, json, readLimited } from "../http"
import { DEFAULT_MODEL } from "./models"
import type { GptStore } from "./store"

// The lab's AI chats: jupyterlite-ai saves each chat by name as JSON ("<name>.chat"). The lab
// extension gives it a drive that lands here instead of the member's home, so every lab chat is
// a Hafezi GPT conversation: the JSON as saved goes to R2 (it restores the chat exactly, tool
// calls and attachments included), and its text goes to gpt_messages for /gpt. The lab stays the
// chat's author: each save replaces the text, and /gpt shows it read-only (fork to continue).

export const MAX_LAB_CHAT_BYTES = 5 * 1024 * 1024
// Each save rewrites the chat's text in one D1 batch, a statement per message: /gpt shows the
// latest MAX_TURNS, and a message (merged replies too) keeps MAX_TEXT characters, far under D1's
// 2 MB a row. The R2 copy keeps the whole chat for the lab.
export const MAX_TURNS = 200
export const MAX_TEXT = 100_000

export const labChatKey = (conversationId: string) => `gpt/lab-chats/${conversationId}.json`

/**
 * A chat's name as the lab gives it ("Hafezi GPT", "Hafezi GPT-1", or the member's own), in one
 * Unicode form (NFC), so a name typed two ways is one chat. Controls and invisible format
 * characters (bidi overrides, zero-width spaces) would make two names look the same: refused.
 */
export function labChatName(raw: string): string {
  const name = raw.normalize("NFC").trim()
  if (!name || name.length > 120 || name.startsWith(".") || /[/\\\p{Cc}\p{Cf}]/u.test(name))
    throw new HttpError(
      422,
      "a lab chat's name is 1 to 120 characters, without slashes or invisible characters",
    )
  return name
}

export interface LabChat {
  messages: Array<Record<string, unknown>>
  users: Record<string, Record<string, unknown>>
  attachments?: Record<string, unknown>
  metadata?: { provider?: string; autosave?: boolean; title?: string }
}

export function parseLabChat(text: string): LabChat {
  let chat: unknown
  try {
    chat = JSON.parse(text)
  } catch {
    throw new HttpError(422, "a lab chat is JSON")
  }
  const c = chat as Partial<LabChat> | null
  if (
    !c ||
    typeof c !== "object" ||
    !Array.isArray(c.messages) ||
    c.messages.some((m) => !m || typeof m !== "object") ||
    !c.users ||
    typeof c.users !== "object" ||
    Array.isArray(c.users)
  )
    throw new HttpError(422, "a lab chat has messages and users")
  return c as LabChat
}

export type TranscriptRow = {
  role: "user" | "assistant"
  content: unknown[]
  meta: Record<string, unknown>
}

/**
 * The chat's text as Hafezi GPT messages: the member's messages as prompts, everything the
 * assistant said merged into one reply per turn. Tool-call cards and deleted messages carry no
 * text and are left out; the R2 copy keeps them for the lab.
 */
export function labTranscript(chat: LabChat, model: string): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const message of chat.messages) {
    if (message.deleted || message.mime_model) continue
    const text = typeof message.body === "string" ? message.body.trim().slice(0, MAX_TEXT) : ""
    if (!text) continue
    const sender = chat.users[String(message.sender)]
    const role = sender?.bot || String(message.sender) !== "user" ? "assistant" : "user"
    // A conversation opens with the member (a fork continues it through the Messages API).
    if (!rows.length && role === "assistant") continue
    const last = rows[rows.length - 1]
    if (last?.role === role) {
      const block = last.content[0] as { text: string }
      block.text = (block.text + "\n\n" + text).slice(0, MAX_TEXT)
      if (role === "user") last.meta.text = block.text
      continue
    }
    rows.push(
      role === "user"
        ? { role, content: [{ type: "text", text }], meta: { kind: "prompt", text, lab: true } }
        : { role, content: [{ type: "text", text }], meta: { model, lab: true } },
    )
  }
  const kept = rows.slice(-MAX_TURNS)
  return kept[0]?.role === "assistant" ? kept.slice(1) : kept
}

export const labChatTitle = (chat: LabChat, name: string) =>
  (typeof chat.metadata?.title === "string" && chat.metadata.title.trim().slice(0, 120)) || name

/** /api/gpt/lab-chats[/<name>]: list, read, save and delete the member's lab chats. */
export async function labChatRoutes(
  request: Request,
  path: string,
  env: Env,
  ctx: ExecutionContext,
  store: GptStore,
  login: string,
  write: () => void,
  record: Auditor,
): Promise<Response | null> {
  const method = request.method
  if (path === "/lab-chats") {
    if (method !== "GET") throw new HttpError(405, "method not allowed")
    return json(await store.labChats(login))
  }
  const match = path.match(/^\/lab-chats\/([^/]+)$/)
  if (!match) return null
  const name = labChatName(decodeSegment(match[1]))
  const existing = await store.labChat(login, name)
  if (method === "GET") {
    const object = existing ? await env.ARTIFACTS.get(labChatKey(existing.id)) : null
    if (!object) throw new HttpError(404, "no lab chat by that name")
    return new Response(object.body, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    })
  }
  write()
  if (method === "PUT") {
    // A rename in the lab writes the new name, then deletes the old one: with If-None-Match: *,
    // a save only creates, so a rename onto another chat's name can't overwrite that chat.
    const createOnly = request.headers.get("if-none-match")?.trim() === "*"
    const taken = `a lab chat named "${name}" already exists`
    if (createOnly && existing) throw new HttpError(409, taken)
    const bytes = await readLimited(
      request,
      MAX_LAB_CHAT_BYTES,
      "this chat is too large to save (5 MB at most)",
    )
    // The lab saves every chat again each time it loads: a save of what is stored already changes
    // nothing, so /gpt keeps the chat's time and place in the list.
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    if (existing) {
      const stored = await env.ARTIFACTS.head(labChatKey(existing.id))
      if (stored?.customMetadata?.sha256 === digest) {
        record.recorded = true
        return json({ name, conversation_id: existing.id, updated_at: existing.updated_at })
      }
    }
    const text = new TextDecoder().decode(bytes)
    const chat = parseLabChat(text)
    const model = existing?.model ?? DEFAULT_MODEL
    const conversation = await store.saveLabChat(
      login,
      name,
      labChatTitle(chat, name),
      model,
      labTranscript(chat, model),
      { createOnly },
    )
    if (!conversation) throw new HttpError(409, taken)
    await env.ARTIFACTS.put(labChatKey(conversation.id), text, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { sha256: digest },
    })
    // Autosave writes every few seconds while a chat is open: only its first save is audited.
    if (existing) record.recorded = true
    else record("gpt.lab_chat.create", conversation.id, { name })
    return json({ name, conversation_id: conversation.id, updated_at: conversation.updated_at })
  }
  if (method === "DELETE") {
    if (!existing) throw new HttpError(404, "no lab chat by that name")
    const keys = await store.deleteConversation(existing.id)
    ctx.waitUntil(env.ARTIFACTS.delete([...keys, labChatKey(existing.id)]))
    record("gpt.conversation.delete", existing.id, { lab_name: name })
    return json({ deleted: existing.id })
  }
  throw new HttpError(405, "method not allowed")
}
