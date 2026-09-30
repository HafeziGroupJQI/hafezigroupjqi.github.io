// A Jupyter notebook as the page editor edits it (index.js, cells.js): its cells changed, added,
// moved or deleted, and the file written back in its own JSON layout, so a notebook saved with no
// change is byte-identical and an edited one differs only in the cells that changed. The vault's
// notebooks come in the layouts Python's json.dumps writes: nbformat's (indent 1, sorted keys, a
// final newline), Colab's (no whitespace at all, keys in their order, non-ASCII escaped or not) and
// others' (indent 2, unsorted). So a notebook is read keeping its keys' order and its numbers as
// written, and written the way json.dumps would, with the layout the file itself shows. A layout
// that doesn't write the file back as it was is never used: the editor then edits its JSON.

// ---- JSON, keeping key order and numbers as written ----

/** A JSON object with its keys in their order (any key, "0" too). */
export class JsonObject {
  constructor(entries = []) {
    this.entries = entries
  }
  get(key) {
    return this.entries.find(([name]) => name === key)?.[1]
  }
  has(key) {
    return this.entries.some(([name]) => name === key)
  }
  set(key, value) {
    const entry = this.entries.find(([name]) => name === key)
    if (entry) entry[1] = value
    else this.entries.push([key, value])
  }
  keys() {
    return this.entries.map(([name]) => name)
  }
}

/** A number as the file wrote it (1e-05 stays 1e-05). */
export class JsonNumber {
  constructor(raw) {
    this.raw = raw
  }
  valueOf() {
    return Number(this.raw)
  }
}

export function parseJson(text) {
  let at = 0
  const fail = (what) => {
    throw new SyntaxError(`${what} at character ${at}`)
  }
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at])) at++
  }
  const value = () => {
    space()
    const char = text[at]
    if (char === "{") {
      at++
      const entries = []
      space()
      if (text[at] === "}") {
        at++
        return new JsonObject(entries)
      }
      for (;;) {
        space()
        if (text[at] !== '"') fail("expected a key")
        const key = string()
        space()
        if (text[at++] !== ":") fail("expected :")
        entries.push([key, value()])
        space()
        if (text[at] === ",") at++
        else if (text[at] === "}") {
          at++
          return new JsonObject(entries)
        } else fail("expected , or }")
      }
    }
    if (char === "[") {
      at++
      const items = []
      space()
      if (text[at] === "]") {
        at++
        return items
      }
      for (;;) {
        items.push(value())
        space()
        if (text[at] === ",") at++
        else if (text[at] === "]") {
          at++
          return items
        } else fail("expected , or ]")
      }
    }
    if (char === '"') return string()
    for (const [word, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ])
      if (text.startsWith(word, at)) {
        at += word.length
        return result
      }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at, at + 400))
    if (!number) fail("unexpected character")
    at += number[0].length
    return new JsonNumber(number[0])
  }
  const string = () => {
    const end = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y
    end.lastIndex = at
    const match = end.exec(text)
    if (!match) fail("bad string")
    at = end.lastIndex
    return JSON.parse(match[0])
  }
  const result = value()
  space()
  if (at !== text.length) fail("unexpected text after the JSON")
  return result
}

// ---- writing it as Python's json.dumps does ----

const hex4 = (code) => `\\u${code.toString(16).padStart(4, "0")}`

/**
 * A string as json.dumps writes it. JSON.stringify escapes what json.dumps does (quotes,
 * backslashes, control characters as \n or lowercase \u00xx); ensure_ascii also escapes all but
 * printable ASCII, each UTF-16 unit on its own, as json.dumps writes a surrogate pair.
 */
export function jsonString(text, ascii) {
  const json = JSON.stringify(text)
  return ascii ? json.replace(/[\u007f-\uffff]/g, (char) => hex4(char.charCodeAt(0))) : json
}

/**
 * `value` written with `layout`: {indent (a number, or null for none), item and key separators,
 * ascii, sortKeys (for keys the file didn't have: its own keep their order), newline at the end}.
 */
export function serializeJson(value, layout) {
  const { indent, item, key, ascii } = layout
  const write = (node, depth) => {
    if (node === null) return "null"
    if (node === true) return "true"
    if (node === false) return "false"
    if (node instanceof JsonNumber) return node.raw
    if (typeof node === "number") return String(node)
    if (typeof node === "string") return jsonString(node, ascii)
    const inner = indent === null ? "" : "\n" + " ".repeat(indent * (depth + 1))
    const outer = indent === null ? "" : "\n" + " ".repeat(indent * depth)
    if (Array.isArray(node)) {
      if (!node.length) return "[]"
      return `[${inner}${node.map((child) => write(child, depth + 1)).join(item + inner)}${outer}]`
    }
    if (!node.entries.length) return "{}"
    return `{${inner}${node.entries
      .map(([name, child]) => jsonString(name, ascii) + key + write(child, depth + 1))
      .join(item + inner)}${outer}}`
  }
  return write(value, 0) + (layout.newline ? "\n" : "")
}

