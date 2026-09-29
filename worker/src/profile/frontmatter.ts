// Reading and changing top-level scalar keys of a Markdown page's YAML front matter, line by line,
// so that everything else in the page (key order, comments, lists, the body) stays byte-identical
// and a commit's diff shows only what the member changed.

export interface Page {
  front: string[]
  body: string
}

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/

export function splitPage(text: string): Page | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return null
  return { front: match[1].split(/\r?\n/), body: text.slice(match[0].length) }
}

export function joinPage(page: Page): string {
  return `---\n${page.front.join("\n")}\n---\n${page.body}`
}

// A key's own line plus any continuation lines (indented, or an unindented "- " list).
function span(front: string[], key: string): [number, number] | null {
  const start = front.findIndex((line) => line.match(KEY)?.[1] === key)
  if (start === -1) return null
  let end = start + 1
  while (end < front.length && /^(\s|- |-$)/.test(front[end]) && !KEY.test(front[end])) end++
  return [start, end]
}

/** A top-level key as a string (or null when it is null, empty, missing or not a scalar). */
export function getScalar(page: Page, key: string): string | null {
  const found = span(page.front, key)
  if (!found) return null
  const [start, end] = found
  const inline = page.front[start].slice(page.front[start].indexOf(":") + 1).trim()
  if (/^[|>][+-]?\d*$/.test(inline)) {
    const lines = page.front.slice(start + 1, end).map((line) => line.trim())
    const text = inline.startsWith(">") ? lines.join(" ") : lines.join("\n")
    return text.trim() || null
  }
  if (end > start + 1) return null // a list or a mapping
  return parseInline(inline)
}

/**
 * A top-level key as a list of strings: a flow list (`tags: [internal, notes]`) or a block list
 * (`- internal` lines). Null when it is missing or not a list.
 */
export function getList(page: Page, key: string): string[] | null {
  const found = span(page.front, key)
  if (!found) return null
  const [start, end] = found
  const inline = page.front[start].slice(page.front[start].indexOf(":") + 1).trim()
  if (inline.startsWith("[")) {
    const close = inline.lastIndexOf("]")
    if (close < 0) return null
    const items = inline.slice(1, close).trim()
    return items ? items.split(",").map((item) => parseInline(item.trim()) ?? "") : []
  }
  if (inline) return null
  return page.front
    .slice(start + 1, end)
    .map((line) => line.match(/^\s*-\s*(.*)$/))
    .filter((match) => match !== null)
    .map((match) => parseInline(match[1].trim()) ?? "")
}

function parseInline(raw: string): string | null {
  if (raw === "" || raw === "~" || raw === "null" || raw === "Null" || raw === "NULL") return null
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw.replace(/\s+#.*$/, ""))
    } catch {
      return raw
    }
  }
  if (raw.startsWith("'")) {
    const close = raw.lastIndexOf("'")
    return raw.slice(1, close > 0 ? close : undefined).replace(/''/g, "'")
  }
  if (raw.startsWith("[") || raw.startsWith("{")) return null
  return raw.replace(/\s+#.*$/, "").trim()
}

// Characters JSON leaves as they are but YAML reads as line breaks (NEL, LS, PS), plus DEL and
// the C1 controls: escaped, so a value never spills onto a line of its own.
const UNSAFE = /[\u007f-\u009f\u2028\u2029]/g

/** YAML for a scalar: plain when that reads back as the same string, JSON-quoted otherwise. */
export function formatScalar(value: string | null): string {
  if (value === null) return "null"
  const plain =
    /^[A-Za-z(][^:#\n]*$/.test(value) &&
    !/[\p{Cc}\u2028\u2029]/u.test(value) &&
    !/\s$/.test(value) &&
    !/^(?:true|false|yes|no|on|off|null|y|n)$/i.test(value)
  if (plain) return value
  return JSON.stringify(value).replace(
    UNSAFE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

/** Set a top-level scalar key, in place when it exists, otherwise before `before` (or at the end). */
export function setScalar(page: Page, key: string, value: string | null, before = "tags"): void {
  const line = `${key}: ${formatScalar(value)}`
  const found = span(page.front, key)
  if (found) {
    page.front.splice(found[0], found[1] - found[0], line)
    return
  }
  const anchor = span(page.front, before)
  page.front.splice(anchor ? anchor[0] : page.front.length, 0, line)
}
