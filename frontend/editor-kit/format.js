// The editor kit's formatting (index.js: the toolbar and Mod-b / Mod-i / Mod-k): each command takes
// the text and one selection (from, to) and says what to change and where the selection goes
// after: {changes: [{from, to, insert}], anchor, head}, the changes in the text as it was, the
// selection in the text after them. Applying a command again undoes it. Pure, so it runs under node.

const lineStart = (text, pos) => text.lastIndexOf("\n", pos - 1) + 1
const lineEnd = (text, pos) => {
  const end = text.indexOf("\n", pos)
  return end < 0 ? text.length : end
}

/** Where `pos` is after `changes` (sorted, in the old text): a cursor at an insertion moves past it. */
export function mapPos(changes, pos) {
  let delta = 0
  for (const change of changes) {
    if (change.from > pos) break
    if (change.to <= pos) delta += change.insert.length - (change.to - change.from)
    // Inside a replaced span: after what replaces it (a line's new prefix), or where it was.
    else return change.from + delta + change.insert.length
  }
  return pos + delta
}

/** The lines a selection covers: [{from, to}] (a selection ending at a line's start leaves it out). */
export function selectedLines(text, from, to) {
  const last = to > from && to === lineStart(text, to) ? to - 1 : to
  const lines = []
  for (let at = lineStart(text, from); ;) {
    const end = lineEnd(text, at)
    lines.push({ from: at, to: end })
    if (end >= last || end >= text.length) break
    at = end + 1
  }
  return lines
}

/**
 * Wrap the selection in `marker` (** bold, _ italic, ` code, $ math), or unwrap it when it is
 * wrapped already, inside or just outside the selection. An empty selection gets the pair with the
 * cursor between; spaces at the selection's ends stay outside the markers.
 */
export function toggleInline(text, from, to, marker) {
  const k = marker.length
  if (text.slice(from - k, from) === marker && text.slice(to, to + k) === marker && from - k >= 0)
    return {
      changes: [
        { from: from - k, to: from, insert: "" },
        { from: to, to: to + k, insert: "" },
      ],
      anchor: from - k,
      head: to - k,
    }
  const selected = text.slice(from, to)
  if (selected.length >= 2 * k && selected.startsWith(marker) && selected.endsWith(marker))
    return {
      changes: [{ from, to, insert: selected.slice(k, -k) }],
      anchor: from,
      head: to - 2 * k,
    }
  if (from === to)
    return { changes: [{ from, to, insert: marker + marker }], anchor: from + k, head: from + k }
  const start = from + (selected.length - selected.trimStart().length)
  const end = to - (selected.length - selected.trimEnd().length)
  if (start >= end)
    return {
      changes: [{ from, to, insert: selected + marker + marker }],
      anchor: to + k,
      head: to + k,
    }
  return {
    changes: [
      { from: start, to: start, insert: marker },
      { from: end, to: end, insert: marker },
    ],
    anchor: start + k,
    head: end + k,
  }
}

const PREFIXES = {
  heading: { match: /^#{1,6}[ \t]+/, add: () => "## " },
  bullet: { match: /^[ \t]*[-*+][ \t]+/, add: () => "- ", other: /^[ \t]*\d+[.)][ \t]+/ },
  number: { match: /^[ \t]*\d+[.)][ \t]+/, add: (n) => `${n}. `, other: /^[ \t]*[-*+][ \t]+/ },
  quote: { match: /^>[ \t]?/, add: () => "> " },
}

/**
 * Start each selected line with a heading's ##, a list's - or 1., or a quote's >, or take it off
 * when every line has it already. A list replaces the other kind of list.
 */
export function toggleLines(text, from, to, kind) {
  const rule = PREFIXES[kind]
  const lines = selectedLines(text, from, to)
  const content = lines.filter((line) => line.to > line.from || lines.length === 1)
  const has = (line) => rule.match.exec(text.slice(line.from, line.to))
  const remove = content.every(has)
  const changes = []
  let n = 0
  for (const line of content) {
    const body = text.slice(line.from, line.to)
    if (remove) {
      changes.push({ from: line.from, to: line.from + has(line)[0].length, insert: "" })
      continue
    }
    if (has(line)) {
      n += 1
      // A numbered list renumbered in order; a heading or quote already there stays.
      if (kind === "number") {
        const old = has(line)[0]
        changes.push({ from: line.from, to: line.from + old.length, insert: rule.add(n) })
      }
      continue
    }
    n += 1
    const other = rule.other?.exec(body)?.[0] ?? ""
    changes.push({ from: line.from, to: line.from + other.length, insert: rule.add(n) })
  }
  return { changes, anchor: mapPos(changes, from), head: mapPos(changes, to) }
}

