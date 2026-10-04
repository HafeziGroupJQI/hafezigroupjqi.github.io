import fs from "node:fs"
import path from "node:path"

const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))

// The note a tag names, if any: people/lida-xu is the person record, project/topo-automation
// the private project note (the one note whose name starts with the tag), library the private
// library index. Public records win over private notes that share a name.
export function tagTarget(tag, slugs) {
  const exists = (slug) => slugs.has(slug)
  const [root, ...rest] = tag.split("/")
  const leaf = rest.join("/")
  const roots = [root, root + "s"]
  const bases = leaf
    ? [...roots.map((r) => `${r}/${leaf}`), ...roots.map((r) => `resources/${r}/${leaf}`)]
    : [...roots.map((r) => `resources/${r}`), ...roots]
  for (const base of bases)
    for (const slug of [base, base + "/index"]) if (exists(slug)) return slug
  if (!leaf) return undefined
  for (const base of bases) {
    const matches = [...slugs].filter(
      (slug) => slug.startsWith(base + "-") && !slug.includes("/", base.length),
    )
    if (matches.length === 1) return matches[0]
  }
  return undefined
}

// Tag pages are only listings, so nothing links a tag to the note it is about. Give every tag that
// names a note a page body linking to it: the tag page shows it first, the note lists the tag page
// among its backlinks, and the graph connects the two.
export function writeTagPages(output, yaml) {
  const frontmatter = (text) => {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
    return match ? (yaml.parse(match[1]) ?? {}) : {}
  }
  const titles = new Map()
  const tags = new Set()
  for (const file of walk(output)) {
    if (!file.endsWith(".md")) continue
    const slug = path.relative(output, file).split(path.sep).join("/").replace(/\.md$/, "")
    if (slug.startsWith("tags/")) continue
    const fm = frontmatter(fs.readFileSync(file, "utf8"))
    // A restricted page (an access rule's, tools/acl/) neither names a tag nor is one's note.
    if (fm.acl) continue
    titles.set(slug, String(fm.title ?? path.basename(slug)))
    for (const tag of Array.isArray(fm.tags) ? fm.tags : []) {
      const parts = String(tag).split("/")
      parts.forEach((_, index) => tags.add(parts.slice(0, index + 1).join("/")))
    }
  }
  const slugs = new Set(titles.keys())
  let written = 0
  for (const tag of tags) {
    if (tag === "internal" || !/^[a-z0-9][a-z0-9/_-]*$/.test(tag)) continue
    const target = tagTarget(tag, slugs)
    if (!target) continue
    const file = path.join(output, "tags", tag + ".md")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      `---\n${yaml.stringify({ title: tag, site_public: true, tags: [] })}---\n\nAbout [[${target}|${titles.get(target).replace(/[[\]|]/g, "")}]].\n`,
    )
    written++
  }
  return written
}
