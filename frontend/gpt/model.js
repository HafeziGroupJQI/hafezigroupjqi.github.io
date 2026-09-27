// Pure Hafezi GPT view logic (no DOM, unit-tested in model.test.mjs): composer triggers, the
// streaming-turn reducer, sidebar grouping, Markdown pre/post-processing for math and citations.

/** An "@query" being typed right before the caret → { start, query }, else null. */
export function mentionQuery(text, caret) {
  const before = text.slice(0, caret)
  const match = before.match(/(^|\s)@([^\s@]{0,60})$/)
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null
}

/** A "/skill" typed at the very start of the message → { query }, else null. */
export function slashQuery(text, caret) {
  const match = text.slice(0, caret).match(/^\/([a-z0-9-]{0,64})$/)
  return match ? { query: match[1] } : null
}

/** Remove the "@query" the member was typing (it becomes a chip instead). */
export function removeToken(text, start, caret) {
  const after = text.slice(caret).replace(/^\S*/, "")
  return {
    text: (text.slice(0, start) + after.replace(/^ /, "")).replace(/ {2,}/g, " "),
    caret: start,
  }
}

/** Fold one stream event into the in-progress reply. Returns a new reply object. */
export function applyEvent(reply, name, data) {
  const blocks = reply.blocks.slice()
  const last = blocks[blocks.length - 1]
  switch (name) {
    case "delta":
      if (last?.type === "text")
        blocks[blocks.length - 1] = { ...last, text: last.text + data.text }
      else blocks.push({ type: "text", text: data.text, citations: [] })
      return { ...reply, blocks }
    case "thinking":
      if (last?.type === "thinking")
        blocks[blocks.length - 1] = { ...last, text: last.text + data.text }
      else blocks.push({ type: "thinking", text: data.text, live: true })
      return { ...reply, blocks }
    case "tool":
      return {
        ...reply,
        blocks: [
          ...blocks,
          { type: "tool", id: data.id, name: data.name, label: data.label, pending: true },
        ],
      }
    case "tool_result":
      return {
        ...reply,
        blocks: blocks.map((b) =>
          b.type === "tool" && b.id === data.id
            ? { ...b, pending: false, summary: data.summary, is_error: data.is_error }
            : b,
        ),
      }
    case "turn":
      return data ? { ...reply, ...data, streaming: reply.streaming } : reply
    case "usage":
      return { ...reply, usage: data }
    case "error":
      return { ...reply, error: data.detail, streaming: false }
    case "done":
      return { ...reply, streaming: false }
    default:
      return reply
  }
}

/** Sidebar sections for "My chats": page chats, then each project, then unfiled. */
export function groupConversations(conversations, projects) {
  const names = new Map(projects.map((p) => [p.id, p.name]))
  const groups = new Map()
  const add = (key, label, conversation) => {
    if (!groups.has(key)) groups.set(key, { key, label, items: [] })
    groups.get(key).items.push(conversation)
  }
  for (const c of conversations) {
    if (c.project_id) add(`p:${c.project_id}`, names.get(c.project_id) ?? "Project", c)
    else if (c.origin_slug) add("pages", "Page chats", c)
    else add("none", "Chats", c)
  }
  const order = (g) => (g.key === "pages" ? 1 : g.key === "none" ? 2 : 0)
  return [...groups.values()].sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label))
}

/** "Today", "Yesterday", or a short date, for chat lists. */
export function relativeDay(at, now = Date.now()) {
  const day = (t) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / 86_400_000)
  const diff = day(now) - day(at)
  if (diff <= 0)
    return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  if (diff === 1) return "Yesterday"
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** The site slug of the page at `pathname` ("/equipment/x/" → "equipment/x", "/" → "index"). */
export function pageSlug(pathname) {
  const slug = decodeURIComponent(pathname)
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.html$/, "")
  return slug || "index"
}

// ---- Markdown helpers ----

const MATH =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?!\s)((?:\\.|[^$\n\\])+?)(?<!\s)\$(?![\w$])/g

/**
 * Pull math out before Markdown sees it (so `_` and `*` inside TeX survive), leaving inert
 * placeholders; code spans and fences are left alone. Returns the text and the formulas.
 */
export function protectMath(text) {
  const math = []
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part
    return part.replace(MATH, (_, block, bracket, paren, inline) => {
      const display = block !== undefined || bracket !== undefined
      math.push({ tex: (block ?? bracket ?? paren ?? inline).trim(), display })
      return `\u0000M${math.length - 1}\u0000`
    })
  })
  return { text: out.join(""), math }
}

export const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  )

/** Put formulas back into rendered HTML; `render(tex, display)` returns HTML (KaTeX) or null. */
export function restoreMath(html, math, render) {
  return html.replace(/\u0000M(\d+)\u0000/g, (_, i) => {
    const { tex, display } = math[Number(i)]
    const rendered = render?.(tex, display)
    if (rendered) return rendered
    return display
      ? `<pre class="gpt-math">${escapeHtml(tex)}</pre>`
      : `<code class="gpt-math">${escapeHtml(tex)}</code>`
  })
}

/** Turn [^n] markers into numbered source chips linking to the cited page. */
export function citationChips(html, citations = []) {
  return html.replace(/\[\^(\d+)\]/g, (whole, n) => {
    const c = citations[Number(n) - 1]
    if (!c) return ""
    const title = escapeHtml(
      `${c.title}${c.cited_text ? ` — “${c.cited_text.slice(0, 200)}”` : ""}`,
    )
    return c.url
      ? `<a class="gpt-cite" href="${escapeHtml(c.url)}" title="${title}">${n}</a>`
      : `<span class="gpt-cite" title="${title}">${n}</span>`
  })
}

/** Unique sources of a reply (citations + pages it opened), for the "Sources" row. */
export function sources(turn) {
  const seen = new Map()
  for (const block of turn.blocks ?? [])
    for (const c of block.citations ?? [])
      if (c.url && !seen.has(c.url)) seen.set(c.url, { title: c.title, url: c.url })
  for (const o of turn.opened ?? [])
    if (o.url && !seen.has(o.url)) seen.set(o.url, { title: o.title, url: o.url })
  return [...seen.values()]
}

/** "1.2k / 2M tokens this month" for the composer meter; null when unlimited and unused. */
export function budgetLabel(usage) {
  if (!usage) return null
  const f = (n) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)
  if (usage.budget == null) return usage.used ? `${f(usage.used)} tokens this month` : null
  return `${f(usage.used)} of ${f(usage.budget)} tokens this month`
}
