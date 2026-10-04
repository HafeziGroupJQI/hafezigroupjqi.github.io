// The members build's access outputs, written after Quartz (tools/build-site.mjs), which the Worker
// reads from its assets (tools/acl/ has the rules; the contract is the Worker's src/acl/):
//   static/contentIndex.json          the search index without restricted pages, and without links
//                                     to them, serialized entry by entry (serializeIndex)
//   static/contentIndex.offsets.json  where each entry is in it, so the Worker can cut one out
//   static/acl-index/<rule>.json      each rule's restricted pages' entries, to splice in
//   static/acl-refs.json              every private page's, alias's, notebook asset's, PDF's and
//                                     restricted file's vault path (aclRefs)
import fs from "node:fs"
import path from "node:path"
import { slugifyFilePath } from "@quartz-community/utils"
import { aclKey } from "./policy.mjs"

/**
 * An index as `{` + entries joined by `,` + `}`, each `JSON.stringify(slug) + ":" +
 * JSON.stringify(value)` (what JSON.stringify of the whole object gives), with each entry's
 * `[start, end]` in the text: JS string (UTF-16) indices, from the key's opening quote to just past
 * the value's closing brace.
 */
export function serializeIndex(entries) {
  let text = "{"
  const offsets = {}
  entries.forEach(([slug, value], index) => {
    if (index) text += ","
    const start = text.length
    text += JSON.stringify(slug) + ":" + JSON.stringify(value)
    offsets[slug] = [start, text.length]
  })
  return { text: text + "}", offsets }
}

/** The site paths a link to a page may take: its slug, and a folder page's as "dir/". */
export const linkForms = (slug) =>
  slug === "index" ? [slug, ""] : slug.endsWith("/index") ? [slug, slug.slice(0, -5)] : [slug]

/**
 * The restricted site paths, each with its rule: the restricted pages (`entries`, by rule), the
 * restricted folders' pages (`folders`, the build's folder map) and the restricted documents
 * (`documents`: the docs manifest; a document's vault path is its `path`, or its key's).
 */
export function restrictedPaths({ entries = {}, folders = {}, documents = {}, acl }) {
  const out = new Map()
  for (const [rule, pages] of Object.entries(entries))
    for (const slug of Object.keys(pages)) for (const form of linkForms(slug)) out.set(form, rule)
  for (const [slug, folder] of Object.entries(folders))
    if (folder?.acl) for (const form of linkForms(`${slug}/index`)) out.set(form, folder.acl)
  for (const [key, document] of Object.entries(documents)) {
    const rule = aclKey(acl, document.path ?? key.replace(/^resources\//, ""))
    if (rule) out.set(key, rule)
  }
  return out
}

/**
 * The index split: `base` (Quartz's index, `[[slug, entry]]`, which has no restricted pages) and
 * `shards` (`{rule: {slug: entry}}`), each entry's links without the restricted paths
 * (`restricted`, restrictedPaths) of any rule but its own.
 */
export function splitIndex(base, shards, restricted) {
  const clean = (entry, own) => ({
    ...entry,
    links: (entry.links ?? []).filter((link) => {
      const rule = restricted.get(link)
      return !rule || rule === own
    }),
  })
  const out = { base: [], shards: {} }
  for (const [slug, entry] of base) {
    // A restricted page Quartz indexed anyway (not unlisted) goes to its rule's shard.
    const rule = restricted.get(slug)
    if (rule) (out.shards[rule] ??= []).push([slug, clean(entry, rule)])
    else out.base.push([slug, clean(entry, null)])
  }
  for (const [rule, pages] of Object.entries(shards))
    for (const [slug, entry] of Object.entries(pages))
      (out.shards[rule] ??= []).push([slug, clean(entry, rule)])
  return out
}

/**
 * Rewrite `output`'s static/contentIndex.json without restricted pages, with its offsets, and write
 * each rule's shard (`pages`: what quartz/plugins/local/acl-index recorded). Returns the counts.
 */
export function writeContentIndex(output, { pages, folders, documents, acl }) {
  const file = path.join(output, "static", "contentIndex.json")
  const index = JSON.parse(fs.readFileSync(file, "utf8"))
  const restricted = restrictedPaths({ entries: pages.entries, folders, documents, acl })
  const { base, shards } = splitIndex(Object.entries(index), pages.entries, restricted)
  const { text, offsets } = serializeIndex(base)
  fs.writeFileSync(file, text)
  fs.writeFileSync(
    path.join(output, "static", "contentIndex.offsets.json"),
    JSON.stringify(offsets),
  )
  const shardDir = path.join(output, "static", "acl-index")
  fs.rmSync(shardDir, { recursive: true, force: true })
  fs.mkdirSync(shardDir, { recursive: true })
  for (const [rule, entries] of Object.entries(shards)) {
    if (!/^[A-Za-z0-9_-]+$/.test(rule)) throw new Error(`access rule id ${rule} can't name a file`)
    fs.writeFileSync(path.join(shardDir, `${rule}.json`), serializeIndex(entries).text)
  }
  return {
    base: base.length,
    restricted: Object.fromEntries(
      Object.entries(shards).map(([rule, list]) => [rule, list.length]),
    ),
  }
}

const walkFiles = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(dir, entry.name)
        return entry.isDirectory() ? walkFiles(file) : [file]
      })
    : []