/**
 * Put the selected lines between fence lines (``` for code, $$ for display math), or take the
 * fences off when the lines are between them already (or are them).
 */
export function toggleBlock(text, from, to, fence) {
  const isFence = (line) =>
    fence === "```" ? /^[ \t]*(`{3,}|~{3,})/.test(line) : line.trim() === fence
  const lines = selectedLines(text, from, to)
  const first = lines[0]
  const last = lines[lines.length - 1]
  const lineText = (line) => text.slice(line.from, line.to)
  // The selection is the fenced block, fences included.
  if (lines.length >= 2 && isFence(lineText(first)) && isFence(lineText(last))) {
    if (lines.length === 2) {
      const changes = [{ from: first.from, to: last.to, insert: "" }]
      return { changes, anchor: first.from, head: first.from }
    }
    const changes = [
      { from: first.from, to: Math.min(first.to + 1, text.length), insert: "" },
      { from: last.from - 1, to: last.to, insert: "" },
    ]
    return { changes, anchor: first.from, head: mapPos(changes, last.from - 1) }
  }
  // The selection is inside one.
  const before = first.from > 0 ? lineStart(text, first.from - 1) : -1
  const after = last.to < text.length ? last.to + 1 : -1
  if (
    before >= 0 &&
    after >= 0 &&
    isFence(text.slice(before, first.from - 1)) &&
    isFence(text.slice(after, lineEnd(text, after)))
  ) {
    const changes = [
      { from: before, to: first.from, insert: "" },
      { from: last.to, to: lineEnd(text, after), insert: "" },
    ]
    return { changes, anchor: mapPos(changes, from), head: mapPos(changes, to) }
  }
  if (from === to && first.from === first.to) {
    const at = from + fence.length + 1
    return { changes: [{ from, to, insert: `${fence}\n\n${fence}` }], anchor: at, head: at }
  }
  const changes = [
    { from: first.from, to: first.from, insert: `${fence}\n` },
    { from: last.to, to: last.to, insert: `\n${fence}` },
  ]
  return {
    changes,
    anchor: first.from + fence.length + 1,
    head: last.to + fence.length + 1,
  }
}

/** Whether the selected lines sit between two lines that are just `fence`. */
function between(text, from, to, fence) {
  const lines = selectedLines(text, from, to)
  const first = lines[0]
  const last = lines[lines.length - 1]
  if (first.from === 0 || last.to >= text.length) return false
  const before = text.slice(lineStart(text, first.from - 1), first.from - 1)
  const after = text.slice(last.to + 1, lineEnd(text, last.to + 1))
  return before.trim() === fence && after.trim() === fence
}

/** Math: $…$ in a line, a $$ block over several (or the $$ block the selection is in). */
export const toggleMath = (text, from, to) =>
  text.slice(from, to).includes("\n") || between(text, from, to, "$$")
    ? toggleBlock(text, from, to, "$$")
    : toggleInline(text, from, to, "$")

const URLISH = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/|mailto:)\S*$/i

/**
 * A link: [selection](url) with "url" selected to type over (on GitHub's model); a selected web
 * address becomes the target, with the cursor where its text goes.
 */
export function insertLink(text, from, to) {
  const selected = text.slice(from, to)
  if (URLISH.test(selected))
    return {
      changes: [{ from, to, insert: `[](${selected})` }],
      anchor: from + 1,
      head: from + 1,
    }
  const label = selected.replace(/\n+/g, " ")
  const insert = `[${label}](url)`
  const urlAt = from + label.length + 3
  return { changes: [{ from, to, insert }], anchor: urlAt, head: urlAt + 3 }
}

/** Every command the toolbar and keys have, by name. */
export const COMMANDS = {
  bold: (text, from, to) => toggleInline(text, from, to, "**"),
  italic: (text, from, to) => toggleInline(text, from, to, "_"),
  heading: (text, from, to) => toggleLines(text, from, to, "heading"),
  link: insertLink,
  bullet: (text, from, to) => toggleLines(text, from, to, "bullet"),
  number: (text, from, to) => toggleLines(text, from, to, "number"),
  quote: (text, from, to) => toggleLines(text, from, to, "quote"),
  code: (text, from, to) =>
    text.slice(from, to).includes("\n")
      ? toggleBlock(text, from, to, "```")
      : toggleInline(text, from, to, "`"),
  codeblock: (text, from, to) => toggleBlock(text, from, to, "```"),
  math: toggleMath,
}

/** A command's result applied to `text` (for tests, and anything without an editor). */
export function apply(text, result) {
  let out = text
  for (const change of [...result.changes].sort((a, b) => b.from - a.from))
    out = out.slice(0, change.from) + change.insert + out.slice(change.to)
  return out
}
