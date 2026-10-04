// The members build's leak scan: no restricted page's words outside what its rule's members get.
// For each restricted page (an access rule's, tools/acl/), its needles are its slug, its title, the
// names of its rule's files (images, documents, notebook assets) and three distinctive sentences of
// its text. Every text file of the build is searched for them (HTML, JSON, JS, XML, SVG, Markdown,
// text; binary files are skipped), except the rule's own files (its pages and what is beside them,
// its alias pages, files, PDFs and notebook assets, its search index shard) and, inside a file,
// elements tagged with its data-acl (tools/acl/lists.mjs), which the Worker shows only to those
// members. static/acl-refs.json is the Worker's own (it names every private file) and isn't searched.
// Any needle found fails the build (tools/build-site.mjs), with the file and the needle.
//
//   node tools/acl-leak-scan.mjs <build> --snapshot <the access rules snapshot (ACL_SNAPSHOT)>
//     [--manifest worker/generated/docs-manifest.json]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fromHtml } from "hast-util-from-html"
import { aclKey, normalizeSnapshot } from "./acl/policy.mjs"

const TEXT = /\.(?:html?|json|js|mjs|cjs|css|xml|svg|txt|md|webmanifest|map|csv|ya?ml)$/i
const REFS = "static/acl-refs.json"
const SHARDS = "static/acl-index"
// A page's own outputs beside its HTML (page-source, page-history, og-image).
const BESIDE = [".html", ".md", ".history.json", "-og-image.webp"]
const MIN_TITLE = 12
const MIN_NAME = 6
const SENTENCES = 3

const posix = (file) => file.split(path.sep).join("/")
const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name)
        return entry.isDirectory() ? walk(file) : [file]
      })
    : []
const squash = (text) => text.replace(/\s+/g, " ").trim()
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
/** Text with its HTML character references decoded (the search index's text is escaped). */
export const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) =>
    name[0] === "#"
      ? String.fromCodePoint(
          name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
        )
      : (ENTITIES[name.toLowerCase()] ?? entity),
  )
const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c],
  )

/**
 * Up to `count` distinctive sentences of a page's text: the longest of at least 40 characters that
 * read the same in every output (no quotes, ampersands, markup or math, no dashes the site turns
 * into em dashes, no addresses).
 */
