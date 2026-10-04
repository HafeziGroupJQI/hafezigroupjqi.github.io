import type { Env } from "../env"
import type { Session } from "../session"
import { HttpError } from "../http"
import type { GptDeps } from "./chat"
import { loadKnowledge } from "./knowledge"
import { type ToolOutcome, TOOLS, runTool } from "./tools"
import type { Conversation, GptStore } from "./store"

// Hafezi GPT's site tools for the lab's coding agent (jupyterlite-ai, through the hafezi-lab
// provider): the same search_site, read_page and list_pages the site's chat uses, answered as
// plain text because the agent hands tool results to the model as text.

export const VAULT_TOOLS = ["search_site", "read_page", "list_pages"] as const

/** The tools' names, descriptions and input schemas, for the lab to declare them from. */
export const vaultToolSpecs = () =>
  TOOLS.filter((t) => (VAULT_TOOLS as readonly string[]).includes(t.name))

function asText(outcome: ToolOutcome): string {
  return outcome.content
    .map((block: any) => {
      if (block.type === "text") return block.text
      if (block.type === "search_result")
        return `## ${block.title}\n${block.source}\n${block.content.map((c: any) => c.text).join("\n")}`
      if (block.type === "document" && block.source?.type === "text")
        return `# ${block.title}\n${block.context ?? ""}\n\n${block.source.data}`
      if (block.type === "hafezi_blob")
        return `[${block.title} is a ${block.block === "image" ? "picture" : "PDF"}, which the lab's agent can't read; it is at ${block.context}]`
      return ""
    })
    .filter(Boolean)
    .join("\n\n")
}

export async function vaultTool(
  name: string,
  input: unknown,
  env: Env,
  store: GptStore,
  deps: GptDeps,
  session: Session,
): Promise<{ text: string; summary: string; is_error: boolean }> {
  if (!(VAULT_TOOLS as readonly string[]).includes(name)) throw new HttpError(404, "no such tool")
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(422, "the tool's input must be an object")
  const outcome = await runTool(name, input as Record<string, unknown>, {
    env,
    knowledge: await loadKnowledge(env, deps.manifest, session),
    store,
    skills: [],
    // These tools never touch a conversation (read_file and use_skill do, and aren't offered).
    conversation: {} as Conversation,
    upstream: deps.upstream,
    opened: new Map(),
  })
  return { text: asText(outcome), summary: outcome.summary, is_error: Boolean(outcome.isError) }
}