const posix = (file) => file.split(path.sep).join("/")

// A page's own outputs beside its HTML (page-source, page-history, og-image): its, not a file's.
const PAGE_OUTPUT = /(?:\.html|\.md|\.history\.json|-og-image\.webp)$/

/**
 * `static/acl-refs.json`'s content, from the build's records: every private site path's vault path.
 *   pages           a page's site path (its slug) → its own file; a folder page's → "<folder>/"
 *   aliases         an alias or case redirect page (alias-redirects) → the page's file
 *   notebookAssets  a path under notebook-assets/ → the private pages citing it (an asset a public
 *                   page cites too is public, and left out)
 *   pdfs            pdf/<slug>.pdf → its page's file
 *   files           a restricted file Quartz copied under resources/ (an image, a notebook's
 *                   figure) → its vault path (other files are at resources/<their vault path>)
 * `pages` is quartz/plugins/local/acl-index's record, `folders` the folder map, `notebooks` the
 * notebook step's report, `vaultFiles` the vaults' files (`[{path}]`, docs-manifest.mjs).
 */
export function aclRefs(output, { acl, pages, folders = {}, notebooks = null, vaultFiles = [] }) {
  const exists = (relative) => fs.existsSync(path.join(output, relative))
  const refs = {
    version: acl.version,
    pages: { ...pages.pages },
    aliases: {},
    notebookAssets: {},
    pdfs: {},
    files: {},
  }
  for (const [slug, folder] of Object.entries(folders)) {
    const page = `${slug}/index`
    if (!(page in refs.pages) && exists(`${page}.html`)) refs.pages[page] = `${folder.path}/`
  }
  for (const [alias, vaultPath] of Object.entries(pages.aliases ?? {}))
    if (!(alias in refs.pages) && exists(`${alias}.html`)) refs.aliases[alias] = vaultPath
  const owners = new Map()
  const publicAssets = new Set()
  for (const page of notebooks?.wolfram?.pages ?? []) {
    const own = page.source?.startsWith("resources/") ? page.source.slice(10) : null
    for (const asset of page.assets ?? []) {
      if (!own) publicAssets.add(asset)
      else owners.set(asset, [...new Set([...(owners.get(asset) ?? []), own])].sort())
    }
  }
  for (const [asset, list] of [...owners].sort(([a], [b]) => a.localeCompare(b)))
    if (!publicAssets.has(asset)) refs.notebookAssets[asset] = list
  for (const file of walkFiles(path.join(output, "pdf")).filter((name) => name.endsWith(".pdf"))) {
    const relative = posix(path.relative(output, file))
    const vaultPath = refs.pages[relative.slice(4, -4)]
    if (vaultPath) refs.pdfs[relative] = vaultPath
  }
  // Quartz copies a vault file to its slugified path; a notebook's figures are in <page>_files/.
  const bySite = new Map(
    vaultFiles.map((file) => [slugifyFilePath(`resources/${file.path}`), file.path]),
  )
  for (const file of walkFiles(path.join(output, "resources"))) {
    const relative = posix(path.relative(output, file))
    if (PAGE_OUTPUT.test(relative)) continue
    const figures = /^(.+)_files\//.exec(relative)?.[1]
    const vaultPath = bySite.get(relative) ?? (figures ? refs.pages[figures] : undefined)
    if (vaultPath && aclKey(acl, vaultPath)) refs.files[relative] = vaultPath
  }
  return refs
}

export function writeRefs(output, refs) {
  const file = path.join(output, "static", "acl-refs.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(refs))
  return file
}
