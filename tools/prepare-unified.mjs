import fs from "node:fs"
import path from "node:path"
import { prepareSite } from "./prepare-site.mjs"

const excluded = new Set([
  "node_modules",
  "schema",
  "tools",
  "README.md",
  "package.json",
  "package-lock.json",
  "requirements.txt",
  "_quarto.yml",
  "_freeze",
])
const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    )

// Private sources have their own namespace. Resolve their links before combining the vaults.
export function privateLink(raw, filename, privateRoot) {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(raw)) return raw
  const [target, ...suffix] = raw.split(/(?=[#?])/)
  if (!target || target.startsWith("/resources/")) return raw
  const clean = target.replace(/^\//, "")
  const exists = (file) => [file, file + ".md", file + ".qmd", file + ".base"].some(fs.existsSync)
  const local = path.resolve(path.dirname(filename), clean)
  const rooted = path.resolve(privateRoot, clean)
  const resolved = target.startsWith("/") ? rooted : exists(local) ? local : rooted
  if (!resolved.startsWith(privateRoot + path.sep) && resolved !== privateRoot) return raw
  if (!exists(resolved)) return raw
  return (
    "/resources/" +
    path
      .relative(privateRoot, resolved)
      .split(path.sep)
      .join("/")
      .replace(/\.qmd$/, ".md") +
    suffix.join("")
  )
}

export function prepareUnified(publicSource, privateSource, yaml) {
  const prepared = prepareSite(publicSource, yaml)
  try {
    const root = fs.realpathSync(privateSource)
    const destination = path.join(prepared.output, "resources")
    for (const reserved of ["resources", "calendar", "instruments"]) {
      if (
        [reserved, reserved + ".md", reserved + ".qmd"].some((name) =>
          fs.existsSync(path.join(prepared.output, name)),
        )
      )
        throw new Error(`Reserved member route collides with public content: ${reserved}`)
    }
    fs.cpSync(root, destination, {
      recursive: true,
      filter: (filename) =>
        filename === root ||
        (!path.basename(filename).startsWith(".") && !excluded.has(path.basename(filename))),
    })
    for (const filename of walk(destination)) {
      if (filename.endsWith(".qmd")) {
        fs.rmSync(filename)
        continue
      }
      if (!/\.(md|base)$/.test(filename)) continue
      const sourceFile = path.join(root, path.relative(destination, filename))
      let text = fs.readFileSync(filename, "utf8")
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
      if (match) {
        const fm = yaml.parse(match[1]) ?? {}
        fm.site_public = true
        fm.site_internal = true
        if (filename.endsWith(".excalidraw.md")) fm.tags = []
        // Aliases must never override public routes.
        if (fm.aliases)
          fm.aliases = (Array.isArray(fm.aliases) ? fm.aliases : [fm.aliases]).map(
            (alias) =>
              "resources/" +
              String(alias)
                .replace(/^\/?resources\//, "")
                .replace(/^\//, ""),
          )
        for (const key of ["photo", "image", "manual"])
          if (typeof fm[key] === "string") fm[key] = privateLink(fm[key], sourceFile, root)
        text = `---\n${yaml.stringify(fm)}---\n` + text.slice(match[0].length)
      }
      text = text
        .replace(
          /\[\[([^\]|]+)(\|[^\]]*)?\]\]/g,
          (_, target, label = "") =>
            `[[${privateLink(target, sourceFile, root).replace(/^\//, "")}${label}]]`,
        )
        .replace(
          /\]\(([^\s)]+)([^)]*)\)/g,
          (_, target, title) => `](${privateLink(target, sourceFile, root)}${title})`,
        )
        .replace(
          /((?:href|src)=")[^"\n]+"/g,
          (value, prefix) =>
            prefix + privateLink(value.slice(prefix.length, -1), sourceFile, root) + '"',
        )
      // Root-relative Markdown/HTML media resolve to the staged content root in the asset audit.
      fs.writeFileSync(filename, text)
    }
    const page = (slug, title, body, tags = []) =>
      fs.writeFileSync(
        path.join(prepared.output, slug + ".md"),
        `---\n${yaml.stringify({ title, site_public: true, site_internal: true, tags })}---\n\n${body}\n`,
      )
    const drawings = walk(destination).filter((file) => file.endsWith(".excalidraw.md"))
    if (drawings.length) {
      fs.mkdirSync(path.join(destination, "drawings"), { recursive: true })
      page(
        "resources/drawings/index",
        "Lab drawings",
        drawings
          .map((file) => {
            const slug = path.relative(prepared.output, file).replace(/\.md$/, "")
            const title = path
              .basename(file)
              .replace(/\.excalidraw\.md$/, "")
              .replace(/-/g, " ")
            return `- [${title}](/${slug})`
          })
          .join("\n"),
        ["excalidraw"],
      )
    }
    const sections = [
      ["Journal Club", "journal-club"],
      ["Notes", "notes"],
      ["Projects", "projects"],
      ["Code", "code"],
      ["Drive", "drive"],
      ...(drawings.length ? [["Drawings", "drawings"]] : []),
    ]
    fs.mkdirSync(destination, { recursive: true })
    for (const [title, slug] of sections) {
      const directory = path.join(destination, slug)
      fs.mkdirSync(directory, { recursive: true })
      if (!fs.existsSync(path.join(directory, "index.md"))) {
        const links = walk(directory)
          .filter((file) => /\.(md|qmd)$/.test(file))
          .map((file) => {
            const relative = path.relative(prepared.output, file).replace(/\.(md|qmd)$/, "")
            return `- [[${relative}|${path.basename(file).replace(/\.(md|qmd)$/, "")}]]`
          })
        page(`resources/${slug}/index`, title, links.join("\n") || "No resources added yet.")
      }
    }
    page(
      "resources/index",
      "Group resources",
      sections.map(([title, slug]) => `- [[resources/${slug}/index|${title}]]`).join("\n"),
    )
    page(
      "calendar",
      "Group calendar",
      '<div class="member-tools" data-calendar><p>Loading calendar…</p></div>',
    )
    page(
      "instruments",
      "Lab instruments",
      '<div class="member-tools" data-instruments><p>Loading instruments…</p></div>',
    )
    return prepared
  } catch (error) {
    fs.rmSync(prepared.stage, { recursive: true, force: true })
    throw error
  }
}
