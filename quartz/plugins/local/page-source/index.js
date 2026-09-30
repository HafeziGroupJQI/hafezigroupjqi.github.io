import fs from "node:fs"
import path from "node:path"

// Each page's Markdown source, written next to its HTML (<slug>.md beside <slug>.html), for the
// page's Export menu (frontend/page-export/). A source goes wherever its page goes: the public
// edition's to GitHub Pages (the public vault is public anyway), the member edition's into the
// Worker's assets, which only a signed-in member reaches (GET /api/site/*), so a members-only
// page's source is exactly as private as the page. Only pages Quartz publishes get one: drafts are
// filtered out before emitters run, and folder, tag and Bases pages have no Markdown source.
export const manifest = {
  name: "page-source",
  displayName: "Page source",
  description: "Writes each page's Markdown source next to its HTML",
  version: "1.0.0",
  category: "emitter",
}

// Front matter the build adds for itself (tools/prepare-site.mjs, tools/prepare-unified.mjs,
// tools/notebooks/), which no author writes and which means nothing outside this site: where the
// page is shown, and its own file in the vault. A long value may be folded onto indented lines.
const BUILD_KEYS =
  /^(?:site_public|site_internal|site_home|vault_source|edit_repo|edit_path|edit_sha|edit_mode|edit_note):.*\r?\n(?:[ \t]+.*\r?\n)*/gm

/** The source as it goes out: the staged page, without the build's own front matter keys. */
export function pageSource(text) {
  const front = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)
  if (!front) return text
  return front[0].replace(BUILD_KEYS, "") + text.slice(front[0].length)
}

/** Where a page's source goes in the output: beside its HTML, or nowhere without a Markdown file. */
export function sourcePath(output, data) {
  const { filePath, slug } = data ?? {}
  if (!slug || typeof filePath !== "string" || !filePath.endsWith(".md")) return null
  return path.join(output, slug + ".md")
}

export default () => ({
  name: "PageSource",
  async *emit(ctx, content) {
    for (const [, file] of content) {
      const destination = sourcePath(ctx.argv.output, file.data)
      if (!destination) continue
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      const text = await fs.promises.readFile(file.data.filePath, "utf8")
      await fs.promises.writeFile(destination, pageSource(text))
      yield destination
    }
  },
})
