// Renders every .qmd under content/ to GitHub-flavored markdown with Quarto so
// Quartz can build it. Runs before `quartz build` (locally via `npm run prebuild:qmd`,
// in CI as a workflow step). The vault's _quarto.yml provides the format settings
// (gfm + yaml_metadata_block, freeze: auto), so the output keeps its frontmatter,
// turns Quarto callouts into Obsidian `> [!type]` callouts, and executes code cells
// only when the source changed.
//
// After rendering, the generated <stem>.md is post-processed:
//   - the `format:` key (PDF-only options) is removed,
//   - `title`/`tags` are guaranteed,
//   - any header-includes <script> tags (Plotly, htmlwidgets) are moved into the body.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "yaml"

const here = path.dirname(fileURLToPath(import.meta.url))
const contentDir = fs.realpathSync(path.resolve(here, "..", process.env.CONTENT_DIR ?? "content"))
const vaultRoot = path.dirname(contentDir) // _quarto.yml lives one level above content/

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])
const qmds = walk(contentDir).filter((f) => f.endsWith(".qmd"))
if (qmds.length === 0) {
  console.log("render-qmd: no .qmd files")
  process.exit(0)
}
if (!fs.existsSync(path.join(vaultRoot, "_quarto.yml"))) {
  console.error(`render-qmd: no _quarto.yml in ${vaultRoot}`)
  process.exit(1)
}

console.log(`render-qmd: rendering ${qmds.length} file(s) with quarto from ${vaultRoot}`)
execFileSync("quarto", ["render", "--to", "gfm"], { cwd: vaultRoot, stdio: "inherit" })

let ok = 0
for (const qmd of qmds) {
  const md = qmd.replace(/\.qmd$/, ".md")
  if (!fs.existsSync(md)) {
    console.error(`render-qmd: expected ${md} after render`)
    process.exit(1)
  }
  let text = fs.readFileSync(md, "utf8")
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  const fm = m ? (yaml.parse(m[1]) ?? {}) : {}
  let body = m ? text.slice(m[0].length) : text
  delete fm.format
  delete fm["pdf-engine"]
  delete fm["include-in-header"]
  delete fm["output-file"]
  delete fm.toc
  delete fm["toc-depth"]
  delete fm["number-sections"]
  delete fm.colorlinks
  if (!fm.title) fm.title = path.basename(md, ".md")
  if (!fm.tags) fm.tags = []
  if (fm.date instanceof Date) fm.date = fm.date.toISOString().slice(0, 10)
  if (typeof fm.date === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(fm.date)) fm.date = fm.date.slice(0, 10)
  // header-includes: hoist script tags into the body so raw-HTML widgets work
  const hi = fm["header-includes"]
  if (hi) {
    const scripts = (Array.isArray(hi) ? hi : [hi]).filter((s) => typeof s === "string" && /<script/i.test(s))
    if (scripts.length) body = scripts.join("\n") + "\n\n" + body
    delete fm["header-includes"]
  }
  fm.rendered_from = path.relative(contentDir, qmd).split(path.sep).join("/")
  fs.writeFileSync(md, "---\n" + yaml.stringify(fm).trimEnd() + "\n---\n\n" + body)
  ok++
}
console.log(`render-qmd: post-processed ${ok} file(s)`)
