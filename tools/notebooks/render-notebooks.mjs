// The site's notebook step: every notebook in the content becomes a page, rendered from the
// outputs saved in it (nothing is evaluated), the way Quarto renders an .ipynb:
//   .qmd   tools/render-qmd.mjs (Quarto, freeze), unchanged
//   .ipynb Quarto, --no-execute
//   .nb    Wolfram: stage 1 render-nb.wls (needs wolframscript and a licensed Engine), then
//          stage 2 wolfram-pages.mjs
// The raw notebook stays downloadable next to its page. There is no per-folder or per-book
// configuration: a notebook's page is its path.
//
// In the build (tools/build-site.mjs runs it after render-qmd):
//   node tools/notebooks/render-notebooks.mjs
//     CONTENT_DIR          the staged content (set by build-site)
//     NOTEBOOK_ASSETS      where Wolfram page assets go (build-site serves them at /notebook-assets)
//     NOTEBOOK_RENDERS     a directory of stage-1 renders made earlier in the same deploy (CI's
//                          render job on the compute host). Unset: stage 1 runs here.
//     NOTEBOOK_CACHE       stage-1 cache (default ~/.cache/hafezi-notebooks); NOTEBOOK_FORCE=1
//                          renders every notebook from scratch
//     NOTEBOOK_FORK_PREFIX staged prefix of the private vault ("resources/"), for Open in Scratchpad
//     NOTEBOOK_REPORT      the JSON report (default .cache/notebook-report.json)
//     NOTEBOOK_CACHE_PRUNE=1 keep only the cache entries this run used (CI saves the cache whole)
//
// Stage 1 on its own (CI's render job, on a machine with the Engine):
//   node tools/notebooks/render-notebooks.mjs stage1 --root <content> [--root <content>...] --out <dir>
//     [--cache <dir>] [--force]
//     NOTEBOOK_LICENSE_WAIT    seconds to wait for a Wolfram license (default 1800), see runRenderer
//     WOLFRAM_LOCK             the lock Wolfram renders take turns on (/run/lock/hafezi-wolfram.lock),
//                              taken when it exists; WOLFRAM_LOCK_HELD=1: the caller holds it
import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "yaml"
import { blobSha } from "../docs-manifest.mjs"
import {
  documentHref,
  escapeHtml,
  fileSha,
  forkSource,
  writeWolframPages,
} from "./wolfram-pages.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const posix = (value) => value.split(path.sep).join("/")

export const walk = (directory) =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith(".") || entry.name === "node_modules") return []
        const file = path.join(directory, entry.name)
        return entry.isDirectory() ? walk(file) : [file]
      })
    : []

const which = (command) => {
  const found = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" })
  return found.status === 0 ? found.stdout.trim() : null
}

// ---------- stage 1: Wolfram notebooks to block JSON + raw assets ----------

// Every asset a render cites: {sha, ext} objects and {{asset:<sha>.<ext>}} tokens in HTML.
export function assetRefs(value, refs = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{asset:([0-9a-f]{64})\.(\w+)\}\}/g))
      refs.add(`${match[1]}.${match[2]}`)
  } else if (Array.isArray(value)) value.forEach((item) => assetRefs(item, refs))
  else if (value && typeof value === "object") {
    if (typeof value.sha === "string" && /^[0-9a-f]{64}$/.test(value.sha) && value.ext)
      refs.add(`${value.sha}.${value.ext}`)
    Object.values(value).forEach((item) => assetRefs(item, refs))
  }
  return refs
}

// render-nb.wls writes this first: a run that fails without it never started a kernel.
const KERNEL_STARTED = ".kernel-started"

