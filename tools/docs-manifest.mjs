import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { slugifyFilePath } from "@quartz-community/utils"

/** A file's git blob sha, as `git hash-object` gives it: what GitHub calls the file's sha on main. */
export const blobSha = (bytes) =>
  crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")

// Private documents (PDFs, Office files, audio, scripts: everything that is neither a page
// nor an image) never enter the deployed site. The member build records, per output path,
// the git blob the Worker streams from GitHub on demand.
export const pagePattern = /\.(?:md|qmd|base)$/i
export const imagePattern = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i
export const isDocument = (file) => !pagePattern.test(file) && !imagePattern.test(file)
// A Quarto document is a page, and members can also download its source, as they can a
// notebook's: the manifest lists it too (the page links it, tools/prepare-unified.mjs).
export const isPageSource = (file) => /\.qmd$/i.test(file)
export const MAX_ASSET_BYTES = 25 * 1024 * 1024
export const MAX_ASSET_FILES = 20000

const contentTypes = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  py: "text/x-python; charset=utf-8",
  ipynb: "application/x-ipynb+json",
  qmd: "text/markdown; charset=utf-8",
  nb: "application/vnd.wolfram.mathematica",
  json: "application/json",
  yml: "application/yaml",
  yaml: "application/yaml",
  vtt: "text/vtt; charset=utf-8",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  zip: "application/zip",
}
export const contentTypeFor = (file) => {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (contentTypes[ext]) return contentTypes[ext]
  if (["m", "spt", "ini", "cfg", "mjs", "js", "bib", "tex", "log"].includes(ext))
    return "text/plain; charset=utf-8"
  return "application/octet-stream"
}

const normalize = (value) => value.split(path.sep).join("/")
const walk = (directory) =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name)
        return entry.isDirectory() ? walk(file) : [file]
      })
    : []

// Every committed file of the private vault, straight from git so the blob shas are the ones
// GitHub serves. Dotted segments and the folders the build excludes are skipped.
export function listTrackedFiles(privateRoot, excluded = new Set()) {
  const listing = execFileSync("git", ["-C", privateRoot, "ls-tree", "-r", "-l", "-z", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  const files = []
  for (const entry of listing.split("\0")) {
    if (!entry) continue
    const [meta, file] = entry.split("\t")
    const [, type, sha, size] = meta.trim().split(/\s+/)
    if (type !== "blob") continue
    const segments = file.split("/")
    if (segments.some((segment) => segment.startsWith(".") || excluded.has(segment))) continue
    files.push({ path: file, sha, size: Number(size) })
  }
  return files
}

/**
 * Every committed file of the private vault and of the restricted vaults overlaid on it
 * (tools/acl/vaults.mjs: `[{repo, prefix, dir}]`), each from its own repository's git, with its
 * repo. A restricted vault's repo path is its vault path, so only its files under its prefix count.
 */
export function listVaultFiles(privateRoot, { excluded = new Set(), restricted = [] } = {}) {
  return [
    ...listTrackedFiles(privateRoot, excluded).map((file) => ({ ...file, repo: "vault-private" })),
    ...restricted.flatMap(({ repo, prefix, dir }) =>
      listTrackedFiles(dir, excluded)
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => ({ ...file, repo })),
    ),
  ]
}

/** Every committed document in the private vault (and each Quarto page's source). */
export const listTrackedDocuments = (privateRoot, excluded = new Set(), restricted = []) =>
  listVaultFiles(privateRoot, { excluded, restricted }).filter(
    (file) => isDocument(file.path) || isPageSource(file.path),
  )

export const documentKey = (file, prefix = "resources") => slugifyFilePath(`${prefix}/${file}`)

// An entry is `{sha, size, contentType}`, plus the document's `repo` when it is a restricted vault's
// (its blob is in that repository) and its vault `path` when the site path isn't "<prefix>/<path>".
export function docsManifest(
  privateRoot,
  { excluded = new Set(), prefix = "resources", restricted = [] } = {},
) {
  const manifest = {}
  const sources = new Map()
  for (const document of listTrackedDocuments(privateRoot, excluded, restricted)) {
    const key = documentKey(document.path, prefix)
    if (sources.has(key))
      throw new Error(
        `documents collide on the site path ${key}: ${sources.get(key)} and ${document.path}`,
      )
    sources.set(key, document.path)
    manifest[key] = {
      sha: document.sha,
      size: document.size,
      contentType: contentTypeFor(document.path),
      ...(document.repo !== "vault-private" ? { repo: document.repo } : {}),
      ...(key !== `${prefix}/${document.path}` ? { path: document.path } : {}),
    }
  }
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)))
}

// Documents present in the staged content but absent from the manifest have not been
// committed, so the Worker could never fetch them.
export function untrackedDocuments(stageDir, manifest, prefix = "resources") {
  const root = path.join(stageDir, prefix)
  return walk(root)
    .filter((file) => isDocument(file))
    .map((file) => normalize(path.relative(stageDir, file)))
    .filter((relative) => !(slugifyFilePath(relative) in manifest))
}

// A page's revisions, which the build writes beside it (quartz/plugins/local/page-history).
const isPageHistory = (file) => file.endsWith(".history.json")

// Remove any manifest document that still reached the built site (Quartz ignores their
// extensions, so this is a safety net) and refuse anything else that is not a page, a page's
// history or an image.
export function pruneDocuments(outputDir, manifest, prefix = "resources") {
  let pruned = 0
  for (const file of walk(path.join(outputDir, prefix))) {
    if (file.endsWith(".html") || isPageHistory(file) || !isDocument(file)) continue
    const relative = normalize(path.relative(outputDir, file))
    if (!(relative in manifest))
      throw new Error(`untracked document in the private vault (commit it first): ${relative}`)
    fs.rmSync(file)
    pruned++
  }
  return pruned
}

export const documentExtensions = (manifest) =>
  [...new Set(Object.keys(manifest).map((key) => path.extname(key)))].filter(Boolean)

export function writeDocsManifest(manifest, file = "worker/generated/docs-manifest.json") {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        repo: "HafeziGroupJQI/vault-private",
        documents: manifest,
      },
      null,
      2,
    ) + "\n",
  )
  return file
}
