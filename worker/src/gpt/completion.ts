import { HttpError } from "../http"

// Ghost text: the lab's inline completer (jupyterlite-ai's, or hafezi-lab's context-aware one)
// asks for the code at the cursor, and a model sometimes answers with prose instead ("I need more
// context… What programming language is this?"), wraps the code in Markdown fences, or repeats
// the code before the cursor. Through the claude-bridge it also sits under Claude Code's own
// framing, which pulls it toward chatting. So a completion gets a strict code-only contract after
// its completer's prompt and stops at the fence that closes its code (jupyter-ai's stop), and its
// answer is cleaned with jupyter-ai's post-processing and dropped when it is still prose.

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

export interface CompletionContext {
  /** The document's language, when the prompt says it. */
  language?: string
  /** The code before the cursor, as far as the prompt shows it ("" when it can't be told). */
  prefix: string
  /** Whether prose would be out of place at the cursor (not in Markdown, a comment or a string). */
  guard: boolean
}

const TEXT_LANGUAGES = /^(?:markdown|md|text|plain|plaintext|latex|tex|restructuredtext|rst)\b/i
// jupyter-ai's COMPLETION_DEFAULT_TEMPLATE, as hafezi-lab's completer fills it in.
const LANGUAGE = /^The document is called `[^`\n]*` and written in (.+?)\.?$/m
const TEMPLATE_CODE = /(?:^|\n)Complete the following code:[ \t]*\n+```[^\n]*\n/
// jupyterlite-ai's notebook prompt (_extractNotebookContext).
const NOTEBOOK_CODE = /(?:^|\n)# Code before cursor:\n\n/
const NOTEBOOK_END = "\n\n# Complete the code at cursor position"
const CURRENT_CELL = "\n\n# Current cell:\n"

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  const last = [...messages].reverse().find((m) => m?.role === "user")
  if (typeof last?.content === "string") return last.content
  if (!Array.isArray(last?.content)) return ""
  return last.content
    .map((block: any) =>
      block?.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("")
}

/** What the completion is for: the language and the code before the cursor, from its prompt. */
export function completionContext(messages: unknown): CompletionContext {
  const text = lastUserText(messages)
  const language = text.match(LANGUAGE)?.[1]?.trim() || undefined
  let prefix: string
  const template = text.match(TEMPLATE_CODE)
  const notebook = text.match(NOTEBOOK_CODE)
  if (template) prefix = text.slice(template.index! + template[0].length)
  else if (notebook) {
    const start = notebook.index! + notebook[0].length
    const end = text.indexOf(NOTEBOOK_END, start)
    prefix = text.slice(start, end < 0 ? undefined : end)
    const current = prefix.lastIndexOf(CURRENT_CELL)
    if (current >= 0) prefix = prefix.slice(current + CURRENT_CELL.length)
  } else if (/\bComplete the code at cursor position\b/.test(text)) prefix = ""
  else prefix = text // jupyterlite-ai's console and editor send the bare prefix
  return { language, prefix, guard: !TEXT_LANGUAGES.test(language ?? "") && !inWords(prefix) }
}