/** Main Wolfram kernels running on this machine (pids): each holds a license. */
export function licenseHolders() {
  if (!fs.existsSync("/proc")) return []
  return fs
    .readdirSync("/proc")
    .filter((pid) => {
      if (!/^\d+$/.test(pid)) return false
      let argv
      try {
        argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
      } catch {
        return false // exited meanwhile
      }
      // Subkernels and the front end's player kernel (-pwfile …/playerpass) take no main license.
      return (
        path.basename(argv[0]) === "WolframKernel" &&
        !argv.includes("-subkernel") &&
        !argv.some((arg) => arg.endsWith("/playerpass"))
      )
    })
    .map(Number)
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Run render-nb.wls once it gets a license. When every license is in use (the Scratchpad's pool
// holds one on the compute host), wolframscript prints "…not activated or is experiencing a
// license-related problem" and exits 255 before the script runs a line, the same as when the
// Engine is not activated at all. So a 255 without the marker is retried while another kernel
// holds a license, backing off from NOTEBOOK_LICENSE_BACKOFF (15 s) to 2 minutes, for up to
// NOTEBOOK_LICENSE_WAIT seconds. Renders on this machine also take turns on WOLFRAM_LOCK, when the
// host has one, within the same wait.
function runRenderer(wolframscript, args, out, holders) {
  const lock = process.env.WOLFRAM_LOCK || "/run/lock/hafezi-wolfram.lock"
  const wait = Number(process.env.NOTEBOOK_LICENSE_WAIT ?? 1800)
  const deadline = Date.now() + wait * 1000
  const locked = !process.env.WOLFRAM_LOCK_HELD && fs.existsSync(lock) && which("flock")
  let delay = Number(process.env.NOTEBOOK_LICENSE_BACKOFF ?? 15) * 1000
  for (;;) {
    const left = String(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
    const run = locked
      ? spawnSync("flock", ["-w", left, "-E", "75", lock, wolframscript, ...args], {
          stdio: "inherit",
        })
      : spawnSync(wolframscript, args, { stdio: "inherit" })
    if (run.status === 0 || run.status === 1) return
    if (locked && run.status === 75)
      throw new Error(
        `render-notebooks: another Wolfram render held ${lock} for ${wait} s ` +
          "(NOTEBOOK_LICENSE_WAIT); gave up. Try again once it is done.",
      )
    if (run.status !== 255 || fs.existsSync(path.join(out, KERNEL_STARTED)))
      throw new Error(`render-notebooks: render-nb.wls exited with ${run.status ?? run.signal}`)
    const holding = holders()
    if (!holding.length)
      throw new Error(
        "render-notebooks: wolframscript was refused a Wolfram license while no other kernel " +
          "holds one: the activation itself is broken. Check the Engine's activation for this " +
          "user on this machine.",
      )
    if (Date.now() + delay > deadline)
      throw new Error(
        `render-notebooks: every Wolfram license stayed in use for ${wait} s ` +
          `(NOTEBOOK_LICENSE_WAIT; kernel pid ${holding.join(", ")}); gave up. Try again once ` +
          "one is free.",
      )
    console.error(
      `render-notebooks: every Wolfram license is in use (kernel pid ${holding.join(", ")}); ` +
        `trying again in ${delay / 1000} s`,
    )
    sleep(delay)
    delay = Math.min(delay * 2, 120_000)
  }
}

/**
 * Render every .nb under `root` into `out` (notebooks/<path>.json, assets/, symbols.json,
 * render.json). The output is self-contained, so another job can make pages from it.
 * `holders` lists the kernels holding a license (tests pass their own).
 */
export function stage1({ root, out, cache, force = false, jobs = 2, holders = licenseHolders }) {
  const wolframscript = process.env.WOLFRAMSCRIPT || which("wolframscript")
  if (!wolframscript)
    throw new Error(
      "render-notebooks: this content has Wolfram notebooks, and rendering them needs wolframscript " +
        "with a licensed Wolfram Engine (the compute host). Run the build there, or pass the renders " +
        "of this deploy in NOTEBOOK_RENDERS.",
    )
  // Start from an empty stage-1 dir: a render left by an earlier run (a moved or deleted notebook)
  // would be read with this run's and could stand in for it, since renders are matched by sha.
  for (const name of ["notebooks", "assets", "render.json", "symbols.json", KERNEL_STARTED])
    fs.rmSync(path.join(out, name), { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const args = ["-file", path.join(here, "render-nb.wls"), "--root", root, "--out", out]
  args.push("--cache", cache, "--jobs", String(jobs))
  if (force) args.push("--force")
  runRenderer(wolframscript, args, out, holders)
  const refs = new Set()
  for (const file of walk(path.join(out, "notebooks")).filter((f) => f.endsWith(".json")))
    assetRefs(JSON.parse(fs.readFileSync(file, "utf8")), refs)
  const assets = path.join(out, "assets")
  fs.mkdirSync(assets, { recursive: true })
  for (const name of refs) {
    const from = path.join(cache, "assets", name)
    if (!fs.existsSync(from))
      throw new Error(`render-notebooks: rendered asset missing from the cache: ${name}`)
    fs.copyFileSync(from, path.join(assets, name))
  }
  return JSON.parse(fs.readFileSync(path.join(out, "render.json"), "utf8"))
}

// Stage-1 directories under `dir` (itself, or its subdirectories holding a render.json).
export function renderDirsIn(dir) {
  if (fs.existsSync(path.join(dir, "render.json"))) return [dir]
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name))
        .filter((sub) => fs.existsSync(path.join(sub, "render.json")))
    : []
}

// ---------- .ipynb through Quarto ----------

const DROP_KEYS = [
  "format",
  "pdf-engine",
  "include-in-header",
  "output-file",
  "toc",
  "toc-depth",
  "number-sections",
  "jupyter",
]

/** Render one .ipynb from its saved outputs into <stem>.md (and <stem>_files/ for figures). */
// ---------- the .ipynb page cache ----------
// A page depends on the notebook's bytes, its path, Quarto's version, the Quarto project config
// in effect (the nearest _quarto.yml above it) and this file: all of them are in the key, so an
// unchanged notebook is never rendered twice and a changed one never comes from the cache.
// Pandoc reads a notebook's Markdown cells as Jupyter does (MathJax): $…$, $$…$$, \(…\), \[…\] and
// LaTeX math environments (jupyter-math.lua) are all math.
const JUPYTER_MATH = path.join(here, "jupyter-math.lua")
const SELF = crypto
  .createHash("sha256")
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .update(fs.readFileSync(JUPYTER_MATH))
  .digest("hex")
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex")
function quartoConfig(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const config = path.join(dir, "_quarto.yml")
    if (fs.existsSync(config)) return fs.readFileSync(config)
    if (path.dirname(dir) === dir) return ""
  }
}
const quartoVersions = new Map()
const quartoVersion = (quarto) => {
  if (!quartoVersions.has(quarto))
    quartoVersions.set(
      quarto,
      spawnSync(quarto, ["--version"], { encoding: "utf8" }).stdout?.trim() || "unknown",
    )
  return quartoVersions.get(quarto)
}

export function renderIpynb(
  file,
  contentDir,
  { quarto = "quarto", cache = null, forkPrefix = null } = {},
) {
  const rel = posix(path.relative(contentDir, file))
  const md = file.replace(/\.ipynb$/, ".md")
  if (fs.existsSync(md)) return { source: rel, conflict: posix(path.relative(contentDir, md)) }
  const sourceSha = fileSha(file)
  // The page links its raw notebook (documentHref, wolfram-pages.mjs) and, for a notebook of the
  // private vault, names it there for Open in Scratchpad (data-source, as Wolfram pages do).
  const fork = forkSource(rel, forkPrefix)
  const bar = `<p class="wl-source"${fork ? ` data-source="${escapeHtml(fork)}"` : ""}>Rendered from <a class="internal" href="${documentHref(rel)}">${path.basename(file)}</a></p>`
  let kernel = null
  try {
    kernel = JSON.parse(fs.readFileSync(file, "utf8")).metadata?.kernelspec?.name ?? null
  } catch {
    return { source: rel, error: "not valid notebook JSON" }
  }
  const figuresDir = md.replace(/\.md$/, "_files")
  const entry = cache
    ? path.join(
        cache,
        "ipynb",
        sha256(
          // The page starts with that line, made partly by wolfram-pages.mjs: that too.
          JSON.stringify([
            sourceSha,
            rel,
            bar,
            quartoVersion(quarto),
            sha256(quartoConfig(file)),
            SELF,
          ]),
        ),
      )
    : null
  const figureCount = () => (fs.existsSync(figuresDir) ? walk(figuresDir).length : 0)
  if (entry && fs.existsSync(path.join(entry, "page.md"))) {
    fs.copyFileSync(path.join(entry, "page.md"), md)
    if (fs.existsSync(path.join(entry, "files")))
      fs.cpSync(path.join(entry, "files"), figuresDir, { recursive: true })
    const page = posix(path.relative(contentDir, md))
    return {
      source: rel,
      page,
      source_sha: sourceSha,
      kernel,
      figures: figureCount(),
      cache: "hit",
      entry,
    }
  }
  const run = spawnSync(
    quarto,
    [
      "render",
      file,
      "--to",
      "gfm",
      "--no-execute",
      "-M",
      "from:markdown+tex_math_single_backslash",
      "--lua-filter",
      JUPYTER_MATH,
    ],
    {
      cwd: path.dirname(file),
      encoding: "utf8",
    },
  )
  if (run.status !== 0 || !fs.existsSync(md))
    return {
      source: rel,
      error: (run.stderr || run.stdout || "quarto failed").trim().split("\n").slice(-3).join(" "),
    }
  const text = fs.readFileSync(md, "utf8")
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  const fm = match ? (yaml.parse(match[1]) ?? {}) : {}
  let body = match ? text.slice(match[0].length) : text
  for (const key of DROP_KEYS) delete fm[key]
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  fm.title ??= heading ?? path.basename(file, ".ipynb")
  const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : []
  fm.tags = [...new Set(["internal", "notebook", "notebook/jupyter", ...tags])]
  fm.rendered_from = rel
  fm.notebook = { kind: "jupyter", source_sha: sourceSha, kernel }
  // A private vault notebook's own file, for the page's Edit (its cells, frontend/edit/) and
  // History tools (JqiFrame's [data-page-tools]).
  if (fork)
    Object.assign(fm, {
      edit_repo: "vault-private",
      edit_path: fork,
      edit_sha: blobSha(fs.readFileSync(file)),
      edit_mode: "notebook",
    })
  body = `${bar}\n\n${body.trimStart()}`
  fs.writeFileSync(md, "---\n" + yaml.stringify(fm).trimEnd() + "\n---\n\n" + body)
  if (entry) {
    // Written whole, then renamed into place: a half-written entry is never a hit.
    const tmp = `${entry}.tmp-${process.pid}`
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    fs.copyFileSync(md, path.join(tmp, "page.md"))
    if (fs.existsSync(figuresDir))
      fs.cpSync(figuresDir, path.join(tmp, "files"), { recursive: true })
    fs.rmSync(entry, { recursive: true, force: true })
    fs.renameSync(tmp, entry)
  }
  return {
    source: rel,
    page: posix(path.relative(contentDir, md)),
    source_sha: sourceSha,
    kernel,
    figures: figureCount(),
    cache: entry ? "miss" : null,
    entry,
  }
}

// ---------- the build step ----------

export async function renderContent({
  contentDir,
  assetsDir,
  renders = null,
  cache = path.join(os.homedir(), ".cache", "hafezi-notebooks"),
  force = false,
  forkPrefix = null,
  quarto = "quarto",
  prune = false,
}) {
  const files = walk(contentDir)
  const nbs = files.filter((file) => file.endsWith(".nb"))
  const ipynbs = files.filter((file) => file.endsWith(".ipynb"))
  const report = {
    generated_at: new Date().toISOString(),
    content: contentDir,
    wolfram: { notebooks: nbs.length, stage1: null, pages: [], missing: [], conflicts: [] },
    jupyter: { notebooks: ipynbs.length, pages: [], errors: [], conflicts: [] },
  }
  if (nbs.length) {
    let renderDirs
    if (renders) {
      renderDirs = renderDirsIn(renders)
      report.wolfram.stage1 = {
        from: renders,
        summaries: renderDirs.map((dir) =>
          JSON.parse(fs.readFileSync(path.join(dir, "render.json"), "utf8")),
        ),
      }
    } else {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-renders-"))
      const summary = stage1({ root: contentDir, out, cache, force })
      report.wolfram.stage1 = { from: "this build", summaries: [summary] }
      renderDirs = [out]
    }
    const result = await writeWolframPages({
      contentDir,
      renderDirs,
      assetsDir,
      cacheDir: cache,
      forkPrefix,
      prune,
    })
    Object.assign(report.wolfram, {
      pages: result.pages,
      missing: result.missing,
      conflicts: result.conflicts,
      assets: result.assets.size,
      asset_bytes: [...result.assets.values()].reduce((sum, asset) => sum + asset.size, 0),
      conversions: result.stats,
      failed_notebooks: report.wolfram.stage1.summaries.flatMap((summary) => summary.failed ?? []),
    })
  }
  for (const file of ipynbs) {
    const result = renderIpynb(file, contentDir, {
      quarto,
      cache: force ? null : cache,
      forkPrefix,
    })
    if (result.conflict) report.jupyter.conflicts.push(result)
    else if (result.error) report.jupyter.errors.push(result)
    else report.jupyter.pages.push(result)
  }
  // Pruning keeps the page cache to what this deploy used (CI restores and saves it whole).
  if (prune && cache && fs.existsSync(path.join(cache, "ipynb"))) {
    const used = new Set(report.jupyter.pages.map((page) => page.entry).filter(Boolean))
    for (const name of fs.readdirSync(path.join(cache, "ipynb")))
      if (!used.has(path.join(cache, "ipynb", name)))
        fs.rmSync(path.join(cache, "ipynb", name), { recursive: true, force: true })
  }
  for (const page of report.jupyter.pages) delete page.entry
  report.jupyter.cached = report.jupyter.pages.filter((page) => page.cache === "hit").length
  report.jupyter.rendered = report.jupyter.pages.length - report.jupyter.cached
  if (report.wolfram.stage1) {
    const summaries = report.wolfram.stage1.summaries
    report.wolfram.cached = summaries.reduce((n, x) => n + (x.notebook_cache_hits ?? 0), 0)
    report.wolfram.rendered =
      summaries.reduce((n, x) => n + (x.notebooks ?? 0), 0) - report.wolfram.cached
  }
  return report
}

export function problems(report) {
  const out = []
  for (const miss of report.wolfram.missing)
    out.push(`no render of ${miss.source} (sha256 ${miss.source_sha}) in this deploy`)
  for (const conflict of [...report.wolfram.conflicts, ...report.jupyter.conflicts])
    out.push(`${conflict.source}: a page ${conflict.page} already exists`)
  for (const failed of report.wolfram.failed_notebooks ?? [])
    out.push(`${failed}: cells failed to render`)
  for (const error of report.jupyter.errors) out.push(`${error.source}: ${error.error}`)
  return out
}

async function main(argv) {
  if (argv[0] === "stage1") {
    const roots = []
    let out = null
    let cache = process.env.NOTEBOOK_CACHE || path.join(os.homedir(), ".cache", "hafezi-notebooks")
    let force = process.env.NOTEBOOK_FORCE === "1"
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--root") roots.push(path.resolve(argv[++i]))
      else if (argv[i] === "--out") out = path.resolve(argv[++i])
      else if (argv[i] === "--cache") cache = path.resolve(argv[++i])
      else if (argv[i] === "--force") force = true
    }
    if (!roots.length || !out) {
      console.error(
        "usage: render-notebooks.mjs stage1 --root <content> [--root ...] --out <dir> [--cache dir] [--force]",
      )
      process.exit(2)
    }
    let failed = 0
    roots.forEach((root, index) => {
      const summary = stage1({ root, out: path.join(out, String(index)), cache, force })
      failed += summary.failed?.length ?? 0
    })
    process.exit(failed ? 1 : 0)
  }
  const contentDir = fs.realpathSync(process.env.CONTENT_DIR ?? "content")
  const assetsDir = process.env.NOTEBOOK_ASSETS ?? path.join(os.tmpdir(), "notebook-assets")
  const report = await renderContent({
    contentDir,
    assetsDir,
    renders: process.env.NOTEBOOK_RENDERS ? path.resolve(process.env.NOTEBOOK_RENDERS) : null,
    cache: process.env.NOTEBOOK_CACHE || undefined,
    force: process.env.NOTEBOOK_FORCE === "1",
    forkPrefix: process.env.NOTEBOOK_FORK_PREFIX || null,
    prune: process.env.NOTEBOOK_CACHE_PRUNE === "1",
  })
  const reportFile = process.env.NOTEBOOK_REPORT ?? path.join(".cache", "notebook-report.json")
  fs.mkdirSync(path.dirname(reportFile), { recursive: true })
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 1) + "\n")
  console.log(
    `render-notebooks: ${report.wolfram.pages.length}/${report.wolfram.notebooks} Wolfram and ` +
      `${report.jupyter.pages.length}/${report.jupyter.notebooks} Jupyter notebooks as pages; rendered now: ` +
      `${report.wolfram.rendered ?? 0} Wolfram, ${report.jupyter.rendered} Jupyter (the rest from the cache, ` +
      `keyed by content); report: ${reportFile}`,
  )
  const errors = problems(report)
  if (errors.length) {
    console.error(`render-notebooks: ${errors.length} problem(s):\n  ${errors.join("\n  ")}`)
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
