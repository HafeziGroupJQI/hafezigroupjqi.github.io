import type Anthropic from "@anthropic-ai/sdk"
import type { Upstream } from "../docs"
import type { DocumentEntry, Env } from "../env"
import { HttpError } from "../http"
import type { Knowledge, Page } from "./knowledge"
import type { Skill } from "./skills"
import type { FileRow, Project } from "./store"

// Builds what Claude sees, in cache-friendly order:
//   tools (fixed) → system[0] persona + skill index → system[1] project knowledge  ← 1 h breakpoint
//   → system[2] who/when (small) → the conversation (automatic caching on its tail).
// History is append-only and replayed byte-for-byte: page text is stored inline in the message,
// binaries (PDFs, images) are snapshotted to R2 once and stored as a `hafezi_blob` reference that
// is swapped for base64 at send time — so a later deploy never rewrites an earlier turn.

type Block = Anthropic.Beta.BetaContentBlockParam
type SystemBlock = Anthropic.Beta.BetaTextBlockParam

/** Roughly 4 characters per token; good enough for budgets and the context meter. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

/** How much project knowledge goes into the cached prefix before the rest is left to read_page. */
export const PROJECT_TOKEN_BUDGET = 150_000
const MAX_PAGE_CHARS = 200_000
const MAX_TEXT_FILE_CHARS = 400_000
const MAX_BINARY_BYTES = 20 * 1024 * 1024

export const BLOB_PREFIX = "gpt/blobs/"

/** A reference stored in history in place of base64. */
export interface BlobRef {
  type: "hafezi_blob"
  key: string
  block: "document" | "image"
  media_type: string
  title?: string
  context?: string
}

const PERSONA = `You are Hafezi GPT, the research assistant of the Hafezi lab (Joint Quantum Institute, University of Maryland): integrated and topological photonics, frequency combs, quantum optics, and the lab's instruments and code.

You answer lab members, who are physicists and engineers. Be direct and technically precise, and match depth to the question. Use Markdown; write math in LaTeX ($…$ inline, $$…$$ display). Put code in fenced blocks with a language.

Ground answers in the lab's own material:
- The lab site (public pages plus the members-only resources/ section: onboarding, notes, projects, code, library, equipment records and documents) is your knowledge base. Search it with search_site, list it by tag with list_pages, and read pages or documents with read_page before answering questions about the lab's setups, instruments, projects, people or procedures.
- Cite what you use. Documents and search results you receive support citations; for pages in the project knowledge below, link them inline as Markdown links to their URL.
- Never invent instrument commands (SCPI or vendor APIs), wiring, settings or safety limits. Look them up (the library page "instrument-control-and-calibration" and resources/files/instrument-control/ hold the lab's working scripts); if you can't find them, say so and say where to check.
- If the material doesn't answer the question, say what you found and what's missing rather than guessing. General physics and engineering knowledge is fine; label it as such when it matters.
- Uploaded files and @-mentioned pages in a message are what the member is asking about; prefer them.

Skills are step-by-step procedures for recurring lab tasks. When a request matches a skill's description, call use_skill with its name first and follow what it returns.`

