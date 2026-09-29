import { HttpError } from "../http"
import { type Page, getList, getScalar } from "../profile/frontmatter"

// What members may upload to vault-private from the site (routes.ts): where, what and how much.
// vault-private's own check (tools/validate.mjs, run on every pull request) is the real gate;
// these refuse at once what it would refuse later, what would break the member site's build (a
// notebook that isn't one), and every path the site must never write (workflows, tools, dotfiles).

/** vault-private's content folders (its README). Everything else there is tooling or the build's. */
export const FOLDERS = [
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

/** Folders the member build or the validator skip at any depth (tools/prepare-unified.mjs,
 *  vault-private's validate.mjs): a file under one would never show. */
const SKIPPED_FOLDERS = new Set(["node_modules", "schema", "tools", "templates", "gpt", "_freeze"])
const SKIPPED_FILES = new Set([
  "readme.md",
  "package.json",
  "package-lock.json",
  "requirements.txt",
])

/** Whether a folder below the top shows on the site. */
export const shownFolder = (name: string) =>
  !name.startsWith(".") && !SKIPPED_FOLDERS.has(name.toLowerCase())

/** At most this much per file: vault-private has no LFS, and GitHub warns from 50 MB. */
export const FILE_MAX = 25 * 1024 * 1024
/** At most this much staged in one draft. */
export const DRAFT_MAX = 100 * 1024 * 1024
/** Changes in one draft: sending it takes a GitHub request per file, and a Worker request may make
 *  50 on the Workers Free plan. */
export const CHANGES_MAX = 30

type Kind = "page" | "ipynb" | "nb" | "pdf" | "image" | "zip" | "ole" | "text" | "binary"

const TEXT = "text/plain; charset=utf-8"
const BINARY = "application/octet-stream"

/** The file types members may upload, by extension, with how they are checked and stored.
 *  Never HTML, SVG or XML: nothing uploaded may run in a browser. */
export const TYPES: Record<string, { kind: Kind; mime: string }> = {
  md: { kind: "page", mime: "text/markdown; charset=utf-8" },
  qmd: { kind: "page", mime: "text/markdown; charset=utf-8" },
  ipynb: { kind: "ipynb", mime: "application/x-ipynb+json" },
  nb: { kind: "nb", mime: "application/vnd.wolfram.mathematica" },
  pdf: { kind: "pdf", mime: "application/pdf" },
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  docx: {
    kind: "zip",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  pptx: {
    kind: "zip",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  xlsx: { kind: "zip", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  doc: { kind: "ole", mime: "application/msword" },
  ppt: { kind: "ole", mime: "application/vnd.ms-powerpoint" },
  xls: { kind: "ole", mime: "application/vnd.ms-excel" },
  csv: { kind: "text", mime: "text/csv; charset=utf-8" },
  tsv: { kind: "text", mime: "text/tab-separated-values; charset=utf-8" },
  txt: { kind: "text", mime: TEXT },
  dat: { kind: "text", mime: TEXT },
  json: { kind: "text", mime: "application/json" },
  py: { kind: "text", mime: "text/x-python; charset=utf-8" },
  m: { kind: "text", mime: TEXT },
  wl: { kind: "text", mime: TEXT },
  wls: { kind: "text", mime: TEXT },
  jl: { kind: "text", mime: TEXT },
  sh: { kind: "text", mime: TEXT },
  tex: { kind: "text", mime: TEXT },
  bib: { kind: "text", mime: TEXT },
  spt: { kind: "text", mime: TEXT },
  gds: { kind: "binary", mime: BINARY },
  mat: { kind: "binary", mime: BINARY },
  h5: { kind: "binary", mime: BINARY },
  npy: { kind: "binary", mime: BINARY },
  npz: { kind: "binary", mime: BINARY },
}

export const extension = (name: string) => /\.([^./]+)$/.exec(name)?.[1].toLowerCase() ?? ""

/** A file's type, or a 415 naming the types that may be uploaded. */
export function typeOf(path: string): { ext: string; kind: Kind; mime: string } {
  const ext = extension(path)
  const type = Object.hasOwn(TYPES, ext) ? TYPES[ext] : undefined
  if (!type)
    throw new HttpError(
      415,
      `${ext ? `.${ext}` : "files without an extension"} can't be uploaded; the site takes ${Object.keys(
        TYPES,
      )
        .map((e) => `.${e}`)
        .join(" ")}`,
    )
  return { ext, ...type }
}

// Windows and macOS can't hold these in a name, and Obsidian's links break on # ^ [ ] |.
const FORBIDDEN = /[\p{Cc}\u2028\u2029\\:*?"<>|#^[\]`]/u

/** A folder of vault-private, as members may write to it: "" is the top, else under FOLDERS. */
export function vaultFolder(raw: unknown): string {
  if (raw === "" || raw === null || raw === undefined) return ""
  return checkSegments(raw, 1).join("/")
}

/**
 * A path in vault-private a member may write: under one of its content folders, never a dotfile,
 * `..`, a folder the site skips or a name Windows or Obsidian can't hold, and of a type the site
 * takes. Normalized to NFC, as macOS would.
 */
export function vaultPath(raw: unknown): string {
  const segments = checkSegments(raw, 2)
  const name = segments[segments.length - 1]
  if (SKIPPED_FILES.has(name.toLowerCase()))
    throw new HttpError(422, `the site doesn't show files named ${name}; name it differently`)
  typeOf(name)
  return segments.join("/")
}

function checkSegments(raw: unknown, least: number): string[] {
  if (typeof raw !== "string" || !raw.trim()) throw new HttpError(422, "choose a path in the vault")
  const path = raw.normalize("NFC")
  if (path.length > 300) throw new HttpError(422, "that path is longer than 300 characters")
  if (FORBIDDEN.test(path))
    throw new HttpError(
      422,
      "a path can't contain control characters, \\ : * ? \" < > | # ^ [ ] or backquotes",
    )
  const segments = path.split("/")
  for (const segment of segments) {
    if (!segment) throw new HttpError(422, "a path can't start or end with / or contain //")
    if (segment === "." || segment === "..")
      throw new HttpError(422, "a path can't contain . or ..")
    if (segment.startsWith("."))
      throw new HttpError(422, "hidden files and folders (names starting with .) can't be uploaded")
    if (segment !== segment.trim())
      throw new HttpError(422, "a file or folder name can't start or end with a space")
    if (segment.length > 120) throw new HttpError(422, `${segment.slice(0, 40)}… is too long`)
  }
  if (!FOLDERS.includes(segments[0]))
    throw new HttpError(422, `uploads go into one of the vault's folders: ${FOLDERS.join(", ")}`)
  if (segments.length < least)
    throw new HttpError(422, "a file goes into a folder, not the top of the vault")
  const skipped = segments.slice(1, least === 2 ? -1 : undefined)
  const hidden = skipped.find((segment) => SKIPPED_FOLDERS.has(segment.toLowerCase()))
  if (hidden)
    throw new HttpError(422, `the site skips folders named ${hidden}, so nothing there would show`)
  return segments
}

/**
 * The content of a file about to be staged at `path`: refused (422) with the reason when the
 * validator or the member build would refuse it, or it isn't the type its name says. Returns why
 * a person must review it before it goes in (reviewReason), or null.
 */
export function checkContent(path: string, bytes: Uint8Array): string | null {
  const name = path.split("/").pop()!
  if (!bytes.length) throw new HttpError(422, `${name} is empty`)
  const { kind } = typeOf(path)
  const head = String.fromCharCode(...bytes.subarray(0, 1024))
  const not = (what: string) => new HttpError(422, `${name} isn't ${what}`)
  if (kind === "page") {
    const text = utf8(bytes, name)
    const problems = pageProblems(text)
    if (problems.length)
      throw new HttpError(422, `${name} wouldn't pass the vault's check: ${problems.join("; ")}`)
    if (/\.qmd$/i.test(name) && codeCells(text)) return "its code cells run when the site builds"
    return activeHtml(text) ? "it has HTML that runs in the browser" : null
  }
  if (kind === "ipynb") {
    let notebook: { nbformat?: unknown; cells?: unknown } | null = null
    try {
      notebook = JSON.parse(utf8(bytes, name))
    } catch {}
    if (notebook?.nbformat !== 4 || !Array.isArray(notebook.cells))
      throw not("a Jupyter notebook (nbformat 4)")
    return activeNotebook(notebook.cells)
      ? "its outputs or text have HTML or JavaScript that runs in the browser"
      : null
  }
  if (kind === "nb") {
    if (!/^\s*(?:\(\*\s*Content-type: application\/vnd\.wolfram|Notebook\[)/.test(head))
      throw not("a Wolfram notebook")
    return "Wolfram notebooks are evaluated in part when the site renders them"
  }
  if (kind === "pdf") {
    if (!head.includes("%PDF-")) throw not("a PDF")
  } else if (kind === "image") {
    if (!imageMagic(extension(name), head)) throw not(`a ${extension(name).toUpperCase()} image`)
  } else if (kind === "zip") {
    if (!head.startsWith("PK\x03\x04")) throw not("an Office document")
  } else if (kind === "ole") {
    if (!head.startsWith("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")) throw not("an Office document")
  }
  return null
}

// ---- what a person reviews before it goes in ----
// The hourly merge takes a draft in by itself only when nothing in it runs: members could upload
// with a stolen session, and what runs at build time (Quarto code cells, a Wolfram notebook's
// render) or in members' browsers (HTML in a page or a notebook's outputs) would then run as the
// site. Such a draft waits, checked and ready, for an admin to merge it on GitHub.

const withoutCode = (text: string) =>
  text.replace(/^(```+|~~~+)[^\n]*\n[\s\S]*?^\1\s*$/gm, "").replace(/`[^`\n]+`/g, "")

/** HTML that runs or takes over the page: scripts, frames, event handlers, javascript: links. */
export function activeHtml(text: string): boolean {
  return /<\s*\/?\s*(?:script|iframe|frame|frameset|object|embed|applet|base|meta|link|form|style|svg|math|template|portal)\b|<[^>]*\s(?:on[a-z]+|srcdoc|formaction)\s*=|(?:javascript|vbscript)\s*:|data:text\/html/i.test(
    withoutCode(text),
  )
}

/** Whether a Quarto document has code that runs when it renders: chunks ```{python} or inline `{python} x`. */
export function codeCells(text: string): boolean {
  return (
    /^\s*(?:```+|~~~+)\s*\{[^}\n]*\}/m.test(text) || /`\{[a-z]+\}\s[^`\n]+`|`r\s[^`\n]+`/.test(text)
  )
}

const joined = (value: unknown) =>
  Array.isArray(value) ? value.join("") : typeof value === "string" ? value : ""

/** A notebook whose Markdown, raw cells or outputs carry HTML or JavaScript that would show. */
function activeNotebook(cells: unknown[]): boolean {
  for (const cell of cells as { cell_type?: string; source?: unknown; outputs?: unknown }[]) {
    if (cell?.cell_type !== "code" && activeHtml(joined(cell?.source))) return true
    for (const output of Array.isArray(cell?.outputs) ? cell.outputs : []) {
      const data = (output as { data?: Record<string, unknown> })?.data ?? {}
      for (const [type, value] of Object.entries(data)) {
        if (/javascript|widget/i.test(type)) return true
        if (/html|svg|markdown/i.test(type) && activeHtml(joined(value))) return true
      }
    }
  }
  return false
}

function imageMagic(ext: string, head: string): boolean {
  if (ext === "png") return head.startsWith("\x89PNG\r\n\x1a\n")
  if (ext === "jpg" || ext === "jpeg") return head.startsWith("\xff\xd8\xff")
  if (ext === "gif") return /^GIF8[79]a/.test(head)
  return head.startsWith("RIFF") && head.slice(8, 12) === "WEBP"
}

// A byte-order mark stays, as it does for the validator, whose front matter pattern then fails.
function utf8(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new HttpError(422, `${name} isn't UTF-8 text`)
  }
}

/**
 * The checks vault-private's tools/validate.mjs makes of every page (.md, .qmd) that need nothing
 * but the page: front matter with a title, a type and `internal` as the first tag, and no remote
 * or site-absolute images. Links to other files it checks against the whole vault, on GitHub.
 */
export function pageProblems(text: string): string[] {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) return ["it has no front matter (title, type and tags between --- lines at the top)"]
  const problems: string[] = []
  const page: Page = { front: match[1].split(/\r?\n/), body: "" }
  if (!getScalar(page, "title")) problems.push("no title")
  if (!getScalar(page, "type")) problems.push("no type")
  if (getList(page, "tags")?.[0] !== "internal") problems.push("its first tag must be internal")
  const body = text
    .slice(match[0].length)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "")
  for (const link of body.matchAll(/(!?)\[[^\]]*\]\(([^)]+)\)/g)) {
    if (link[1] !== "!") continue
    const raw = link[2].replace(/\s+["'][^"']*["']\s*$/, "")
    if (/^(?:https?:|mailto:)/i.test(raw))
      problems.push(`remote images must be stored in the vault: ${raw}`)
    else if (raw.startsWith("/")) problems.push(`site-absolute embeds are not supported: ${raw}`)
  }
  for (const image of body.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi))
    if (/^(?:https?:|\/\/)/i.test(image[1]))
      problems.push(`remote images must be stored in the vault: ${image[1]}`)
  return problems
}
