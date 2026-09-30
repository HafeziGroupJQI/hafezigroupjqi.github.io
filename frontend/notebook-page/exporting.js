// A Jupyter notebook as Quarto or Markdown, for a notebook page's Export menu (page-export/). Pure
// (nbformat JSON in, text out), so node:test covers it.
//
// From compute's labextensions/src/lib/exporting.ts (the lab's Export menu): notebookToQmd,
// notebookToMarkdown and the helpers they use, with the logic unchanged. Keep the two in step.

export const join = (s) => (Array.isArray(s) ? s.join("") : (s ?? ""))

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
export const stripAnsi = (s) => s.replace(ANSI_RE, "")

const IMAGE_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
}
const IMAGE_ORDER = ["image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp"]

/** The fence language for a notebook's code cells. */
export function codeLanguage(nb) {
  const li = nb.metadata?.language_info ?? {}
  const name = String(li.name || nb.metadata?.kernelspec?.language || "python").toLowerCase()
  if (name.startsWith("wolfram") || name === "mathematica") {
    return "wolfram"
  }
  return name.replace(/[^a-z0-9_+-]/g, "") || "text"
}

function fence(body, lang = "") {
  const ticks = body.includes("```") ? "````" : "```"
  return `${ticks}${lang}\n${body.replace(/\n$/, "")}\n${ticks}`
}

function slug(s) {
  return (
    s
      .toLowerCase()
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "export"
  )
}

/**
 * A notebook as plain Markdown. Images become files under `figures/` (returned in `files`,
 * referenced relatively); text outputs become ```text blocks; errors keep their traceback.
 * opts: {baseName (for figure names), figuresDir?, title? (a leading H1)}.
 */
export function notebookToMarkdown(nb, opts) {
  const dir = (opts.figuresDir ?? "figures").replace(/\/+$/, "")
  const base = slug(opts.baseName)
  const lang = codeLanguage(nb)
  const parts = []
  const files = []
  if (opts.title) {
    parts.push(`# ${opts.title}`)
  }
  let n = 0
  for (const cell of nb.cells) {
    const src = join(cell.source)
    if (cell.cell_type === "markdown") {
      if (src.trim()) {
        parts.push(src.trim())
      }
      continue
    }
    if (cell.cell_type !== "code") {
      continue
    }
    if (src.trim()) {
      parts.push(fence(src, lang))
    }
    let stream = ""
    const flushStream = () => {
      if (stream) {
        parts.push(fence(stream, "text"))
        stream = ""
      }
    }
    for (const o of cell.outputs ?? []) {
      if (o.output_type === "stream") {
        stream += stripAnsi(join(o.text))
        continue
      }
      flushStream()
      if (o.output_type === "error") {
        const tb = (o.traceback ?? []).map(stripAnsi).join("\n") || `${o.ename}: ${o.evalue}`
        parts.push(fence(tb, "text"))
        continue
      }
      const data = o.data ?? {}
      const img = IMAGE_ORDER.find((m) => data[m] !== undefined)
      if (img) {
        n += 1
        const name = `${base}-${n}.${IMAGE_EXT[img]}`
        const raw = data[img]
        const content = join(raw)
        files.push({
          path: `${dir}/${name}`,
          content: img === "image/svg+xml" ? content : content.replace(/\s+/g, ""),
          format: img === "image/svg+xml" ? "text" : "base64",
        })
        const alt = altText(data) || `Figure ${n}`
        parts.push(`![${alt}](${dir}/${name})`)
        continue
      }
      if (data["text/markdown"] !== undefined) {
        parts.push(join(data["text/markdown"]).trim())
      } else if (data["text/latex"] !== undefined) {
        const tex = join(data["text/latex"]).trim()
        parts.push(tex.startsWith("$") ? tex : `$$\n${tex}\n$$`)
      } else if (data["text/plain"] !== undefined) {
        parts.push(fence(stripAnsi(join(data["text/plain"])), "text"))
      } else if (data["text/html"] !== undefined) {
        parts.push(join(data["text/html"]).trim())
      }
    }
    flushStream()
  }
  return { markdown: parts.join("\n\n") + "\n", files }
}

function altText(data) {
  const t = join(data["text/plain"]).trim()
  // "<Figure size 640x480 with 1 Axes>" and friends are not useful alt text.
  if (!t || t.startsWith("<") || t.length > 120) {
    return ""
  }
  return t.replace(/[[\]\n]/g, " ")
}

