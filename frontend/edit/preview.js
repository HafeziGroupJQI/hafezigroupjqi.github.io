// The page editor's preview (index.js): the page as the site renders it, near enough to proof an
// edit, by the parser family Quartz uses (unified, remark, rehype): GitHub Markdown, math with
// KaTeX, Obsidian's [[wikilinks]] and ![[embeds]] resolved against the site's pages as Quartz
// resolves them (page-export/quarto.js siteUrl, transformLink with the shortest strategy),
// > [!callouts] with Quartz's own markup, ==highlights== and #tags, and a Quarto document's
// ::: callouts and {python} chunks, shown as code marked as running when the site builds.
// Everything is sanitized (rehype-sanitize: GitHub's rules plus the classes the site's callouts
// and links use) before KaTeX runs, and shown in a frame whose sandbox runs no script.

import remarkObsidian from "@quartz-community/remark-obsidian"
import { slugifyFilePath } from "@quartz-community/utils/path"
import rehypeKatex from "rehype-katex"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import rehypeStringify from "rehype-stringify"
import remarkFrontmatter from "remark-frontmatter"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import { SKIP, visit } from "unist-util-visit"
import { parseDocument } from "yaml"
import { siteUrl } from "../page-export/quarto.js"

// ---- Quarto ----

const QUARTO_CALLOUTS = ["note", "tip", "warning", "caution", "important"]
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/
const DIV_OPEN = /^\s*(:{3,})\s*\{([^}]*)\}\s*$/
const DIV_CLOSE = /^\s*:{3,}\s*$/

/**
 * A Quarto document's Markdown as the preview reads it: `::: {.callout-*}` blocks become Obsidian
 * callouts (the site's), other divs just their content, and a code chunk (```{python}) a fenced
 * block in its language, flagged so the preview marks it as running when the site builds.
 */
export function qmdForPreview(text) {
  const out = []
  const stack = [] // the quote prefix each open div adds ("> " for a callout, "" for other divs)
  let fence = null
  const prefix = () => stack.join("")
  for (const line of text.split(/\r?\n/)) {
    const fenced = line.match(FENCE)
    if (fence) {
      out.push(prefix() + line)
      if (
        fenced &&
        fenced[2][0] === fence[0] &&
        fenced[2].length >= fence.length &&
        !fenced[3].trim()
      )
        fence = null
      continue
    }
    if (fenced) {
      fence = fenced[2]
      const chunk = fenced[3].match(/^\s*\{([a-zA-Z0-9_-]+)[^}]*\}\s*$/)
      out.push(prefix() + (chunk ? `${fenced[1]}${fenced[2]}${chunk[1]} quarto-runs` : line))
      continue
    }
    const open = line.match(DIV_OPEN)
    if (open) {
      const callout = open[2].match(/\.callout-(\w+)/)
      if (callout) {
        const type = QUARTO_CALLOUTS.includes(callout[1]) ? callout[1] : "note"
        const title = open[2].match(/title\s*=\s*"([^"]*)"/)?.[1] ?? ""
        const fold = /collapse\s*=\s*"?true"?/.test(open[2]) ? "-" : ""
        out.push(`${prefix()}> [!${type}]${fold}${title ? ` ${title}` : ""}`)
        stack.push("> ")
      } else stack.push("")
      continue
    }
    if (DIV_CLOSE.test(line) && stack.length) {
      stack.pop()
      continue
    }
    out.push(prefix() + line)
  }
  return out.join("\n")
}

// ---- front matter ----

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/**
 * The front matter's problems the vault's check would find first: YAML that doesn't parse (with
 * its line in the file) and a missing title. [{line, message}], empty when there are none.
 */
export function frontMatterProblems(text) {
  const match = text.match(FRONT)
  if (!match)
    return [
      { line: 1, message: "no front matter: the page needs a title between --- lines at the top" },
    ]
  const document = parseDocument(match[1])
  // The front matter starts on the file's second line.
  const problems = document.errors.map((error) => ({
    line: (error.linePos?.[0]?.line ?? 1) + 1,
    message: error.message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, ""),
  }))
  if (!problems.length && !String(document.toJS()?.title ?? "").trim())
    problems.push({ line: 2, message: "no title" })
  return problems
}

