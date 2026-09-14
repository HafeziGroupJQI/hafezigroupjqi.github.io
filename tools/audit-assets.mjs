import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import yaml from "yaml"

const imagePattern = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i
const mediaPattern = /\.(?:avif|gif|jpe?g|mp3|mp4|pdf|png|svg|vtt|wav|webm|webp)$/i
const pagePattern = /\.(?:md|qmd)$/
const ignoredDirectories = new Set([
  ".cache",
  ".git",
  ".github",
  ".obsidian",
  ".quarto",
  ".venv",
  ".venv312",
  "_freeze",
  "node_modules",
])

const walk = (directory, ignore = true) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignore && (entry.name.startsWith(".") || ignoredDirectories.has(entry.name))) return []
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(filename, ignore) : [filename]
  })

const normalize = (value) => value.split(path.sep).join("/")
const withoutCode = (text) =>
  text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "")

const parsePage = (filename) => {
  const text = fs.readFileSync(filename, "utf8")
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  return {
    frontmatter: match ? yaml.parse(match[1]) ?? {} : {},
    body: withoutCode(match ? text.slice(match[0].length) : text),
  }
}

const localReference = (raw) => {
  const trimmed = raw.trim().replace(/^<|>$/g, "").replace(/\s+["'][^"']*["']\s*$/, "")
  if (/^(?:data:|https?:|\/\/)/i.test(trimmed)) return null
  try {
    return decodeURIComponent(trimmed.split(/[?#]/)[0])
  } catch {
    return trimmed.split(/[?#]/)[0]
  }
}

async function validateImage(filename, label, errors) {
  if (!fs.existsSync(filename)) return
  if (fs.statSync(filename).size === 0) {
    errors.push(`${label}: empty image`)
    return
  }
  try {
    const metadata = await sharp(filename).metadata()
    if (!metadata.width || !metadata.height) errors.push(`${label}: image has no dimensions`)
  } catch (error) {
    errors.push(`${label}: unreadable image (${error.message})`)
  }
}

export async function auditSource(rootDirectory) {
  const root = fs.realpathSync(rootDirectory)
  const files = walk(root)
  const pages = files.filter((filename) => pagePattern.test(filename))
  const errors = []
  const targets = new Map()

  const register = (key, filename) => {
    const matches = targets.get(key) ?? []
    matches.push(filename)
    targets.set(key, matches)
  }
  for (const filename of files) {
    const relative = normalize(path.relative(root, filename))
    for (const key of [relative, path.basename(relative), relative.replace(/\.(?:md|qmd)$/, ""), path.basename(relative).replace(/\.(?:md|qmd)$/, "")]) {
      register(key, filename)
    }
  }

  const checkLocal = (page, raw, kind) => {
    const reference = localReference(raw)
    if (reference === null) {
      if (/^(?:https?:|\/\/)/i.test(raw.trim())) errors.push(`${normalize(path.relative(root, page))}: remote ${kind} must be stored in the vault: ${raw}`)
      return
    }
    const target = path.resolve(path.dirname(page), reference)
    if (!target.startsWith(root) || !fs.existsSync(target))
      errors.push(`${normalize(path.relative(root, page))}: missing ${kind} ${raw}`)
  }

  for (const page of pages) {
    const label = normalize(path.relative(root, page))
    const { frontmatter, body } = parsePage(page)
    for (const match of body.matchAll(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const raw = match[1].trim().replace(/\\$/, "")
      const keys = [raw, raw.replace(/\.(?:md|qmd)$/, ""), path.basename(raw)]
      const matches = [...new Set(keys.flatMap((key) => targets.get(key) ?? []))]
      if (matches.length === 0) errors.push(`${label}: missing embed [[${raw}]]`)
      if (matches.length > 1) errors.push(`${label}: ambiguous embed [[${raw}]]`)
    }
    for (const match of body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) checkLocal(page, match[1], "image")
    for (const match of body.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) checkLocal(page, match[1], "image")
    for (const field of ["photo", "image", "cover", "thumbnail", "hero"]) {
      if (typeof frontmatter[field] !== "string") continue
      const target = path.resolve(root, frontmatter[field])
      if (!target.startsWith(root) || !fs.existsSync(target)) errors.push(`${label}: missing ${field} ${frontmatter[field]}`)
    }
  }

  for (const image of files.filter((filename) => imagePattern.test(filename)))
    await validateImage(image, normalize(path.relative(root, image)), errors)

  return { errors, pages: pages.length, images: files.filter((filename) => imagePattern.test(filename)).length }
}

export async function auditOutput(rootDirectory) {
  const root = fs.realpathSync(rootDirectory)
  const files = walk(root, false)
  const errors = []
  const references = []
  for (const page of files.filter((filename) => filename.endsWith(".html"))) {
    const html = fs.readFileSync(page, "utf8")
    for (const match of html.matchAll(/\b(?:src|poster)=["']([^"']+)["']/gi)) references.push([page, match[1]])
    for (const match of html.matchAll(/\bsrcset=["']([^"']+)["']/gi))
      for (const candidate of match[1].split(",")) references.push([page, candidate.trim().split(/\s+/)[0]])
    for (const match of html.matchAll(/\bhref=["']([^"']+)["']/gi))
      if (mediaPattern.test(match[1].split(/[?#]/)[0])) references.push([page, match[1]])
  }
  for (const stylesheet of files.filter((filename) => filename.endsWith(".css"))) {
    const css = fs.readFileSync(stylesheet, "utf8")
    for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) references.push([stylesheet, match[1]])
  }

  for (const [owner, raw] of references) {
    const reference = localReference(raw)
    if (reference === null || !reference) continue
    const target = reference.startsWith("/") ? path.join(root, reference) : path.resolve(path.dirname(owner), reference)
    if (!target.startsWith(root) || !fs.existsSync(target))
      errors.push(`${normalize(path.relative(root, owner))}: emitted asset is missing: ${raw}`)
  }
  for (const image of files.filter((filename) => imagePattern.test(filename)))
    await validateImage(image, normalize(path.relative(root, image)), errors)

  return { errors, files: files.length, references: references.length }
}

async function main() {
  const [mode, directory] = process.argv.slice(2)
  if (!directory || !["source", "output"].includes(mode)) {
    console.error("usage: node tools/audit-assets.mjs source|output <directory>")
    process.exit(2)
  }
  const result = mode === "source" ? await auditSource(directory) : await auditOutput(directory)
  if (result.errors.length) {
    console.error(result.errors.join("\n"))
    process.exit(1)
  }
  console.log(`asset audit ok: ${JSON.stringify({ ...result, errors: undefined })}`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) await main()
