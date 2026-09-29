import type Anthropic from "@anthropic-ai/sdk"
import type { Upstream } from "../docs"
import type { Env } from "../env"
import { HttpError } from "../http"
import { type ResolvedRef, fileContent, refContent, uploadKind } from "./context"
import type { Knowledge } from "./knowledge"
import type { Skill } from "./skills"
import type { Conversation, GptStore } from "./store"

// The tools Hafezi GPT can call. All client-side and read-only: they search and read the lab
// site (public + members-only), the member's uploads in this chat or project, and skills.
// Results that come from the site are search_result / document blocks, so the answer's
// citations point at real pages.

type ToolResultContent = Exclude<
  Anthropic.Beta.BetaToolResultBlockParam["content"],
  string | undefined
>

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_site",
    description:
      "Full-text search over every page of the Hafezi lab site, including the members-only resources (onboarding, notes, projects, code, library, equipment records). Returns the best-matching pages with snippets. Use specific terms: instrument models, techniques, project names, people.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional tag filters, e.g. ["equipment/laser"] or ["project/tfln"]; a page matches if it has any of them or a tag below them.',
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Number of results (default 8)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_page",
    description:
      'Read a site page or members-only document in full: pass its slug, path or URL (e.g. "equipment/attenuator-wheel", "resources/library/instrument-control-and-calibration", or a PDF path under resources/files/). Long pages are paginated by character offset.',
    input_schema: {
      type: "object",
      properties: {
        page: { type: "string", description: "Slug, site path or URL" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset to continue a long page (default 0)",
        },
      },
      required: ["page"],
      additionalProperties: false,
    },
  },
  {
    name: "list_pages",
    description:
      'List site pages by tag, e.g. "project/topo-automation", "equipment/laser", "people/christopher-flower", "code", "onboarding". Pass a root like "project" to see its tags with page counts.',
    input_schema: {
      type: "object",
      properties: { tag: { type: "string", description: "A tag or tag root" } },
      required: ["tag"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      'Read a file the member uploaded to this chat or its project, by its file id (shown as "uploaded file <id>").',
    input_schema: {
      type: "object",
      properties: { file_id: { type: "string" } },
      required: ["file_id"],
      additionalProperties: false,
    },
  },
  {
    name: "use_skill",
    description:
      "Load a skill's full instructions by name (see the skill list in the system prompt), then follow them.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
]

export interface ToolContext {
  env: Env
  knowledge: Knowledge
  store: GptStore
  skills: Skill[]
  conversation: Conversation
  upstream: Upstream
  /** Pages/documents the model opened this turn, for the UI's source list. */
  opened: Map<string, ResolvedRef["label"]>
  /**
   * What is already in this turn (readKey, `file:<id>`): read by a tool or attached to the
   * member's message. Reading it again gets a note instead of the whole of it once more.
   */
  read?: Set<string>
}

export interface ToolOutcome {
  content: ToolResultContent
  isError?: boolean
  /** One line for the UI's tool chip ("Found 6 pages", "Read Keithley 2450 manual.pdf"). */
  summary: string
}

const str = (v: unknown) => (typeof v === "string" ? v : "")

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "search_site":
        return searchSite(input, ctx)
      case "read_page":
        return await readPage(input, ctx)
      case "list_pages":
        return listPages(input, ctx)
      case "read_file":
        return await readFile(input, ctx)
      case "use_skill":
        return useSkill(input, ctx)
      default:
        return {
          content: [{ type: "text", text: `Unknown tool ${name}` }],
          isError: true,
          summary: `Unknown tool ${name}`,
        }
    }
  } catch (error) {
    const detail = error instanceof HttpError ? error.detail : "the tool failed"
    if (!(error instanceof HttpError)) console.error("gpt tool", name, error)
    return { content: [{ type: "text", text: detail }], isError: true, summary: detail }
  }
}

function searchSite(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const query = str(input.query).trim()
  if (!query) throw new HttpError(422, "query is required")
  const tags = Array.isArray(input.tags)
    ? input.tags.filter((t): t is string => typeof t === "string")
    : []
  const limit = Math.min(20, Math.max(1, Number(input.limit) || 8))
  const hits = ctx.knowledge.search(query, { tags, limit })
  if (!hits.length)
    return {
      content: [
        { type: "text", text: `No pages match "${query}". Try other words or list_pages.` },
      ],
      summary: `No results for “${query}”`,
    }
  return {
    content: hits.map((hit) => ({
      type: "search_result" as const,
      source: ctx.knowledge.url(hit.slug),
      title: hit.title,
      content: [
        {
          type: "text" as const,
          text: `slug: ${hit.slug}${hit.tags.length ? ` · tags: ${hit.tags.join(", ")}` : ""}\n${hit.snippet}`,
        },
      ],
      citations: { enabled: true },
    })),
    summary: `Found ${hits.length} page${hits.length === 1 ? "" : "s"} for “${query}”`,
  }
}