/** The page's title, from its front matter (the site shows it as the page's heading). */
export function frontTitle(text) {
  const match = text.match(FRONT)
  if (!match) return ""
  try {
    const title = parseDocument(match[1]).toJS()?.title
    return typeof title === "string" || typeof title === "number" ? String(title) : ""
  } catch {
    return ""
  }
}

// ---- Obsidian syntax, as Quartz renders it ----

const IMAGE = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i
// vault-private's content folders (the Worker's src/uploads/rules.ts FOLDERS).
const VAULT_FOLDERS = [
  "onboarding",
  "notes",
  "journal-club",
  "code",
  "library",
  "projects",
  "files",
  "equipment",
  "assets",
  "people",
]
const CALLOUT = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/

/**
 * Where a wikilink's target is on the site. In the private vault a page's links name files of that
 * vault, which the site serves under /resources/ (tools/prepare-unified.mjs privateLink): beside
 * the page first, then from the vault's top, whichever the site has.
 */
export function linkTarget(target, { repo, path, allSlugs }) {
  if (repo !== "vault-private" || !target || /^(?:[a-z]+:|\/|#)/i.test(target)) return target
  const folder = path.split("/").slice(0, -1).join("/")
  const known = new Set(allSlugs)
  const clean = (candidate) =>
    candidate
      .split("/")
      .reduce(
        (parts, part) =>
          part === ".." ? parts.slice(0, -1) : part === "." ? parts : [...parts, part],
        [],
      )
      .join("/")
  const local = clean(folder ? `${folder}/${target}` : target)
  const rooted = clean(target)
  for (const candidate of [local, rooted]) {
    const slug = slugifyFilePath(`resources/${candidate.replace(/\.(?:qmd|ipynb|nb)$/, ".md")}`)
    if (known.has(slug) || known.has(slug.replace(/\/index$/, ""))) return `/resources/${candidate}`
  }
  // A file the site doesn't list (an image, say): from the vault's top when it names one of the
  // vault's folders, else beside the page. A bare name is left to Quartz's shortest-path rule.
  if (!target.includes("/")) return target
  return `/resources/${VAULT_FOLDERS.includes(rooted.split("/")[0]) ? rooted : local}`
}

/** Turn Obsidian's nodes (remark-obsidian) and callouts into what the site renders. */
function siteSyntax(options) {
  const url = (target) =>
    siteUrl(linkTarget(target, options), {
      slug: options.slug,
      origin: options.origin,
      allSlugs: options.allSlugs,
    })
  return (tree) => {
    visit(tree, "wikilink", (node, index, parent) => {
      const target = node.path.trim()
      const anchor = node.heading ? `#${node.heading}` : ""
      if (node.embedded && IMAGE.test(target)) {
        const [alt, width] = /^\d+(?:x\d+)?$/.test(node.alias) ? ["", node.alias] : [node.alias, ""]
        parent.children[index] = {
          type: "image",
          url: url(target),
          alt: alt || "",
          data: width ? { hProperties: { width: width.split("x")[0] } } : undefined,
        }
        return SKIP
      }
      const label = node.alias || (target ? target.split("/").pop() : node.heading) || ""
      parent.children[index] = {
        type: "link",
        url: target ? url(target + anchor) : anchor,
        data: { hProperties: { className: ["internal"] } },
        children: [{ type: "text", value: node.alias ? label : label.replace(/\.md$/, "") }],
      }
      return SKIP
    })
    visit(tree, "highlight", (node) => {
      node.data = { hName: "mark" }
    })
    visit(tree, "tag", (node, index, parent) => {
      parent.children[index] = {
        type: "link",
        url: `${options.origin}/tags/${node.value}`,
        data: { hProperties: { className: ["internal", "tag-link"] } },
        children: [{ type: "text", value: `#${node.value}` }],
      }
      return SKIP
    })
    visit(tree, "code", (node, index, parent) => {
      if (node.meta !== "quarto-runs") return
      node.meta = null
      parent.children.splice(index, 0, {
        type: "paragraph",
        data: { hProperties: { className: ["edit-runs"] } },
        children: [{ type: "text", value: "Runs when the site builds" }],
      })
      return [SKIP, index + 2]
    })
    visit(tree, "blockquote", (node) => {
      const [first, ...rest] = node.children
      const text =
        first?.type === "paragraph" && first.children[0]?.type === "text" ? first.children[0] : null
      const [head, ...more] = text ? text.value.split("\n") : []
      const match = head?.match(CALLOUT)
      if (!match) return
      const [, rawType, fold, rawTitle] = match
      const type = rawType.toLowerCase()
      const titleNodes = more.length ? [] : first.children.slice(1)
      const title = rawTitle.trim()
        ? [{ type: "text", value: rawTitle.trim() }, ...titleNodes]
        : titleNodes.length
          ? titleNodes
          : [{ type: "text", value: type[0].toUpperCase() + type.slice(1).replace(/-/g, " ") }]
      const body = more.length
        ? [
            {
              type: "paragraph",
              children: [{ type: "text", value: more.join("\n") }, ...first.children.slice(1)],
            },
            ...rest,
          ]
        : rest
      const div = (className, children) => ({
        type: "calloutPart",
        data: { hName: "div", hProperties: { className: [className] } },
        children,
      })
      node.children = [
        div("callout-title", [
          div("callout-icon", []),
          div("callout-title-inner", [{ type: "paragraph", children: title }]),
        ]),
        ...(body.length ? [div("callout-content", body)] : []),
      ]
      node.data = {
        hProperties: {
          className: [
            "callout",
            type,
            ...(fold ? ["is-collapsible"] : []),
            ...(fold === "-" ? ["is-collapsed"] : []),
          ],
          dataCallout: type,
        },
      }
    })
  }
}

// ---- sanitizing ----

const CALLOUT_TYPES = [
  "note",
  "abstract",
  "summary",
  "tldr",
  "info",
  "todo",
  "tip",
  "hint",
  "important",
  "success",
  "check",
  "done",
  "question",
  "help",
  "faq",
  "warning",
  "attention",
  "caution",
  "failure",
  "fail",
  "missing",
  "danger",
  "error",
  "bug",
  "example",
  "quote",
  "cite",
]

/** GitHub's sanitizing rules, plus the classes the site's own markup uses. */
export const schema = {
  ...defaultSchema,
  tagNames: [...defaultSchema.tagNames, "mark"],
  attributes: {
    ...defaultSchema.attributes,
    // One className rule per element: GitHub's footnote class and the site's link classes.
    a: [
      ...defaultSchema.attributes.a.filter(
        (rule) => !Array.isArray(rule) || rule[0] !== "className",
      ),
      ["className", "data-footnote-backref", "internal", "external", "tag-link"],
    ],
    blockquote: [
      ...defaultSchema.attributes.blockquote,
      ["className", "callout", "is-collapsible", "is-collapsed", ...CALLOUT_TYPES],
      "dataCallout",
    ],
    code: [["className", /^language-./, "math-inline", "math-display"]],
    div: [
      ...defaultSchema.attributes.div,
      ["className", "callout-title", "callout-icon", "callout-title-inner", "callout-content"],
    ],
    p: [["className", "edit-runs"]],
  },
}

/**
 * A page's text as the preview's HTML (sanitized), with its title. `options`: the page's kind
 * (md, qmd), its vault and path, its slug on the site, the site's slugs and origin.
 */
export function renderPreview(text, options) {
  const markdown = options.kind === "qmd" ? qmdForPreview(text) : text
  const html = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkObsidian, { customTaskChars: false })
    .use(siteSyntax, options)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, schema)
    .use(rehypeKatex, { throwOnError: false, strict: false })
    .use(rehypeStringify)
    .processSync(markdown)
    .toString()
  return { html, title: frontTitle(text) }
}