export function sentences(text, count = SENTENCES) {
  const seen = new Set()
  return decode(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(squash)
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 400)
    .filter((sentence) => !/["'“”‘’&<>`$*_[\]{}|#\\]|--|:\/\//.test(sentence))
    .filter((sentence) => !seen.has(sentence) && seen.add(sentence))
    .sort((a, b) => b.length - a.length)
    .slice(0, count)
}

/**
 * Which rules own each output file (`Map<file, Set<rule>>`): a restricted page's own outputs, its
 * alias pages, PDF and files, notebook assets only restricted pages cite, and each rule's shard.
 */
export function owners(refs, acl, shardRules = []) {
  const out = new Map()
  const own = (file, rule) => {
    if (!rule) return
    if (!out.has(file)) out.set(file, new Set())
    out.get(file).add(rule)
  }
  for (const [slug, vaultPath] of Object.entries(refs.pages ?? {}))
    for (const suffix of BESIDE) own(slug + suffix, aclKey(acl, vaultPath))
  for (const [alias, vaultPath] of Object.entries(refs.aliases ?? {}))
    own(`${alias}.html`, aclKey(acl, vaultPath))
  for (const [pdf, vaultPath] of Object.entries(refs.pdfs ?? {})) own(pdf, aclKey(acl, vaultPath))
  for (const [file, vaultPath] of Object.entries(refs.files ?? {}))
    own(file, aclKey(acl, vaultPath))
  for (const [asset, pages] of Object.entries(refs.notebookAssets ?? {})) {
    const rules = pages.map((page) => aclKey(acl, page))
    if (rules.every(Boolean)) for (const rule of rules) own(`notebook-assets/${asset}`, rule)
  }
  for (const rule of shardRules) own(`${SHARDS}/${rule}.json`, rule)
  return out
}

/**
 * Each rule's needles: `[{rule, kind, needle, page, bounded}]`. `shards` are the rules' search
 * index entries, `documents` the docs manifest (documents never reach the build), `names` every
 * output file's name with the rules that own it (a name some other file has too isn't a needle).
 */
export function needles({ refs, acl, shards, documents = {}, names = new Map() }) {
  const out = []
  const add = (rule, kind, needle, page, bounded = false) => {
    const text = squash(needle)
    if (text && !out.some((n) => n.rule === rule && n.needle === text))
      out.push({ rule, kind, needle: text, page, bounded })
  }
  const titles = new Map()
  for (const [rule, entries] of Object.entries(shards))
    for (const [slug, entry] of Object.entries(entries)) {
      titles.set(slug, entry.title)
      add(rule, "slug", slug, slug, true)
      const title = squash(decode(String(entry.title ?? "")))
      if (title.length >= MIN_TITLE) {
        // As written, as the site's em dashes make it, and as HTML escapes it.
        const variants = [title, title.replace(/---/g, "—").replace(/--/g, "–")]
        for (const variant of [...variants, ...variants.map(escapeHtml)])
          add(rule, "title", variant, slug)
      }
      for (const sentence of sentences(String(entry.content ?? "")))
        add(rule, "sentence", sentence, slug)
    }
  for (const [slug, vaultPath] of Object.entries(refs.pages ?? {})) {
    const rule = aclKey(acl, vaultPath)
    if (rule && !vaultPath.endsWith("/") && !titles.has(slug)) add(rule, "slug", slug, slug, true)
  }
  // File names: only a rule's own, and only names nothing else in the build has.
  const fileNames = []
  for (const [file, vaultPath] of Object.entries(refs.files ?? {}))
    fileNames.push([aclKey(acl, vaultPath), path.posix.basename(file), vaultPath])
  for (const [key, document] of Object.entries(documents)) {
    const vaultPath = document.path ?? key.replace(/^resources\//, "")
    const rule = aclKey(acl, vaultPath)
    if (!rule) continue
    fileNames.push([rule, path.posix.basename(key), vaultPath])
    fileNames.push([rule, path.posix.basename(vaultPath), vaultPath])
  }
  for (const [asset, pages] of Object.entries(refs.notebookAssets ?? {})) {
    const rules = new Set(pages.map((page) => aclKey(acl, page)))
    if (rules.size === 1 && [...rules][0])
      fileNames.push([[...rules][0], path.posix.basename(asset), pages[0]])
  }
  for (const [rule, name, vaultPath] of fileNames) {
    const stem = name.replace(/\.[^.]+$/, "")
    const others = [...(names.get(name) ?? [])].filter((owner) => owner !== rule)
    if (rule && stem.length >= MIN_NAME && !others.length) add(rule, "file", name, vaultPath, true)
  }
  return out
}

const WORD = /[A-Za-z0-9_-]/

/** Every needle in `text`: `[{needle, at}]` (a bounded needle not inside a longer name). */
function find(pattern, text, bounded) {
  const found = []
  pattern.lastIndex = 0
  for (let match; (match = pattern.exec(text));) {
    const at = match.index
    const needle = match[0]
    if (
      bounded.has(needle) &&
      (WORD.test(text[at - 1] ?? "") || WORD.test(text[at + needle.length] ?? ""))
    )
      pattern.lastIndex = at + 1
    else found.push({ needle, at })
    if (!needle.length) pattern.lastIndex++
  }
  return found
}

/** An HTML file's data-acl elements (`[{rule, start, end}]`) and its text by the rules it is under. */
function htmlParts(raw) {
  const tree = fromHtml(raw)
  const ranges = []
  const segments = new Map()
  const visit = (node, chain) => {
    if (node.type === "text") {
      const key = chain.join(" ")
      if (!segments.has(key)) segments.set(key, { chain, parts: [] })
      segments.get(key).parts.push(node.value)
      return
    }
    let own = chain
    const rule = node.type === "element" ? node.properties?.dataAcl : undefined
    if (rule !== undefined) {
      own = [...chain, String(rule)]
      if (node.position)
        ranges.push({
          rule: String(rule),
          start: node.position.start.offset,
          end: node.position.end.offset,
        })
    }
    for (const child of node.children ?? []) visit(child, own)
    // Attribute values (titles, meta descriptions) read as text too.
    if (node.type === "element")
      for (const value of Object.values(node.properties ?? {}))
        if (typeof value === "string" && value.length >= MIN_TITLE)
          visit({ type: "text", value: ` ${value} ` }, own)
  }
  visit(tree, [])
  return {
    ranges,
    segments: [...segments.values()].map(({ chain, parts }) => ({
      chain,
      text: squash(parts.join(" ")),
    })),
  }
}

// A Markdown source's data-acl blocks, as the build writes them.
const BLOCK = /<(div|ul|span) data-acl="([^"]*)">[\s\S]*?<\/\1>/g

/** A file's text as searched: `{ranges, segments}`, segments' text by the data-acl rules over it. */
export function fileParts(file, raw) {
  if (/\.html?$/i.test(file)) {
    if (raw.includes("data-acl")) return htmlParts(raw)
    const text = squash(decode(raw.replace(/<[^>]*>/g, " ")))
    return { ranges: [], segments: [{ chain: [], text }] }
  }
  if (/\.json$/i.test(file)) {
    const strings = []
    const collect = (value) => {
      if (typeof value === "string") strings.push(value)
      else if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === "object")
        for (const [key, item] of Object.entries(value)) (strings.push(key), collect(item))
    }
    try {
      collect(JSON.parse(raw))
    } catch {
      strings.push(raw)
    }
    return { ranges: [], segments: [{ chain: [], text: squash(decode(strings.join("\n"))) }] }
  }
  const ranges = [...raw.matchAll(BLOCK)].map((match) => ({
    rule: match[2],
    start: match.index,
    end: match.index + match[0].length,
  }))
  const segments = [{ chain: [], parts: [] }]
  let at = 0
  for (const range of ranges) {
    segments[0].parts.push(raw.slice(at, range.start))
    segments.push({ chain: [range.rule], parts: [raw.slice(range.start, range.end)] })
    at = range.end
  }
  segments[0].parts.push(raw.slice(at))
  return {
    ranges,
    segments: segments.map(({ chain, parts }) => ({
      chain,
      text: squash(decode(parts.join(" "))),
    })),
  }
}

