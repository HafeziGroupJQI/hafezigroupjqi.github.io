import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { slugifyFilePath } from "@quartz-community/utils"

// Private documents (PDFs, Office files, audio, scripts: everything that is neither a page
// nor an image) never enter the deployed site. The member build records, per output path,
// the git blob the Worker streams from GitHub on demand.
export const pagePattern = /\.(?:md|qmd|base)$/i
export const imagePattern = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i
export const isDocument = (file) => !pagePattern.test(file) && !imagePattern.test(file)
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

// Every committed document in the private vault, straight from git so the blob shas are the
// ones GitHub serves. Dotted segments and the folders the build excludes are skipped.
export function listTrackedDocuments(privateRoot, excluded = new Set()) {
  const listing = execFileSync("git", ["-C", privateRoot, "ls-tree", "-r", "-l", "-z", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  const documents = []
  for (const entry of listing.split("\0")) {
    if (!entry) continue
    const [meta, file] = entry.split("\t")
    const [, type, sha, size] = meta.trim().split(/\s+/)
    if (type !== "blob") continue
    const segments = file.split("/")
    if (segments.some((segment) => segment.startsWith(".") || excluded.has(segment))) continue
    if (!isDocument(file)) continue
    documents.push({ path: file, sha, size: Number(size) })
  }
  return documents
}

export const documentKey = (file, prefix = "resources") => slugifyFilePath(`${prefix}/${file}`)

export function docsManifest(privateRoot, { excluded = new Set(), prefix = "resources" } = {}) {
  const manifest = {}
  const sources = new Map()
  for (const document of listTrackedDocuments(privateRoot, excluded)) {
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

// Remove any manifest document that still reached the built site (Quartz ignores their
// extensions, so this is a safety net) and refuse anything else that is not a page or image.
export function pruneDocuments(outputDir, manifest, prefix = "resources") {
  let pruned = 0
  for (const file of walk(path.join(outputDir, prefix))) {
    if (file.endsWith(".html") || !isDocument(file)) continue
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
