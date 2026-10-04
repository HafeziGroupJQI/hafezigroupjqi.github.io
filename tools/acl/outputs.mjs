// The members build's access outputs, written after Quartz (tools/build-site.mjs), which the Worker
// reads from its assets (tools/acl/ has the rules; the contract is the Worker's src/acl/):
//   static/contentIndex.json          the search index without restricted pages, and without links
//                                     to them, serialized entry by entry (serializeIndex)
//   static/contentIndex.offsets.json  where each entry is in it, so the Worker can cut one out
//   static/acl-index/<rule>.json      each rule's restricted pages' entries, to splice in
import fs from "node:fs"
import path from "node:path"
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