/** The cursor is inside a comment or a string, where words are what comes next. */
function inWords(prefix: string): boolean {
  const line = prefix.slice(prefix.lastIndexOf("\n") + 1)
  if (/#|\/\/|\(\*|^\s*(?:--|%)/.test(line)) return true
  if (((prefix.match(/"""|'''/g) ?? []).length & 1) === 1) return true
  const quotes = (quote: string) => (line.replace(/\\./g, "").split(quote).length - 1) & 1
  return quotes('"') === 1 || quotes("'") === 1
}

// ---- post_process_suggestion, from jupyter-ai ----
//
// Ported from jupyter-ai 2.31.6, jupyter_ai/completions/completion_utils.py
// (post_process_suggestion, https://github.com/jupyterlab/jupyter-ai), under its license:
//
//   Copyright (c) 2022, Project Jupyter. All rights reserved.
//
//   Redistribution and use in source and binary forms, with or without modification, are
//   permitted provided that the following conditions are met:
//   1. Redistributions of source code must retain the above copyright notice, this list of
//      conditions and the following disclaimer.
//   2. Redistributions in binary form must reproduce the above copyright notice, this list of
//      conditions and the following disclaimer in the documentation and/or other materials
//      provided with the distribution.
//   3. Neither the name of the copyright holder nor the names of its contributors may be used to
//      endorse or promote products derived from this software without specific prior written
//      permission.
//
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
//   IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
//   AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
//   CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
//   CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
//   SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
//   THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
//   OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
//   POSSIBILITY OF SUCH DAMAGE.

const MARKDOWN_IDENTIFIERS: Record<string, string[]> = { ipython: ["ipython", "python", "py"] }

/** Remove spurious fragments from the suggestion: a Markdown fence and the prefix it restates. */
export function postProcessSuggestion(
  suggestion: string,
  { language, prefix }: { language?: string; prefix: string },
): string {
  // gpt-4 tends to add "```python" or similar
  const lang = (language || "python").toLowerCase()
  const openings = [...(MARKDOWN_IDENTIFIERS[lang] ?? [lang]).map((id) => "```" + id), "```"]
  for (const opening of openings) {
    // ollama models tend to add spurious whitespace
    if (suggestion.trimStart().startsWith(opening)) {
      let rest = suggestion.trimStart().slice(opening.length)
      // (ours) a bare ``` opening leaves another language's tag behind, e.g. ```wolfram
      if (opening === "```") rest = rest.replace(/^[\w+#.-]+[ \t]*(?=\n)/, "")
      suggestion = rest.trimStart()
      // check for the prefix inclusion (only if there was a bad opening)
      if (suggestion.startsWith(prefix)) suggestion = suggestion.slice(prefix.length)
      break
    }
  }
  // check if the suggestion ends with a closing markdown identifier and remove it
  if (suggestion.trimEnd().endsWith("```")) suggestion = suggestion.trimEnd().slice(0, -3).trimEnd()
  return suggestion
}

// ---- the prose guard (ours) ----

// How an answer to the member, rather than their code, starts. Case matters, and so does what
// follows: code has `let me`, `I = …`, `Hello()` or `Note: int`, never "Let me", "I need",
// "Hello," or "Note: The".
const OPENER =
  /^(?:I(?:'m|'d|'ll|’m|’d|’ll| am| need| can(?:'t|’t|not)?| cannot| would| will| don't| don’t| do not| see| notice| think| understand| apologi[sz]e)\b|(?:Could|Can|Would|Will) you\b|Please (?:provide|share|clarify|specify|tell|give|let)\b|(?:Sure|Certainly|Of course|Unfortunately|Sorry|Hello|Hi there)(?:[,!.:]| I\b)|Here(?:'s|’s| is| are)\b|(?:It|This|That) (?:looks|seems|appears|is unclear)\b|Without (?:more|additional|further|knowing)\b|To (?:complete|help|finish)\b|Based on\b|(?:What|Which) (?:programming )?language\b|(?:What|How) (?:would|do|should) you\b|Let me\b|You (?:need|should|could|can|might|want)\b|The (?:code|snippet|fragment|completion|cursor|context) (?:you|is|seems|appears|provided|above)\b|(?:This|That|The) (?:code|cell|snippet|line|input) (?:has|was|is|looks|seems|appears|already|will|would|can)\b|(?:Note|Explanation): [A-Z]|\d+\. [A-Z][a-z]+ [a-z])/
// A question, or a plain sentence: words only (no code's operators, brackets, digits or dots).
const QUESTION = /^[A-Z][\w'’-]*(?:,? [\w'’-]+){2,}\?$/
const SENTENCE = /^[A-Z][a-z'’]*(?:,? [A-Za-z'’-]+){3,}[.!:…]$/
const NOTHING =
  /^(?:[([](?:nothing|no completion|empty)[)\]]|No (?:completion|suggestion)(?: is)?(?: needed)?\.?)$/i

// A line's first sentence: "This code has already been executed." of a line that goes on.
const FIRST_SENTENCE = /^.*?[.!?:…](?=\s|$)/

/** An answer that talks to the member instead of completing their code. */
export function looksLikeProse(text: string): boolean {
  const first = text.trim().split("\n")[0].trim()
  if (!first) return false
  const sentence = first.match(FIRST_SENTENCE)?.[0] ?? first
  return (
    [first, sentence].some((s) => OPENER.test(s) || QUESTION.test(s) || SENTENCE.test(s)) ||
    NOTHING.test(first)
  )
}

/**
 * A completion's text as it goes back: cleaned, without the code before the cursor restated
 * (jupyter-ai strips it only after a fence), and nothing at all when it is prose (with code, a
 * paragraph of prose after it is dropped).
 */
export function cleanCompletion(text: string, context: CompletionContext): string {
  let cleaned = postProcessSuggestion(text, context)
  const { prefix } = context
  const line = prefix.slice(prefix.lastIndexOf("\n") + 1).trimStart()
  for (const restated of [prefix, line])
    if (restated.trim().length >= 3 && cleaned.startsWith(restated)) {
      cleaned = cleaned.slice(restated.length)
      if (/\s$/.test(prefix)) cleaned = cleaned.replace(/^[ \t]+/, "")
      break
    }
  if (!context.guard) return cleaned
  if (looksLikeProse(cleaned)) return ""
  // Code, then a paragraph about it: the code alone.
  const lines = cleaned.split("\n")
  const talk = lines.findIndex((l, i) => i > 0 && !lines[i - 1].trim() && looksLikeProse(l))
  return talk > 0 ? lines.slice(0, talk).join("\n").trimEnd() : cleaned
}
