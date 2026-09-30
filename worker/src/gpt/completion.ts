import { HttpError } from "../http"

// Ghost text: the lab's inline completer (jupyterlite-ai's, or hafezi-lab's context-aware one)
// asks for the code at the cursor, and a model sometimes answers with prose instead ("I need more
// context… What programming language is this?") or wraps the code in Markdown fences. Through the
// claude-bridge it also sits under Claude Code's own framing, which pulls it toward chatting. So a
// completion gets a strict code-only contract after its completer's prompt and stops at the fence
// that closes its code (jupyter-ai's stop).

/** Said after the completer's own prompt, whatever that says. */
export const COMPLETION_CONTRACT = `Strict output contract: your whole reply is inserted verbatim into the member's editor at the cursor, as ghost text.
- Reply with code only: the text that continues the code at the cursor, in the document's language.
- Never write prose, explanations, questions, apologies, greetings or Markdown code fences, and never repeat the code before the cursor.
- If the context is thin, give the most likely short continuation; if there is none, reply with nothing at all. Never ask for more context.`

/** jupyter-ai's stop (template_inputs_from_request): the fence that closes the code its prompt opens. */
export const COMPLETION_STOP = "\n```"

/** jupyterlite-ai asks for a chat's title the way its completer asks for code (requestTitle). */
const TITLE_REQUEST = /\btitle\b[^.\n]*\bconversation\b/i

const systemText = (system: unknown): string =>
  typeof system === "string"
    ? system
    : Array.isArray(system)
      ? system.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n")
      : ""

/** A request for a chat's title, which is prose on purpose, rather than for code. */
export const isTitleRequest = (system: unknown) => TITLE_REQUEST.test(systemText(system))

/** The completer's system prompt with the contract after it, in the form it came. */
export function withCompletionContract(system: unknown): string | unknown[] {
  if (system === undefined || system === null) return COMPLETION_CONTRACT
  if (typeof system === "string")
    return system.trim() ? `${system}\n\n${COMPLETION_CONTRACT}` : COMPLETION_CONTRACT
  if (Array.isArray(system)) return [...system, { type: "text", text: COMPLETION_CONTRACT }]
  throw new HttpError(422, "system must be a string or a list of text blocks")
}

/** The client's stop sequences, and the closing fence. */
export function completionStops(sent: unknown): string[] {
  const own = Array.isArray(sent) ? sent.filter((s) => typeof s === "string" && s) : []
  return [...new Set([...own, COMPLETION_STOP])]
}