/** Whether a file is text to search: by its type, and with no NUL byte in its start. */
function textOf(file) {
  if (!TEXT.test(file)) return null
  const bytes = fs.readFileSync(file)
  if (bytes.subarray(0, 8192).includes(0)) return null
  return bytes.toString("utf8")
}

/**
 * Search the build at `output` for restricted pages' needles. `acl` is the access rules snapshot,
 * `documents` the docs manifest. Returns `{hits: [{file, rule, kind, needle, page}], files, needles}`.
 */
export function leakScan(output, { acl, documents = {} }) {
  acl = normalizeSnapshot(acl)
  const refsFile = path.join(output, REFS)
  const refs = fs.existsSync(refsFile) ? JSON.parse(fs.readFileSync(refsFile, "utf8")) : {}
  const shards = {}
  for (const file of walk(path.join(output, SHARDS)).filter((name) => name.endsWith(".json")))
    shards[path.basename(file, ".json")] = JSON.parse(fs.readFileSync(file, "utf8"))
  const owned = owners(refs, acl, Object.keys(shards))
  const files = walk(output).map((file) => posix(path.relative(output, file)))
  const names = new Map()
  for (const file of files) {
    const name = path.posix.basename(file)
    if (!names.has(name)) names.set(name, new Set())
    for (const rule of owned.get(file) ?? ["*"]) names.get(name).add(rule)
  }
  for (const [key, document] of Object.entries(documents)) {
    const rule = aclKey(acl, document.path ?? key.replace(/^resources\//, "")) ?? "*"
    for (const name of [path.posix.basename(key), path.posix.basename(document.path ?? key)]) {
      if (!names.has(name)) names.set(name, new Set())
      names.get(name).add(rule)
    }
  }
  const list = needles({ refs, acl, shards, documents, names })
  const result = { hits: [], files: 0, needles: list.length }
  if (!list.length) return result
  const byText = new Map()
  for (const needle of list)
    byText.set(needle.needle, [...(byText.get(needle.needle) ?? []), needle])
  const escaped = [...byText.keys()]
    .sort((a, b) => b.length - a.length)
    .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const pattern = new RegExp(escaped.join("|"), "g")
  const bounded = new Set(list.filter((needle) => needle.bounded).map((needle) => needle.needle))
  const seen = new Set()
  const hit = (file, needle) => {
    const key = `${file}\0${needle.rule}\0${needle.needle}`
    if (seen.has(key)) return
    seen.add(key)
    result.hits.push({
      file,
      rule: needle.rule,
      kind: needle.kind,
      needle: needle.needle,
      page: needle.page,
    })
  }
  for (const file of files) {
    if (file === REFS) continue
    const raw = textOf(path.join(output, file))
    if (raw === null) continue
    result.files++
    const mine = owned.get(file) ?? new Set()
    const parts = fileParts(file, raw)
    for (const { needle: text, at } of find(pattern, raw, bounded))
      for (const needle of byText.get(text))
        if (
          !mine.has(needle.rule) &&
          !parts.ranges.some(
            (range) => range.rule === needle.rule && range.start <= at && at < range.end,
          )
        )
          hit(file, needle)
    for (const segment of parts.segments)
      for (const { needle: text } of find(pattern, segment.text, bounded))
        for (const needle of byText.get(text))
          if (!mine.has(needle.rule) && !segment.chain.includes(needle.rule)) hit(file, needle)
  }
  return result
}

/** The hits as lines for a failing build. */
export const report = (hits, limit = 60) =>
  hits
    .slice(0, limit)
    .map(
      (hit) =>
        `  ${hit.file}: ${hit.rule} ${hit.kind} "${hit.needle.slice(0, 120)}" (of ${hit.page})`,
    )
    .concat(hits.length > limit ? [`  … and ${hits.length - limit} more`] : [])
    .join("\n")

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (name) => {
    const at = args.indexOf(`--${name}`)
    return at >= 0 ? args[at + 1] : undefined
  }
  const output = args.find(
    (arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
  )
  const snapshot = option("snapshot")
  if (!output || !snapshot) {
    console.error(
      "usage: node tools/acl-leak-scan.mjs <build> --snapshot <acl.json> [--manifest <docs-manifest.json>]",
    )
    process.exit(2)
  }
  const manifest = option("manifest") ?? "worker/generated/docs-manifest.json"
  const started = Date.now()
  const result = leakScan(path.resolve(output), {
    acl: JSON.parse(fs.readFileSync(snapshot, "utf8")),
    documents: fs.existsSync(manifest)
      ? JSON.parse(fs.readFileSync(manifest, "utf8")).documents
      : {},
  })
  console.log(
    `acl leak scan: ${result.needles} needles in ${result.files} files, ${result.hits.length} found, in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  )
  if (result.hits.length) {
    console.error(report(result.hits))
    process.exit(1)
  }
}
