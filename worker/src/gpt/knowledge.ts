import type { DocsManifest, DocumentEntry, Env } from "../env"

// What Hafezi GPT knows about the site: every page of the member edition (the Quartz content
// index, full text, public + private) and every private binary document (the docs manifest).
// Loaded once per isolate from the ASSETS build; searched with a small in-memory BM25.

export interface Page {
  slug: string
  title: string
  tags: string[]
  links: string[]
  content: string
}

interface RawEntry {
  slug?: string
  title?: string
  tags?: string[]
  links?: string[]
  content?: string
}

export interface SearchHit {
  slug: string
  title: string
  tags: string[]
  score: number
  snippet: string
}

// Generated tag listings and the tool pages themselves carry no knowledge.
const SKIP =
  /^(tags\/|calendar$|devices?$|instrument$|experiments?$|experiment-builder$|gpt$|admin$|404$)/

const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were with what which who how does do can i we our you".split(
    " ",
  ),
)

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_.+-]*[a-z0-9]|[a-z0-9]/g) ?? []).filter(
    (t) => !STOP.has(t),
  )
}

export class Knowledge {
  readonly pages = new Map<string, Page>()
  private index: {
    docs: Array<{ slug: string; tf: Map<string, number>; len: number }>
    df: Map<string, number>
    avg: number
  } | null = null

  constructor(
    entries: Record<string, RawEntry>,
    readonly documents: Record<string, DocumentEntry>,
    readonly siteUrl: string,
  ) {
    for (const [key, entry] of Object.entries(entries)) {
      const slug = entry.slug ?? key
      if (SKIP.test(slug)) continue
      this.pages.set(slug, {
        slug,
        title: entry.title || slug,
        tags: entry.tags ?? [],
        links: entry.links ?? [],
        content: (entry.content ?? "")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      })
    }
  }

  url(slug: string): string {
    const clean = slug.replace(/(^|\/)index$/, "$1")
    return `${this.siteUrl.replace(/\/$/, "")}/${clean}`
  }

  /** A site path, URL, or slug → the page or document it names, if any. */
  resolve(
    ref: string,
  ):
    { kind: "page"; page: Page } | { kind: "document"; path: string; entry: DocumentEntry } | null {
    let slug = ref.trim()
    try {
      if (/^https?:\/\//.test(slug)) slug = new URL(slug).pathname
    } catch {
      return null
    }
    slug = decodeURIComponent(slug)
      .replace(/^\/+/, "")
      .replace(/[?#].*$/, "")
    const document = this.documents[slug]
    if (document) return { kind: "document", path: slug, entry: document }
    slug = slug.replace(/\.(md|html)$/, "").replace(/\/$/, "/index")
    const page =
      this.pages.get(slug) ??
      this.pages.get(slug.replace(/\/index$/, "")) ??
      this.pages.get(`${slug}/index`)
    return page ? { kind: "page", page } : null
  }

  /** Pages carrying `tag` or any tag below it (project/tfln matches project/tfln/*), by slug. */
  byTag(tag: string): Page[] {
    const t = tag.replace(/^#/, "").replace(/\/$/, "")
    return [...this.pages.values()]
      .filter((p) => p.tags.some((x) => x === t || x.startsWith(t + "/")))
      .sort((a, b) => a.slug.localeCompare(b.slug))
  }

  /** Tag roots and their values, for the topic picker: { project: ["project/tfln", …], … }. */
  topics(
    roots = ["project", "research", "equipment", "code", "library", "onboarding", "people"],
  ): Record<string, Array<{ tag: string; count: number }>> {
    const counts = new Map<string, number>()
    for (const page of this.pages.values())
      for (const tag of page.tags)
        if (tag.includes("/")) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    const out: Record<string, Array<{ tag: string; count: number }>> = {}
    for (const root of roots)
      out[root] = [...counts]
        .filter(([tag]) => tag.startsWith(root + "/"))
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    return out
  }

  search(query: string, { tags = [] as string[], limit = 8 } = {}): SearchHit[] {
    const terms = [...new Set(tokenize(query))]
    if (!terms.length) return []
    const index = this.buildIndex()
    const n = index.docs.length
    const k1 = 1.2
    const b = 0.75
    const hits: SearchHit[] = []
    for (const doc of index.docs) {
      const page = this.pages.get(doc.slug)!
      if (tags.length && !tags.some((t) => page.tags.some((x) => x === t || x.startsWith(t + "/"))))
        continue
      let score = 0
      for (const term of terms) {
        const f = doc.tf.get(term)
        if (!f) continue
        const df = index.df.get(term) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.len) / index.avg))
      }
      // Exact phrase and slug matches beat scattered terms.
      const q = query.toLowerCase().trim()
      if (q.length > 3 && page.title.toLowerCase().includes(q)) score += 4
      if (q.length > 3 && page.slug.toLowerCase().includes(q.replace(/\s+/g, "-"))) score += 2
      if (score > 0)
        hits.push({
          slug: page.slug,
          title: page.title,
          tags: page.tags,
          score,
          snippet: snippet(page.content, terms),
        })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  private buildIndex() {
    if (this.index) return this.index
    const docs: Array<{ slug: string; tf: Map<string, number>; len: number }> = []
    const df = new Map<string, number>()
    let total = 0
    for (const page of this.pages.values()) {
      const tf = new Map<string, number>()
      // Title ×3 and tags ×2 so a page about a thing outranks one that mentions it.
      const weighted: Array<[string, number]> = [
        [page.title, 3],
        [page.tags.join(" ").replace(/\//g, " "), 2],
        [page.slug.replace(/[/-]/g, " "), 1],
        [page.content, 1],
      ]
      let len = 0
      for (const [text, weight] of weighted)
        for (const token of tokenize(text)) {
          tf.set(token, (tf.get(token) ?? 0) + weight)
          len += weight
        }
      for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
      docs.push({ slug: page.slug, tf, len })
      total += len
    }
    this.index = { docs, df, avg: total / Math.max(1, docs.length) }
    return this.index
  }
}

export function snippet(content: string, terms: string[], width = 320): string {
  const lower = content.toLowerCase()
  let at = -1
  for (const term of terms) {
    at = lower.indexOf(term)
    if (at >= 0) break
  }
  const start = Math.max(0, at < 0 ? 0 : at - width / 3)
  const text = content
    .slice(start, start + width)
    .replace(/\s+/g, " ")
    .trim()
  return (start > 0 ? "…" : "") + text + (start + width < content.length ? "…" : "")
}

let cached: { key: string; knowledge: Promise<Knowledge> } | null = null

/** The member edition's knowledge, memoized per isolate (it only changes with a deploy). */
export function loadKnowledge(env: Env, manifest: DocsManifest): Promise<Knowledge> {
  const key = `${manifest.generatedAt ?? ""}|${env.PUBLIC_SITE_URL}`
  if (cached?.key === key) return cached.knowledge
  const knowledge = env.ASSETS.fetch(new Request("https://assets.local/static/contentIndex.json"))
    .then(async (response) => {
      const raw = response.ok ? await response.json().catch(() => ({})) : {}
      const entries =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, RawEntry>)
          : {}
      return new Knowledge(entries, manifest.documents, env.PUBLIC_SITE_URL)
    })
    .catch((error) => {
      cached = null
      throw error
    })
  cached = { key, knowledge }
  return knowledge
}
