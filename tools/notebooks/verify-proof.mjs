// Checks a notebook proof run (tools/notebooks/prove.sh) against what was actually committed and
// actually built, and writes proof-report.json and PROOF.md into the work directory.
//
//   node tools/notebooks/verify-proof.mjs --work <dir> --site <built member site>
//
// Expectations come from git (the notebooks committed in the vault snapshots), not from the
// renderer's own report; the built site is read as it would be served.
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { slugifyFilePath } from "@quartz-community/utils"
import { excluded } from "../prepare-unified.mjs"
import { problems, renderContent } from "./render-notebooks.mjs"
import { writeWolframPages } from "./wolfram-pages.mjs"

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, arg, i, all) =>
        arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs,
      [],
    ),
)
const work = path.resolve(args.work)
const site = path.resolve(args.site)
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex")
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const walk = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : []

const checks = []
const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail })

// ---------- what was committed ----------
const snapshots = readJson(path.join(work, "snapshots.json"))
const committed = (repo, prefix, stagedPrefix) =>
  execFileSync(
    "git",
    ["-C", path.join(work, "src", repo), "ls-files", "-z", "--", "*.nb", "*.ipynb"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .filter(
      (file) =>
        !excluded.has(file.split("/")[0]) && !file.split("/").some((part) => part.startsWith(".")),
    )
    .map((file) => stagedPrefix + file)
const expected = [
  ...committed("vault", "content/", ""),
  ...committed("vault-private", "", "resources/"),
]
const expectedNb = expected.filter((f) => f.endsWith(".nb")).sort()
const expectedIpynb = expected.filter((f) => f.endsWith(".ipynb")).sort()

// ---------- stage 1: two independent renders from empty caches ----------
const stageDirs = (name) =>
  fs
    .readdirSync(path.join(work, name))
    .map((d) => path.join(work, name, d))
    .filter((d) => fs.existsSync(path.join(d, "render.json")))
const summaries = (name) => stageDirs(name).map((d) => readJson(path.join(d, "render.json")))
for (const run of ["renders-a", "renders-b"]) {
  const s = summaries(run)
  const notebooks = s.reduce((n, x) => n + x.notebooks, 0)
  check(
    `${run}: rendered every committed Wolfram notebook`,
    notebooks === expectedNb.length,
    `${notebooks} rendered, ${expectedNb.length} committed`,
  )
  check(
    `${run}: no notebook or cell failed`,
    s.every((x) => (x.failed ?? []).length === 0),
    s.flatMap((x) => x.failed ?? []).join(", "),
  )
  check(
    `${run}: started from an empty cache (0 cache hits)`,
    s.every((x) => x.notebook_cache_hits === 0),
    s.map((x) => x.notebook_cache_hits).join("+"),
  )
}

// Determinism: the same notebooks rendered twice, from scratch, by separate runs.
const normalize = (json) => {
  const { stats, ...rest } = json
  return JSON.stringify(rest)
}
const indexRuns = (name) => {
  const map = new Map()
  for (const dir of stageDirs(name))
    for (const file of walk(path.join(dir, "notebooks")).filter((f) => f.endsWith(".json"))) {
      const json = readJson(file)
      map.set(json.source_sha, { json, dir })
    }
  return map
}
const runA = indexRuns("renders-a")
const runB = indexRuns("renders-b")
const differing = []
for (const [key, a] of runA) {
  const b = runB.get(key)
  if (!b || normalize(a.json) !== normalize(b.json)) differing.push(a.json.title ?? key)
}
const assetBytes = (name) => {
  const out = new Map()
  for (const dir of stageDirs(name))
    for (const file of walk(path.join(dir, "assets")))
      out.set(path.basename(file), sha256(fs.readFileSync(file)))
  return out
}
const assetsA = assetBytes("renders-a")
const assetsB = assetBytes("renders-b")
check(
  "the two from-scratch renders are identical (blocks and every asset byte)",
  differing.length === 0 &&
    assetsA.size === assetsB.size &&
    [...assetsA].every(([k, v]) => assetsB.get(k) === v),
  differing.length
    ? `${differing.length} notebooks differ: ${differing.slice(0, 5).join("; ")}`
    : `${runA.size} notebooks, ${assetsA.size} assets`,
)

// The pages themselves: stage 2 from each run's renders, into its own scratch tree, compared
// byte for byte (what members are served, not just the intermediate render).
const sourceOf = (staged) =>
  staged.startsWith("resources/")
    ? path.join(work, "src", "vault-private", staged.slice("resources/".length))
    : path.join(work, "src", "vault", "content", staged)
const pagesFrom = async (run) => {
  const root = path.join(work, `pages-${run}`)
  fs.rmSync(root, { recursive: true, force: true })
  for (const staged of expectedNb) {
    fs.mkdirSync(path.dirname(path.join(root, "content", staged)), { recursive: true })
    fs.linkSync(sourceOf(staged), path.join(root, "content", staged))
  }
  await writeWolframPages({
    contentDir: path.join(root, "content"),
    renderDirs: stageDirs(`renders-${run}`),
    assetsDir: path.join(root, "assets"),
    cacheDir: path.join(root, "cache"),
    forkPrefix: "resources/",
  })
  const files = new Map()
  for (const file of [
    ...walk(path.join(root, "content")).filter((f) => f.endsWith(".md")),
    ...walk(path.join(root, "assets")),
  ])
    files.set(path.relative(root, file), sha256(fs.readFileSync(file)))
  return files
}
const pagesA = await pagesFrom("a")
const pagesB = await pagesFrom("b")
const pageDiffs = [...new Set([...pagesA.keys(), ...pagesB.keys()])].filter(
  (k) => pagesA.get(k) !== pagesB.get(k),
)
check(
  "pages and assets built from the two renders are byte-identical",
  pageDiffs.length === 0 && pagesA.size > 0,
  pageDiffs.length
    ? `${pageDiffs.length} files differ: ${pageDiffs.slice(0, 5).join(", ")}`
    : `${pagesA.size} files`,
)

// ---------- stage 2 and the build ----------
const report = readJson(path.join(work, "notebook-report.json"))
check(
  "the build rendered its notebooks from this deploy's renders",
  report.wolfram.stage1?.from && report.wolfram.stage1.from !== "this build",
  report.wolfram.stage1?.from,
)
check(
  "every committed Wolfram notebook became a page",
  report.wolfram.pages.length === expectedNb.length && report.wolfram.missing.length === 0,
  `${report.wolfram.pages.length} pages, ${expectedNb.length} committed, ${report.wolfram.missing.length} missing`,
)
check(
  "every committed Jupyter notebook became a page",
  report.jupyter.pages.length === expectedIpynb.length && report.jupyter.errors.length === 0,
  `${report.jupyter.pages.length} pages, ${expectedIpynb.length} committed, ${report.jupyter.errors.map((e) => e.source).join(", ")}`,
)
check(
  "no notebook collided with a hand-written page",
  report.wolfram.conflicts.length + report.jupyter.conflicts.length === 0,
)
const pageSources = new Set([...report.wolfram.pages, ...report.jupyter.pages].map((p) => p.source))
const unpaged = expected.filter((f) => !pageSources.has(f))
check(
  "the rendered set is exactly the committed set",
  unpaged.length === 0,
  unpaged.slice(0, 5).join(", "),
)

// The built site: each page's HTML, and everything it links to.
const manifest = readJson(
  path.join(work, "src", "website", "worker", "generated", "docs-manifest.json"),
)
const documents = new Set(Object.keys(manifest.documents ?? manifest))
const htmlOf = (page) => path.join(site, slugifyFilePath(page) + ".html")
const brokenAssets = []
const brokenLinks = []
const missingHtml = []
let assetRefs = 0
for (const page of [...report.wolfram.pages, ...report.jupyter.pages]) {
  const file = htmlOf(page.page)
  if (!fs.existsSync(file)) {
    missingHtml.push(page.page)
    continue
  }
  const html = fs.readFileSync(file, "utf8")
  const dir = path.posix.dirname(slugifyFilePath(page.page))
  for (const [, src] of html.matchAll(
    /(?:src|data-sprite|data-symbols)="(\/notebook-assets\/[^"]+)"/g,
  )) {
    assetRefs++
    if (!fs.existsSync(path.join(site, src))) brokenAssets.push(`${page.page}: ${src}`)
  }
  for (const [, src] of html.matchAll(/<img[^>]+src="([^"/][^":]*)"/g)) {
    assetRefs++
    const target = path.posix.normalize(path.posix.join(dir, decodeURIComponent(src)))
    if (!fs.existsSync(path.join(site, target))) brokenAssets.push(`${page.page}: ${src}`)
  }
  // Links in the notebook body (the page chrome is Quartz's): pages and documents must exist.
  const body = html.slice(
    html.indexOf("wl-notebook") > 0 ? html.indexOf("wl-notebook") : html.indexOf("wl-source"),
  )
  for (const [, href] of body.matchAll(/<a[^>]+class="internal[^"]*"[^>]+href="([^"#?]+)/g)) {
    if (/^(https?:)?\/\//.test(href)) continue
    const target = href.startsWith("/")
      ? href.slice(1)
      : path.posix.normalize(path.posix.join(dir, decodeURIComponent(href)))
    const clean = target.replace(/\/$/, "")
    const exists =
      fs.existsSync(path.join(site, clean + ".html")) ||
      fs.existsSync(path.join(site, clean, "index.html")) ||
      documents.has(clean) ||
      fs.existsSync(path.join(site, clean))
    if (!exists) brokenLinks.push(`${page.page}: ${href}`)
  }
}
check(
  "every notebook page is in the built site",
  missingHtml.length === 0,
  missingHtml.slice(0, 5).join(", "),
)
check(
  "every figure, sound and sprite a page cites is in the built site",
  brokenAssets.length === 0,
  brokenAssets.length ? brokenAssets.slice(0, 5).join(", ") : `${assetRefs} references`,
)
check(
  "every internal link on a notebook page resolves (pages and notebook downloads)",
  brokenLinks.length === 0,
  brokenLinks.slice(0, 8).join(", "),
)

// The notebook written by prove.sh, which has nothing to do with any book.
const generality = report.wolfram.pages.find((p) =>
  p.source.endsWith("proof/ring-resonator-notes.nb"),
)
if (generality) {
  const html = fs.existsSync(htmlOf(generality.page))
    ? fs.readFileSync(htmlOf(generality.page), "utf8")
    : ""
  const kinds = {
    title: html.includes("Ring resonator notes"),
    runnable_cells: (html.match(/<figure class="wl-cell"/g) ?? []).length >= 5,
    text_output: html.includes("wl-text"),
    table: html.includes("wl-grid"),
    figures: (html.match(/src="(?:\/|(?:\.\.\/)+)notebook-assets\//g) ?? []).length >= 2,
    manipulate_sprite: /class="wl-manipulate" data-sprite="\/notebook-assets\//.test(html),
    sibling_link: /href="[^"]*proof\/notes"/.test(html),
    missing_link_is_text: html.includes("a notebook that isn") && !/href="[^"]*missing/.test(html),
  }
  check(
    "a notebook made from scratch renders every output kind",
    Object.values(kinds).every(Boolean),
    JSON.stringify(kinds),
  )
} else check("a notebook made from scratch renders every output kind", false, "its page is missing")

// ---------- the warm deploy: one notebook of each kind changed ----------
// Stage 1 ran again with run a's cache; the page step runs here with the page cache the real
// build left (cache-post), on the changed vault. Only the two changed notebooks may re-render,
// and every other Wolfram page must come out byte-identical to the cold deploy's.
const changed = readJson(path.join(work, "warm-changed.json"))
const warmSummaries = summaries("renders-warm")
const warmMisses = warmSummaries.flatMap((x) =>
  x.results.filter((r) => r.cache === "miss").map((r) => r.source),
)
const warmHits = warmSummaries.reduce((n, x) => n + x.notebook_cache_hits, 0)
check(
  "warm deploy: stage 1 re-rendered only the changed Wolfram notebook",
  warmMisses.length === 1 && changed.wolfram.endsWith(warmMisses[0]),
  `re-rendered: ${warmMisses.join(", ") || "none"}; from cache: ${warmHits}`,
)
const warmExpected = [
  ...committed("vault", "content/", ""),
  ...committed("vault-private-warm", "", "resources/"),
]
const warmRoot = path.join(work, "warm")
fs.rmSync(warmRoot, { recursive: true, force: true })
for (const staged of warmExpected) {
  const from = staged.startsWith("resources/")
    ? path.join(work, "src", "vault-private-warm", staged.slice("resources/".length))
    : path.join(work, "src", "vault", "content", staged)
  fs.mkdirSync(path.dirname(path.join(warmRoot, "content", staged)), { recursive: true })
  fs.linkSync(from, path.join(warmRoot, "content", staged))
}
// As prepare-site stages it: the vault's Quarto config one level above content/ (part of an
// .ipynb page's cache key, since it sets the page format).
fs.copyFileSync(path.join(work, "src", "vault", "_quarto.yml"), path.join(warmRoot, "_quarto.yml"))
const warmStart = Date.now()
const warm = await renderContent({
  contentDir: path.join(warmRoot, "content"),
  assetsDir: path.join(warmRoot, "assets"),
  renders: path.join(work, "renders-warm"),
  cache: path.join(work, "cache-post"),
  forkPrefix: "resources/",
})
const warmSeconds = Math.round((Date.now() - warmStart) / 100) / 10
const jupyterRendered = warm.jupyter.pages.filter((p) => p.cache === "miss").map((p) => p.source)
check(
  "warm deploy: the page step has no problems",
  problems(warm).length === 0,
  problems(warm).slice(0, 3).join("; "),
)
check(
  "warm deploy: only the changed Jupyter notebook re-rendered",
  jupyterRendered.length === 1 && jupyterRendered[0] === changed.jupyter,
  `re-rendered: ${jupyterRendered.join(", ") || "none"}; from cache: ${warm.jupyter.cached}`,
)
const changedPage = "content/" + changed.wolfram.replace(/\.nb$/, ".md")
const drift = []
let same = 0
for (const [file, digest] of pagesA) {
  if (!file.endsWith(".md") || file === changedPage) continue
  const warmFile = path.join(warmRoot, file)
  if (!fs.existsSync(warmFile) || sha256(fs.readFileSync(warmFile)) !== digest) drift.push(file)
  else same++
}
const changedPageDiffers =
  fs.existsSync(path.join(warmRoot, changedPage)) &&
  sha256(fs.readFileSync(path.join(warmRoot, changedPage))) !== pagesA.get(changedPage)
check(
  "warm deploy: every unchanged Wolfram page is byte-identical to the cold deploy's; the changed one is new",
  drift.length === 0 && changedPageDiffers,
  drift.length
    ? `${drift.length} drifted: ${drift.slice(0, 3).join(", ")}`
    : `${same} unchanged pages identical`,
)
const warmStats = {
  stage1_seconds: readJson(path.join(work, "timings.json")).stage1_warm,
  pages_seconds: warmSeconds,
  wolfram_rendered: warmMisses.length,
  wolfram_from_cache: warmHits,
  jupyter_rendered: jupyterRendered.length,
  jupyter_from_cache: warm.jupyter.cached,
  conversions: warm.wolfram.conversions,
}

// ---------- evidence ----------
const assetsDir = path.join(site, "notebook-assets")
const siteAssets = walk(assetsDir)
const lines = siteAssets
  .map((f) => `${sha256(fs.readFileSync(f))}  ${path.relative(site, f)}`)
  .sort()
fs.writeFileSync(path.join(work, "notebook-assets.sha256"), lines.join("\n") + "\n")
const versions = readJson(path.join(work, "versions.json"))
const passed = checks.every((c) => c.ok)
const result = {
  passed,
  finished_at: new Date().toISOString(),
  snapshots,
  versions,
  committed: { wolfram: expectedNb.length, jupyter: expectedIpynb.length },
  pages: { wolfram: report.wolfram.pages.length, jupyter: report.jupyter.pages.length },
  assets: {
    files: siteAssets.length,
    bytes: siteAssets.reduce((n, f) => n + fs.statSync(f).size, 0),
    manifest_sha256: sha256(lines.join("\n")),
  },
  timings: readJson(path.join(work, "timings.json")),
  warm: warmStats,
  checks,
}
fs.writeFileSync(path.join(work, "proof-report.json"), JSON.stringify(result, null, 1) + "\n")
const md = [
  `# Notebook pages proof: ${passed ? "PASSED" : "FAILED"}`,
  "",
  `Run finished ${result.finished_at}. Sources (each a clean snapshot; "dirty" means uncommitted changes were committed into the snapshot):`,
  "",
  ...Object.entries(snapshots).map(
    ([name, s]) => `- **${name}**: ${s.head}${s.dirty ? ` + local changes → ${s.snapshot}` : ""}`,
  ),
  "",
  `Versions: ${Object.entries(versions)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}`,
  "",
  `Committed notebooks: ${expectedNb.length} Wolfram, ${expectedIpynb.length} Jupyter. Pages built: ${result.pages.wolfram} + ${result.pages.jupyter}. ` +
    `Wolfram page assets: ${siteAssets.length} files, ${(result.assets.bytes / 1048576).toFixed(1)} MiB (sha256 list: notebook-assets.sha256, digest ${result.assets.manifest_sha256.slice(0, 16)}).`,
  "",
  `Timings (s): ${Object.entries(result.timings)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}`,
  "",
  `Warm deploy (one Wolfram and one Jupyter notebook changed): stage 1 ${warmStats.stage1_seconds} s ` +
    `(${warmStats.wolfram_rendered} rendered, ${warmStats.wolfram_from_cache} from cache); page step ` +
    `${warmStats.pages_seconds} s (${warmStats.jupyter_rendered} .ipynb rendered, ${warmStats.jupyter_from_cache} ` +
    `from cache; ${warmStats.conversions?.converted ?? 0} image conversions, ${warmStats.conversions?.reused ?? 0} reused).`,
  "",
  "| check | result | detail |",
  "|---|---|---|",
  ...checks.map(
    (c) =>
      `| ${c.name} | ${c.ok ? "ok" : "**FAIL**"} | ${String(c.detail).replace(/\|/g, "\\|").slice(0, 200)} |`,
  ),
  "",
].join("\n")
fs.writeFileSync(path.join(work, "PROOF.md"), md)
console.log(md)
process.exit(passed ? 0 : 1)