/**
 * A notebook as a Quarto document (jupytext "quarto" style: front matter with `jupyter:`, code
 * chunks as ```{lang}, outputs dropped). The lab prefers the server's jupytext; this is its
 * fallback, and all a browser has.
 */
export function notebookToQmd(nb, title) {
  const lang = codeLanguage(nb)
  const ks = nb.metadata?.kernelspec
  const head = ["---"]
  if (title) {
    head.push(`title: ${JSON.stringify(title)}`)
  }
  if (ks?.name) {
    head.push("jupyter:", "  kernelspec:", `    name: ${ks.name}`)
    head.push(`    display_name: ${JSON.stringify(ks.display_name ?? ks.name)}`)
    // Quarto runs the chunks whose language is the kernelspec's, so the two must be the same word:
    // a Wolfram kernel's "Wolfram Language" would leave its ```{wolfram} cells as plain text.
    head.push(`    language: ${lang}`)
  }
  head.push("---")
  const parts = [head.join("\n")]
  for (const cell of nb.cells) {
    const src = join(cell.source).replace(/\n+$/, "")
    if (cell.cell_type === "markdown") {
      if (src.trim()) {
        parts.push(src)
      }
    } else if (cell.cell_type === "code") {
      parts.push("```{" + lang + "}\n" + src + "\n```")
    } else if (cell.cell_type === "raw") {
      parts.push("```{=html}\n" + src + "\n```")
    }
  }
  return parts.join("\n\n") + "\n"
}

// ---- the site's downloads ----

/** A notebook page's downloads (its Export menu), by its raw file's name; the first is the file. */
export function downloadFormats(fileName) {
  if (!/\.ipynb$/i.test(fileName)) return []
  return [
    { format: "ipynb", label: "Notebook (.ipynb)" },
    { format: "qmd", label: "Quarto (.qmd)" },
    { format: "md", label: "Markdown with figures (.md)" },
  ]
}

const dataUrlEscape = (text) =>
  encodeURIComponent(text).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)

/**
 * The figures notebookToMarkdown returns as files, inlined as data: URLs, since a browser
 * download is one file. SVG stays text; parentheses are escaped so a Markdown link keeps them.
 */
export function inlineFigures(markdown, files) {
  const types = Object.fromEntries(Object.entries(IMAGE_EXT).map(([type, ext]) => [ext, type]))
  return files.reduce((text, file) => {
    const type = types[file.path.split(".").pop()]
    const url =
      file.format === "base64"
        ? `data:${type};base64,${file.content}`
        : `data:${type},${dataUrlEscape(file.content)}`
    return text.split(`](${file.path})`).join(`](${url})`)
  }, markdown)
}

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(```|~~~)/

/**
 * The notebook's first Markdown heading, outside code fences: {text, leading}, where leading
 * means the notebook opens with it (nothing but blank cells and lines before, and raw cells,
 * which the Markdown export drops). null without one.
 */
export function notebookHeading(nb) {
  let leading = true
  for (const cell of nb.cells) {
    const src = join(cell.source)
    if (!src.trim() || cell.cell_type === "raw") continue
    if (cell.cell_type !== "markdown") {
      leading = false
      continue
    }
    let fenced = false
    for (const line of src.split(/\r?\n/)) {
      if (FENCE.test(line)) fenced = !fenced
      const text = fenced ? null : line.match(HEADING)?.[1]
      if (text) return { text, leading }
      if (line.trim()) leading = false
    }
  }
  return null
}

/**
 * A notebook's raw JSON text as a download in `format` (qmd or md), named after `fileName` as the
 * lab's Export names its files: {name, type, text}. The title is the notebook's first heading,
 * else the file's stem; the Markdown adds the stem as its heading only when the notebook doesn't
 * open with one of its own.
 */
export function convertNotebook(text, format, fileName) {
  const nb = JSON.parse(text)
  if (!Array.isArray(nb?.cells)) throw new Error("this is not a Jupyter notebook")
  const stem = fileName.replace(/\.[^./]+$/, "")
  const heading = notebookHeading(nb)
  const type = "text/markdown;charset=utf-8"
  if (format === "qmd")
    return { name: `${stem}.qmd`, type, text: notebookToQmd(nb, heading?.text ?? stem) }
  if (format === "md") {
    const title = heading?.leading ? undefined : stem
    const { markdown, files } = notebookToMarkdown(nb, { baseName: stem, title })
    return { name: `${stem}.md`, type, text: inlineFigures(markdown, files) }
  }
  throw new Error(`no conversion to .${format}`)
}