/**
 * What read_page reads, however it was named: a page's slug or a document's path, with where in
 * it (only pages and text documents are read in parts; a PDF or picture comes whole).
 */
export function readKey(ref: string, offset: number, knowledge: Knowledge): string | null {
  const hit = knowledge.resolve(ref)
  if (!hit) return null
  if (hit.kind === "page") return `${hit.page.slug}@${offset}`
  return `${hit.path}@${uploadKind(hit.entry.contentType, hit.path) === "text" ? offset : 0}`
}

/** Read something once a turn: a model that asks again gets a note, not the content again. */
async function once(
  ctx: ToolContext,
  key: string | null,
  title: string,
  read: () => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  if (!key || !ctx.read) return read()
  if (ctx.read.has(key))
    return {
      content: [
        {
          type: "text",
          text: `${title} is already above, read or attached earlier in this turn: use that copy.`,
        },
      ],
      summary: `Already read ${title}`,
    }
  // Taken before the read, so two calls for it in one round send it once.
  ctx.read.add(key)
  try {
    return await read()
  } catch (error) {
    ctx.read.delete(key)
    throw error
  }
}

async function readPage(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const ref = str(input.page).trim()
  if (!ref) throw new HttpError(422, "page is required")
  const offset = Math.max(0, Number(input.offset) || 0)
  return once(ctx, readKey(ref, offset, ctx.knowledge), ref, async () => {
    const resolved = await refContent(ref, ctx.knowledge, ctx.env, ctx.upstream, {
      offset,
      maxChars: 60_000,
    })
    ctx.opened.set(resolved.label.ref, resolved.label)
    return {
      content: resolved.blocks as ToolResultContent,
      summary: `Read ${resolved.label.title}`,
    }
  })
}

function listPages(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const tag = str(input.tag).trim().replace(/^#/, "")
  if (!tag) throw new HttpError(422, "tag is required")
  if (!tag.includes("/")) {
    const topics = ctx.knowledge.topics([tag])[tag] ?? []
    const direct = ctx.knowledge.byTag(tag)
    const text =
      (topics.length
        ? `Tags under ${tag}/:\n${topics.map((t) => `- ${t.tag} (${t.count})`).join("\n")}\n\n`
        : "") +
      `${direct.length} pages tagged ${tag}:\n` +
      direct
        .slice(0, 80)
        .map((p) => `- ${p.title} — ${p.slug}`)
        .join("\n")
    return {
      content: [{ type: "text", text }],
      summary: `Listed ${direct.length} pages tagged ${tag}`,
    }
  }
  const pages = ctx.knowledge.byTag(tag)
  const text = pages.length
    ? pages.map((p) => `- ${p.title} — ${p.slug}`).join("\n")
    : `No pages are tagged ${tag}. Try list_pages with the root ("${tag.split("/")[0]}").`
  return {
    content: [{ type: "text", text }],
    summary: `Listed ${pages.length} pages tagged ${tag}`,
  }
}

async function readFile(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await ctx.store.file(str(input.file_id))
  const c = ctx.conversation
  // Only this chat's uploads, or its project's files.
  if (
    !file ||
    !(file.conversation_id === c.id || (file.project_id && file.project_id === c.project_id))
  )
    throw new HttpError(404, "no such file in this chat or its project")
  ctx.opened.set(`file:${file.id}`, {
    ref: `file:${file.id}`,
    title: file.name,
    url: "",
    kind: "file",
  })
  return once(ctx, `file:${file.id}`, file.name, async () => ({
    content: (await fileContent(file, ctx.env)) as ToolResultContent,
    summary: `Read ${file.name}`,
  }))
}

function useSkill(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const name = str(input.name).trim().replace(/^\//, "")
  const skill = ctx.skills.find((s) => s.name === name)
  if (!skill)
    throw new HttpError(
      404,
      `no skill named ${name}; available: ${ctx.skills.map((s) => s.name).join(", ")}`,
    )
  return {
    content: [{ type: "text", text: skillText(skill) }],
    summary: `Using skill ${skill.name}`,
  }
}

export function skillText(skill: Skill): string {
  const refs = skill.references.length
    ? `\n\n<references>\n${skill.references.map((r) => `<reference path="${r.path}">\n${r.content}\n</reference>`).join("\n")}\n</references>`
    : ""
  return `<skill name="${skill.name}">\n${skill.body}${refs}\n</skill>`
}

/** Short, safe one-liner of a tool call's input for the UI. */
export function describeCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "search_site":
      return `Searching the site for “${str(input.query)}”`
    case "read_page":
      return `Reading ${str(input.page)}`
    case "list_pages":
      return `Listing pages tagged ${str(input.tag)}`
    case "read_file":
      return `Reading an uploaded file`
    case "use_skill":
      return `Loading skill ${str(input.name)}`
    default:
      return name
  }
}