export function systemBlocks(opts: {
  skills: Skill[]
  project: Project | null
  knowledge: string
  user: { login: string; name: string }
  now?: Date
}): SystemBlock[] {
  const skillIndex = opts.skills.length
    ? "\n\nAvailable skills:\n" +
      opts.skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ")}`).join("\n")
    : ""
  const blocks: SystemBlock[] = [{ type: "text", text: PERSONA + skillIndex }]
  if (opts.project) {
    const p = opts.project
    blocks.push({
      type: "text",
      text:
        `<project name="${escapeAttr(p.name)}">\n` +
        (p.description ? `<description>${p.description}</description>\n` : "") +
        (p.instructions ? `<instructions>\n${p.instructions}\n</instructions>\n` : "") +
        (opts.knowledge ? `<knowledge>\n${opts.knowledge}\n</knowledge>\n` : "") +
        "</project>\nThe member is working in this project. Follow its instructions and rely on its knowledge first.",
    })
  }
  // One-hour breakpoint after the stable part: persona, skills and the project corpus are
  // reused across turns and across members of a group project.
  blocks[blocks.length - 1].cache_control = { type: "ephemeral", ttl: "1h" }
  const now = opts.now ?? new Date()
  blocks.push({
    type: "text",
    text: `The member is ${opts.user.name} (@${opts.user.login}). Today is ${now.toISOString().slice(0, 10)}.`,
  })
  return blocks
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

export interface ProjectKnowledge {
  text: string
  included: Array<{
    slug: string
    title: string
    tokens: number
    source: "topic" | "pinned" | "file"
  }>
  overflow: Array<{ slug: string; title: string; tokens: number }>
  tokens: number
}

/** The project's pages (topics + pinned, by slug) and text files, up to the token budget. */
export async function projectKnowledge(
  project: Project,
  knowledge: Knowledge,
  files: FileRow[],
  env: Env,
): Promise<ProjectKnowledge> {
  const pages = new Map<string, { page: Page; source: "topic" | "pinned" }>()
  for (const slug of project.pinned) {
    const hit = knowledge.resolve(slug)
    if (hit?.kind === "page") pages.set(hit.page.slug, { page: hit.page, source: "pinned" })
  }
  for (const topic of project.topics)
    for (const page of knowledge.byTag(topic))
      if (!pages.has(page.slug)) pages.set(page.slug, { page, source: "topic" })
  const out: ProjectKnowledge = { text: "", included: [], overflow: [], tokens: 0 }
  const parts: string[] = []
  // Pinned pages first, then the rest by slug: deterministic, so the cached prefix is stable.
  const ordered = [...pages.values()].sort((a, b) =>
    a.source === b.source ? a.page.slug.localeCompare(b.page.slug) : a.source === "pinned" ? -1 : 1,
  )
  for (const { page, source } of ordered) {
    const body = page.content.slice(0, MAX_PAGE_CHARS)
    const tokens = estimateTokens(body)
    if (out.tokens + tokens > PROJECT_TOKEN_BUDGET) {
      out.overflow.push({ slug: page.slug, title: page.title, tokens })
      continue
    }
    parts.push(
      `<page title="${escapeAttr(page.title)}" url="${knowledge.url(page.slug)}" tags="${escapeAttr(page.tags.join(" "))}">\n${body}\n</page>`,
    )
    out.included.push({ slug: page.slug, title: page.title, tokens, source })
    out.tokens += tokens
  }
  for (const file of files) {
    if (!isTextMime(file.mime, file.name)) continue
    const object = await env.ARTIFACTS.get(file.r2_key)
    if (!object) continue
    const body = (await object.text()).slice(0, MAX_TEXT_FILE_CHARS)
    const tokens = estimateTokens(body)
    if (out.tokens + tokens > PROJECT_TOKEN_BUDGET) {
      out.overflow.push({ slug: `file:${file.id}`, title: file.name, tokens })
      continue
    }
    parts.push(`<file name="${escapeAttr(file.name)}" id="${file.id}">\n${body}\n</file>`)
    out.included.push({ slug: `file:${file.id}`, title: file.name, tokens, source: "file" })
    out.tokens += tokens
  }
  if (out.overflow.length)
    parts.push(
      '<not_loaded note="Also in this project but over the context budget; read them with read_page when relevant.">\n' +
        out.overflow
          .map(
            (o) => `- ${o.title} (${o.slug.startsWith("file:") ? o.slug : knowledge.url(o.slug)})`,
          )
          .join("\n") +
        "\n</not_loaded>",
    )
  out.text = parts.join("\n\n")
  return out
}

// ---- files and documents ----

const TEXT_EXT =
  /\.(txt|md|markdown|qmd|py|m|jl|c|h|cpp|hpp|rs|go|js|ts|json|ipynb|csv|tsv|yaml|yml|toml|ini|cfg|tex|bib|log|spt|html|xml|sh|ps1)$/i

export function isTextMime(mime: string, name = ""): boolean {
  return (
    mime.startsWith("text/") ||
    /^application\/(json|xml|yaml|x-yaml|x-python|javascript|x-tex|x-sh|x-ipynb\+json)(;|$)/.test(
      mime,
    ) ||
    TEXT_EXT.test(name)
  )
}

export function uploadKind(mime: string, name: string): "pdf" | "image" | "text" | null {
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf"
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) return "image"
  if (isTextMime(mime, name)) return "text"
  return null
}

function textDocument(title: string, context: string, data: string): Block {
  return {
    type: "document",
    source: { type: "text", media_type: "text/plain", data },
    title,
    context,
    citations: { enabled: true },
  }
}