// ---- a file's own layout ----

function everyObject(node, visit) {
  if (Array.isArray(node)) node.forEach((child) => everyObject(child, visit))
  else if (node instanceof JsonObject) {
    visit(node)
    node.entries.forEach(([, child]) => everyObject(child, visit))
  }
}

/** The first comma or colon outside strings, and what follows it. */
function separatorAfter(text, mark) {
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === "\\") i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === mark) return text[i + 1] === " " ? `${mark} ` : mark
  }
  return mark
}

/**
 * The layout a notebook's file is written in, or null when none writes it back byte for byte
 * (then its JSON is edited as text).
 */
export function notebookLayout(raw, notebook = parseJson(raw)) {
  const pretty = /^[{[]\r?\n/.test(raw)
  const indent = pretty ? (/^[{[]\r?\n( +)/.exec(raw)?.[1].length ?? null) : null
  let sorted = true
  everyObject(notebook, (object) => {
    const keys = object.keys()
    if (keys.some((name, i) => i && keys[i - 1] > name)) sorted = false
  })
  const layout = {
    indent,
    item: indent === null ? separatorAfter(raw, ",") : ",",
    key: separatorAfter(raw, ":"),
    // Escaped non-ASCII text means json.dumps' ensure_ascii; raw non-ASCII, or none, means not.
    ascii:
      !/[^\u0000-\u007e]/.test(raw) &&
      /\\u(?:00[89a-f][0-9a-f]|0[1-9a-f][0-9a-f]{2}|[1-9a-f][0-9a-f]{3})/i.test(raw),
    sortKeys: sorted,
    newline: raw.endsWith("\n"),
  }
  return serializeJson(notebook, layout) === raw ? layout : null
}

// ---- cells ----

/** A cell's source as one text (a notebook keeps it as a list of lines, or a string). */
export const cellText = (cell) => {
  const source = cell.get("source")
  return Array.isArray(source) ? source.join("") : (source ?? "")
}

/** Text as a cell's source, in the form the cell had: nbformat's lines, each ending in \n but the last. */
export function sourceOf(text, like) {
  if (typeof like === "string") return text
  return text ? text.match(/[^\n]*\n|[^\n]+$/g) : []
}

export function setCellText(cell, text) {
  cell.set("source", sourceOf(text, cell.get("source")))
}

/** Clear a code cell's outputs and execution count (what it showed was the old code's). */
export function clearOutputs(cell) {
  if (cell.has("outputs")) cell.set("outputs", [])
  if (cell.has("execution_count")) cell.set("execution_count", null)
}

const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(4))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

/** A new cell of `type` (code, markdown), its keys as the notebook's other cells have them. */
export function newCell(notebook, type, layout) {
  const cells = notebook.get("cells")
  const like = cells.find((cell) => cell.get("cell_type") === type) ?? cells[0]
  const fresh = {
    cell_type: type,
    ...(like?.has("id") || cells.some((cell) => cell.has("id")) ? { id: randomId() } : {}),
    metadata: new JsonObject(),
    source: [],
    ...(type === "code" ? { execution_count: null, outputs: [] } : {}),
  }
  const order = like ? like.keys().filter((name) => name in fresh) : []
  const keys = [...order, ...Object.keys(fresh).filter((name) => !order.includes(name))]
  if (layout?.sortKeys) keys.sort()
  return new JsonObject(keys.map((name) => [name, fresh[name]]))
}

// Terminal colours in a saved output (ESC [ … m).
export const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g")

/**
 * A notebook as Markdown for the preview: its Markdown cells as they are, its code cells as fenced
 * code in the notebook's language, and their saved text outputs.
 */
export function notebookMarkdown(notebook) {
  const language =
    notebook.get("metadata")?.get?.("kernelspec")?.get?.("language") ??
    notebook.get("metadata")?.get?.("language_info")?.get?.("name") ??
    "python"
  const outputText = (output) => {
    const data = output.get("data")
    const text = output.get("text") ?? data?.get?.("text/plain")
    return (Array.isArray(text) ? text.join("") : typeof text === "string" ? text : "").replace(
      ANSI,
      "",
    )
  }
  return (notebook.get("cells") ?? [])
    .map((cell) => {
      const text = cellText(cell)
      if (cell.get("cell_type") === "markdown") return text
      if (cell.get("cell_type") !== "code") return text.trim() ? "```\n" + text + "\n```" : ""
      const outputs = (cell.get("outputs") ?? []).map(outputText).filter(Boolean)
      return [
        "```" + language + "\n" + text + "\n```",
        ...outputs.map((output) => "```text\n" + output.replace(/\n$/, "") + "\n```"),
      ].join("\n\n")
    })
    .filter(Boolean)
    .join("\n\n")
}
