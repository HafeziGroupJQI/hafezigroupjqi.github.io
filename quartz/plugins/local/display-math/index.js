import { visit } from "unist-util-visit"

// `$$…$$` is display math wherever it is written, as in Jupyter, Obsidian and Pandoc (and in the
// Markdown Quarto writes for notebooks). remark-math reads it as display math only when both `$$`
// fences are on lines of their own; otherwise:
//   - on one line inside a paragraph, it is inline math, set small in the line;
//   - across lines, with the opening `$$` starting a line, the rest of that line is taken for the
//     fence's info string and the block never closes: every line after it becomes one equation.
// So the text transform puts the `$$` of every multi-line equation on lines of their own, and the
// Markdown plugin marks the one-line ones as display math, which @quartz-community/latex then
// renders as such. Code, frontmatter and raw HTML are left alone.
export const manifest = {
  name: "display-math",
  displayName: "Display math",
  description: "Renders $$…$$ as display math wherever it is written",
  version: "1.0.0",
  category: "transformer",
}

// Where `$$` occurs in a line, outside inline code and not escaped.
function dollarPairs(line) {
  const text = line.replace(/(`+)[^`]*?\1/g, (span) => " ".repeat(span.length))
  const found = []
  for (let at = text.indexOf("$$"); at !== -1; at = text.indexOf("$$", at + 2))
    if (text[at - 1] !== "\\") found.push(at)
  return found
}

export function fenceDisplayMath(source) {
  const lines = source.split("\n")
  const out = []
  let fence = null // the open code fence
  let rawHtml = null // the closing tag of an open <pre>, <script>, <style> or <textarea>
  let indented = false // inside an indented code block
  let i = 0
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, n) => n > 0 && /^(---|\.\.\.)\s*$/.test(line))
    if (end > 0) {
      out.push(...lines.slice(0, end + 1))
      i = end + 1
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (fence) {
      out.push(line)
      if (new RegExp(`^\\s*(?:>\\s?)*\\s*${fence[0]}{${fence.length},}\\s*$`).test(line))
        fence = null
      continue
    }
    if (rawHtml) {
      out.push(line)
      if (line.toLowerCase().includes(rawHtml)) rawHtml = null
      continue
    }
    const blank = line.trim() === ""
    if (/^( {4}|\t)/.test(line) && (indented || out.length === 0 || out.at(-1).trim() === "")) {
      indented = true
      out.push(line)
      continue
    }
    if (!blank) indented = false
    const open = line.match(/^\s*(?:>\s?)*\s*(`{3,}|~{3,})/)
    if (open) {
      fence = open[1]
      out.push(line)
      continue
    }
    const html = line.match(/^\s*<(pre|script|style|textarea)\b/i)
    if (html && !line.toLowerCase().includes(`</${html[1].toLowerCase()}>`)) {
      rawHtml = `</${html[1].toLowerCase()}>`
      out.push(line)
      continue
    }
    const pairs = dollarPairs(line)
    if (pairs.length % 2 === 0) {
      out.push(line)
      continue
    }
    // An equation opens on this line and closes on a later one: find where, within its paragraph.
    let close = -1
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) {
      if (/^\s*(?:>\s?)*\s*(`{3,}|~{3,})/.test(lines[j])) break
      if (dollarPairs(lines[j]).length) {
        close = j
        break
      }
    }
    if (close === -1) {
      out.push(line)
      continue
    }
    const lead = line.match(/^\s*(?:>\s?)*/)[0]
    const opening = pairs.at(-1)
    const before = line.slice(0, opening)
    const first = line.slice(opening + 2)
    const closing = dollarPairs(lines[close])[0]
    const last = lines[close].slice(0, closing)
    const after = lines[close].slice(closing + 2)
    if (before.trim() !== lead.trim()) out.push(before.trimEnd())
    out.push(lead + "$$")
    if (first.trim()) out.push(lead + first.trim())
    out.push(...lines.slice(i + 1, close))
    if (last.trim() && last.trim() !== lead.trim()) out.push(last.trimEnd())
    out.push(lead + "$$")
    // Text after the equation is read again: it may open another one.
    if (after.trim()) {
      lines[close] = lead + after.trimStart()
      i = close - 1
    } else i = close
  }
  return out.join("\n")
}

export function remarkDisplayMath() {
  return (tree, file) => {
    const source = String(file.value)
    visit(tree, "inlineMath", (node) => {
      const start = node.position?.start.offset
      if (start === undefined || !source.startsWith("$$", start)) return
      node.data ??= {}
      node.data.hProperties = {
        ...node.data.hProperties,
        className: ["language-math", "math-display"],
      }
    })
  }
}

export default () => ({
  name: "DisplayMath",
  textTransform: (_ctx, source) => fenceDisplayMath(source),
  markdownPlugins: () => [remarkDisplayMath],
})
