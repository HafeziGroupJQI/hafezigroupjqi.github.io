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
    const page = (slug, title, body, tags = []) => {
      fs.mkdirSync(path.dirname(path.join(prepared.output, slug)), { recursive: true })
      return fs.writeFileSync(
        path.join(prepared.output, slug + ".md"),
        `---\n${yaml.stringify({ title, site_public: true, site_internal: true, tags })}---\n\n${body}\n`,
      )
    }
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
        ["internal", "excalidraw"],
      )
    }
    const sections = [
      [
        "Journal Club",
        "journal-club",
        "Session write-ups, discussion notes, drawings, and papers.",
      ],
      ["Notes", "notes", "Meeting notes, planning documents, and handoffs."],
      ["Projects", "projects", "Project logs, plans, and recovered priorities."],
      ["Code", "code", "Runnable analyses and notes on the group's software repositories."],
      ["Drive", "drive", "The catalogue of the shared Google Drive and what was kept from it."],
      ...(drawings.length
        ? [["Drawings", "drawings", "Excalidraw sketches from sessions and notes."]]
        : []),
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
        page(`resources/${slug}/index`, title, links.join("\n") || "No resources added yet.", [
          "internal",
          slug,
        ])
      }
    }
    // Every topic tag used by private notes, grouped by its root, so members can browse
    // by function (code/simulation), tool, equipment, project, research area, or person.
    const topicLabels = {
      code: "Code",
      tool: "Tools",
      equipment: "Equipment",
      project: "Projects",
      research: "Research areas",
      people: "People",
      drive: "Drive folders",
      data: "Data",
      "journal-club": "Journal club",
      planning: "Planning",
      automation: "Automation",
    }
    const humanize = (value) =>
      value.replace(/-/g, " ").replace(/(^|\s)\w/g, (letter) => letter.toUpperCase())
    const counts = new Map()
    for (const file of walk(destination)) {
      if (!file.endsWith(".md") || file.endsWith(".excalidraw.md")) continue
      const match = fs.readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
      const tags = match ? (yaml.parse(match[1]) ?? {}).tags : []
      for (const tag of Array.isArray(tags) ? tags : [])
        if (tag !== "internal") counts.set(String(tag), (counts.get(String(tag)) ?? 0) + 1)
    }
    const roots = new Map()
    for (const tag of [...counts.keys()].sort()) {
      const root = tag.split("/")[0]
      if (!roots.has(root)) roots.set(root, [])
      roots.get(root).push(tag)
    }
    const topics = [...roots.entries()]
      .sort(([a], [b]) =>
        (topicLabels[a] ?? humanize(a)).localeCompare(topicLabels[b] ?? humanize(b)),
      )
      .map(([root, tags]) => {
        const items = tags.map((tag) => {
          const label = tag.includes("/")
            ? humanize(tag.slice(root.length + 1))
            : `All ${(topicLabels[root] ?? humanize(root)).toLowerCase()}`
          const n = counts.get(tag)
          return `<li><a class="internal" href="/tags/${tag}">${label}</a> · ${n} ${n === 1 ? "page" : "pages"}</li>`
        })
        return `## ${topicLabels[root] ?? humanize(root)}\n\n<ul class="topic-list">\n${items.join("\n")}\n</ul>`
      })
    page(
      "resources/topics/index",
      "Browse by topic",
      topics.length
        ? "Every private note is tagged by what it is about. Pick a topic to see all pages that share it.\n\n" +
            topics.join("\n\n")
        : "No topics yet.",
      ["internal"],
    )
    page(
      "resources/index",
      "Group resources",
      [
        "Working notes, code, project records, Drive catalogues, and session material for lab members. Members can also [[calendar|manage the group calendar]] and [[instruments|check the lab instruments]].",
        '<div class="feature-grid resource-grid">',
        ...sections.map(
          ([title, slug, description]) =>
            `<article class="feature-card"><a class="internal card-link" href="/resources/${slug}/"><h3>${title}</h3></a><p>${description}</p></article>`,
        ),
        '<article class="feature-card"><a class="internal card-link" href="/resources/topics/"><h3>Topics</h3></a><p>Browse every note by function, tool, equipment, project, research area, or person.</p></article>',
        "</div>",
      ].join("\n\n"),
      ["internal"],
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