/** Snapshot a vault-private binary into R2 (keyed by its immutable git blob sha). */
async function snapshotDocument(
  env: Env,
  entry: DocumentEntry,
  upstream: Upstream,
): Promise<string> {
  const key = `${BLOB_PREFIX}${entry.sha}`
  if (await env.ARTIFACTS.head(key)) return key
  if (!env.GITHUB_DOCS_TOKEN) throw new HttpError(503, "the document store is not configured")
  const blob = await upstream(
    `https://api.github.com/repos/${env.DOCS_REPO}/git/blobs/${entry.sha}`,
    {
      headers: {
        accept: "application/vnd.github.raw+json",
        authorization: `Bearer ${env.GITHUB_DOCS_TOKEN}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "hafezi-members-worker",
      },
    },
  )
  if (!blob.ok) throw new HttpError(502, "the document store is unavailable")
  await env.ARTIFACTS.put(key, await blob.arrayBuffer(), {
    httpMetadata: { contentType: entry.contentType },
  })
  return key
}

export interface ResolvedRef {
  blocks: Block[]
  label: { ref: string; title: string; url: string; kind: "page" | "document" | "file" }
}

/** A site page or private document as message content (used by @-mentions, the page modal and read_page). */
export async function refContent(
  ref: string,
  knowledge: Knowledge,
  env: Env,
  upstream: Upstream,
  { offset = 0, maxChars = MAX_PAGE_CHARS }: { offset?: number; maxChars?: number } = {},
): Promise<ResolvedRef> {
  const hit = knowledge.resolve(ref)
  if (!hit) throw new HttpError(422, `no page or document named "${ref}" on the site`)
  if (hit.kind === "page") {
    const { page } = hit
    const url = knowledge.url(page.slug)
    const body = page.content.slice(offset, offset + maxChars)
    const more = offset + maxChars < page.content.length
    const title = page.title
    const context = `${url}${page.tags.length ? ` · tags: ${page.tags.join(", ")}` : ""}${
      offset || more
        ? ` · characters ${offset}–${offset + body.length} of ${page.content.length}`
        : ""
    }`
    return {
      blocks: [textDocument(title, context, body || "(this page has no text)")],
      label: { ref: page.slug, title, url, kind: "page" },
    }
  }
  const { path, entry } = hit
  const name = path.split("/").pop() ?? path
  const url = knowledge.url(path)
  const label = { ref: path, title: name, url, kind: "document" as const }
  if (entry.size > MAX_BINARY_BYTES)
    return {
      blocks: [
        {
          type: "text",
          text: `[${name} is ${(entry.size / 1e6).toFixed(0)} MB, too large to read here: ${url}]`,
        },
      ],
      label,
    }
  const kind = uploadKind(entry.contentType, name)
  if (kind === "text") {
    const key = await snapshotDocument(env, entry, upstream)
    const text = (await (await env.ARTIFACTS.get(key))!.text()).slice(
      offset,
      offset + MAX_TEXT_FILE_CHARS,
    )
    return { blocks: [textDocument(name, url, text)], label }
  }
  if (kind === "pdf" || kind === "image") {
    const key = await snapshotDocument(env, entry, upstream)
    const blob: BlobRef = {
      type: "hafezi_blob",
      key,
      block: kind === "pdf" ? "document" : "image",
      media_type: kind === "pdf" ? "application/pdf" : entry.contentType,
      title: name,
      context: url,
    }
    return { blocks: [blob as unknown as Block], label }
  }
  return {
    blocks: [
      {
        type: "text",
        text: `[${name} (${entry.contentType}) can't be read here; members can open it at ${url}]`,
      },
    ],
    label,
  }
}

/** An uploaded file as message content. */
export async function fileContent(file: FileRow, env: Env): Promise<Block[]> {
  const kind = uploadKind(file.mime, file.name)
  const context = `uploaded file ${file.id}`
  if (kind === "text") {
    const object = await env.ARTIFACTS.get(file.r2_key)
    if (!object) throw new HttpError(404, `${file.name} is no longer stored`)
    return [textDocument(file.name, context, (await object.text()).slice(0, MAX_TEXT_FILE_CHARS))]
  }
  if (kind === "pdf" || kind === "image") {
    const blob: BlobRef = {
      type: "hafezi_blob",
      key: file.r2_key,
      block: kind === "pdf" ? "document" : "image",
      media_type: kind === "pdf" ? "application/pdf" : file.mime,
      title: file.name,
      context,
    }
    return [blob as unknown as Block]
  }
  throw new HttpError(415, `${file.name}: only PDFs, images and text or code files can be read`)
}

// ---- replay ----

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ""
  for (let i = 0; i < view.length; i += 0x8000)
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Swap every hafezi_blob reference (at any depth, e.g. inside tool results) for base64 content. */
export async function hydrate<T>(
  content: T,
  env: Env,
  cache = new Map<string, string>(),
): Promise<T> {
  if (Array.isArray(content))
    return (await Promise.all(content.map((c) => hydrate(c, env, cache)))) as T
  if (!content || typeof content !== "object") return content
  const block = content as Record<string, unknown>
  if (block.type === "hafezi_blob") {
    const ref = block as unknown as BlobRef
    let data = cache.get(ref.key)
    if (data === undefined) {
      const object = await env.ARTIFACTS.get(ref.key)
      if (!object)
        return { type: "text", text: `[${ref.title ?? "a file"} is no longer available]` } as T
      data = base64(await object.arrayBuffer())
      cache.set(ref.key, data)
    }
    if (ref.block === "image")
      return { type: "image", source: { type: "base64", media_type: ref.media_type, data } } as T
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data },
      ...(ref.title ? { title: ref.title } : {}),
      ...(ref.context ? { context: ref.context } : {}),
      citations: { enabled: true },
    } as T
  }
  if (Array.isArray(block.content))
    return { ...block, content: await hydrate(block.content, env, cache) } as T
  return content
}
