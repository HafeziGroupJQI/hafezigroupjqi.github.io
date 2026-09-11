// Removes the markdown twins and figure directories that tools/render-qmd.mjs
// generated next to .qmd sources, so a local content symlink into the vault
// stays clean. Only files carrying the `rendered_from:` marker are removed.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const contentDir = fs.realpathSync(path.resolve(here, "..", process.env.CONTENT_DIR ?? "content"))
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])
let n = 0
for (const qmd of walk(contentDir).filter((f) => f.endsWith(".qmd"))) {
  const md = qmd.replace(/\.qmd$/, ".md")
  if (fs.existsSync(md) && /^rendered_from:/m.test(fs.readFileSync(md, "utf8").slice(0, 2000))) {
    fs.rmSync(md); n++
  }
  const files = qmd.replace(/\.qmd$/, "_files")
  if (fs.existsSync(files)) { fs.rmSync(files, { recursive: true }); n++ }
}
console.log(`clean-qmd: removed ${n} generated item(s)`)
