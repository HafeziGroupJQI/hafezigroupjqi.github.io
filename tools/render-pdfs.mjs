import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

// Every page with an Export menu, printed to <output>/pdf/<slug>.pdf in headless Chromium
// (playwright-core, as tools/render-excalidraw.mjs uses it): the built page itself, in the site's
// print stylesheet (quartz/styles/print.scss) after its own print steps (window.hafeziPrint,
// frontend/page-export/print.js). The Export menu's PDF download and Save PDF to Google Drive both
// send this file, so the two are the same bytes.
//
// Pages are served from the output directory at the site's origin, so the PDF's links are the real
// addresses. Other requests go only to the font and script CDNs the pages use, answered from
// memory after the first time; everything else is blocked, as are the scripts that call the
// members API. A page's PDF is cached by what it is printed from (~/.cache/hafezi-pdfs/<edition>/),
// so a deploy prints only the pages that changed.
//
// Environment:
//   PDF_RENDER=0            skip printing (local builds)
//   PDF_CACHE=<dir>         the cache (default ~/.cache/hafezi-pdfs)
//   PDF_CACHE_SCOPE=article key pages on their article, pictures and print code only, so a change
//                           to the site's stylesheet or scripts alone reprints nothing
//   PDF_CACHE_PRUNE=0       keep cache entries this run didn't use (by default they go)
//   PDF_JOBS=<n>            pages printed at once (default: 4, or fewer cores)
//   PDF_REPORT=<file>       the JSON report (default .cache/pdf-report.json)

export const PDF_DIRECTORY = "pdf"
export const DEFAULT_ORIGIN = "https://hafezigroupjqi.github.io"
/** The column's width in CSS px on Letter inside print.scss's margins (print.js PAPER_WIDTH). */
export const LETTER_WIDTH = 688
export const PDF_OPTIONS = {
  format: "Letter",
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: false,
  outline: true,
  tagged: true,
}
/** The CDNs pages load fonts, KaTeX's stylesheet and Mermaid from, and YouTube's thumbnails. */
export const ALLOWED_HOSTS = new Set([
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "i.ytimg.com",
])
// The member tools call the members API, and the service worker and Hafezi GPT are no part of a
// printed page.
const BLOCKED_PATHS = [
  /^\/api\//,
  /^\/sw\.js$/,
  /^\/static\/member-tools\.js$/,
  /^\/static\/(?:chunks|gpt)/,
]
const FAILURE_SHARE = 0.02
const here = path.dirname(fileURLToPath(import.meta.url))
const printScript = path.join(here, "..", "frontend", "page-export", "print.js")

const normalize = (value) => value.split(path.sep).join("/")
const sha256 = (...parts) => {
  const hash = crypto.createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest("hex")
}
const walk = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(filename) : [filename]
  })

/**
 * Whether a built page has an Export menu (JqiFrame's [data-page-tools] with the page's source) and
 * isn't a member tool's page. An automatic folder page's tools row names no source: it isn't printed.
 */
export const hasExportMenu = (html) =>
  /<[^<>]*\sdata-page-tools(?:[\s=>])[^<>]*\sdata-source=/.test(html) &&
  !/\bclass="[^"]*\bmember-tools\b/.test(html)

/** A page's HTML file in the output (relative) → its slug, its address and its PDF's path. */
export function pdfTarget(relative, origin = DEFAULT_ORIGIN) {
  const slug = normalize(relative).replace(/\.html$/, "")
  const simple = slug === "index" ? "" : slug.replace(/\/index$/, "/")
  return {
    slug,
    url: `${origin.replace(/\/$/, "")}/${simple.split("/").map(encodeURIComponent).join("/")}`,
    pdf: `${PDF_DIRECTORY}/${slug}.pdf`,
  }
}

/**
 * The pages to print: every HTML file of the output with an Export menu. /pdf/ is the PDFs' own:
 * a page there is an error, and PDFs from an earlier run are cleared (unless `clear` is false).
 */
export function pdfPages(output, origin = DEFAULT_ORIGIN, { clear = true } = {}) {
  const root = path.resolve(output)
  const reserved = path.join(root, PDF_DIRECTORY)
  if (fs.existsSync(reserved)) {
    const pages = walk(reserved).filter((file) => !file.endsWith(".pdf"))
    if (pages.length)
      throw new Error(
        `render-pdfs: /${PDF_DIRECTORY}/ is reserved for the pages' PDFs, but the site has ` +
          pages.map((file) => normalize(path.relative(root, file))).join(", "),
      )
    if (clear) fs.rmSync(reserved, { recursive: true })
  }
  return walk(root)
    .filter((file) => file.endsWith(".html"))
    .map((file) => ({ file, html: fs.readFileSync(file, "utf8") }))
    .filter(({ html }) => hasExportMenu(html))
    .map(({ file, html }) => ({ ...pdfTarget(path.relative(root, file), origin), file, html }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

/** The built file a site path is served from, or null: /x → x.html, /x/ → x/index.html. */
export function siteFile(output, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const root = path.resolve(output)
  const target = path.resolve(root, `.${decoded}`)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  const candidates = decoded.endsWith("/")
    ? [path.join(target, "index.html")]
    : [target, `${target}.html`, path.join(target, "index.html")]
  return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null
}

/** The site's pictures a page's HTML shows (src, srcset, poster, data), as written in it. */
export function pageAssets(html) {
  const references = []
  for (const match of html.matchAll(/\s(?:src|poster|data)=["']([^"']+)["']/gi))
    references.push(match[1])
  for (const match of html.matchAll(/\ssrcset=["']([^"']+)["']/gi))
    for (const candidate of match[1].split(",")) references.push(candidate.trim().split(/\s+/)[0])
  return [
    ...new Set(
      references
        .filter((reference) => reference && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference))
        .map((reference) => reference.split(/[?#]/)[0].replace(/&amp;/g, "&"))
        .filter((reference) => /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(reference)),
    ),
  ]
}

/** The file a page (`file`) refers to by `reference` (relative, or from the site's root), or null. */
export function assetFile(output, file, reference) {
  const root = path.resolve(output)
  let decoded
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    return null
  }
  const target = decoded.startsWith("/")
    ? path.resolve(root, `.${decoded}`)
    : path.resolve(path.dirname(file), decoded)
  if (!target.startsWith(root + path.sep)) return null
  return fs.existsSync(target) && fs.statSync(target).isFile() ? target : null
}

/** What `scope` "article" keys a page on: its title, title block and article, not the rest. */
export function articlePart(html) {
  const start = html.indexOf('class="page-content__main"')
  const end = html.indexOf('class="page-content__aside"', start)
  return start >= 0 && end > start ? html.slice(start, end) : html
}

/**
 * A page's cache key: the page (all of it, whose stylesheet and script names carry their content
 * hashes, or with `scope` "article" only its article), every local file it shows, the print
 * code's version and the PDF options.
 */
export function pageKey({ html, file, output, scope = "full", version, fileHash }) {
  const assets = pageAssets(html)
    .map((reference) => {
      const target = assetFile(output, file, reference)
      return `${reference}=${target ? fileHash(target) : "missing"}`
    })
    .sort()
  return sha256(
    version,
    "\0",
    scope === "article" ? articlePart(html) : html,
    "\0",
    assets.join("\n"),
  )
}

// External GETs, fetched once per run through the browser and replayed from memory (routing a
// request turns the browser's own cache off).
function externalCache() {
  const responses = new Map()
  return async (route) => {
    const url = route.request().url()
    if (!responses.has(url))
      responses.set(
        url,
        (async () => {
          for (let attempt = 0; ; attempt++) {
            try {
              const response = await route.fetch({ timeout: 30_000 })
              const headers = { ...response.headers() }
              delete headers["content-encoding"]
              delete headers["content-length"]
              return { status: response.status(), headers, body: await response.body() }
            } catch (error) {
              if (attempt === 1) throw error
            }
          }
        })(),
      )
    try {
      return route.fulfill(await responses.get(url))
    } catch {
      responses.delete(url)
      return route.abort("failed")
    }
  }
}

/** Headless Chromium with the site served from `output` at `origin`: {browser, context, blocked}. */
export async function openBrowser({ output, origin = DEFAULT_ORIGIN, allowed = ALLOWED_HOSTS }) {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
  })
  const blocked = new Set()
  const external = externalCache()
  const site = new URL(origin).origin
  await context.route("**/*", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === site) {
      if (BLOCKED_PATHS.some((pattern) => pattern.test(url.pathname)))
        return route.abort("blockedbyclient")
      const file = siteFile(output, url.pathname)
      return file ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: "" })
    }
    if (request.method() === "GET" && allowed.has(url.hostname)) return external(route)
    if (url.protocol === "http:" || url.protocol === "https:")
      blocked.add(url.origin + url.pathname)
    return route.abort("blockedbyclient")
  })
  return { browser, context, blocked }
}

/**
 * Print one page ({url}) in a browser page: load it, run its print steps, lay it out for Letter,
 * print. `inspect`: a function run in the page just before it prints (tests).
 */
export async function printPage(page, { url }, { inspect } = {}) {
  const errors = []
  const onError = (error) => errors.push(String(error.message ?? error).slice(0, 200))
  // A font, stylesheet or script from a CDN that didn't come (not one blocked on purpose, nor one
  // the page itself gave up on): the page would print without it, and stay that way in the cache.
  const missing = []
  const site = new URL(url).origin
  const onFailed = (request) => {
    const failed = new URL(request.url())
    if (
      failed.origin !== site &&
      !/BLOCKED_BY_CLIENT|ERR_ABORTED/.test(request.failure()?.errorText ?? "")
    )
      missing.push(failed.origin + failed.pathname)
  }
  page.on("pageerror", onError)
  page.on("requestfailed", onFailed)
  try {
    await page.emulateMedia({ media: null })
    await page.goto(url, { waitUntil: "load", timeout: 30_000 })
    await page.waitForFunction(() => window.hafeziPrint, null, { timeout: 15_000 })
    const prepared = await page.evaluate(() => window.hafeziPrint.prepare())
    if (missing.length) throw new Error(`did not load ${[...new Set(missing)].join(", ")}`)
    if (prepared.undrawn) throw new Error(`${prepared.undrawn} Mermaid diagram(s) not drawn`)
    // What a page holds of restricted pages of other rules (data-acl, tools/acl/lists.mjs) is the
    // Worker's to show per member; a PDF is every reader's of the page, so it prints without it.
    await page.evaluate(() =>
      document.querySelectorAll("[data-acl]").forEach((element) => element.remove()),
    )
    await page.emulateMedia({ media: "print" })
    const fitted = await page.evaluate((width) => window.hafeziPrint.fit({ width }), LETTER_WIDTH)
    const inspected = inspect ? await page.evaluate(inspect) : undefined
    const pdf = await page.pdf(PDF_OPTIONS)
    return { pdf, prepared, ...fitted, errors, inspected }
  } finally {
    page.off("pageerror", onError)
    page.off("requestfailed", onFailed)
  }
}

/**
 * The largest PDF kept in a build: Workers' static assets take at most 25 MiB a file
 * (tools/audit-assets.mjs), and the members deploy failed on a 26 MiB one. A larger page keeps no
 * PDF: its Export menu falls back to the print dialog, and Save to Drive says there's none.
 */
export const MAX_PDF_BYTES = 20 * 1024 * 1024
const jobsDefault = () => Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length))

/**
 * Print every page with an Export menu in `output` to <output>/pdf/. `origin`: the site's address
 * (the pages' links become its URLs); `edition`: which cache to use ("public" or "members").
 * Throws when more than 2% of the pages fail; the rest fall back to the browser's print dialog.
 * `only`: a pattern of the slugs to print (a check of a few pages: the other PDFs, and the cache's
 * other entries, are kept).
 */
export async function renderPdfs(
  output,
  {
    origin = DEFAULT_ORIGIN,
    edition = "public",
    cache = process.env.PDF_CACHE || path.join(os.homedir(), ".cache", "hafezi-pdfs"),
    scope = process.env.PDF_CACHE_SCOPE === "article" ? "article" : "full",
    prune = process.env.PDF_CACHE_PRUNE !== "0",
    jobs = Number(process.env.PDF_JOBS) || jobsDefault(),
    allowed = ALLOWED_HOSTS,
    report: reportFile = process.env.PDF_REPORT ?? path.join(".cache", "pdf-report.json"),
    only = null,
    maxBytes = MAX_PDF_BYTES,
    log = console.log,
  } = {},
) {
  const started = Date.now()
  const root = path.resolve(output)
  const pages = pdfPages(root, origin, { clear: !only }).filter(
    (page) => !only || only.test(page.slug),
  )
  const shelf = path.join(cache, edition)
  fs.mkdirSync(shelf, { recursive: true })
  const version = sha256(
    fs.readFileSync(printScript),
    fs.readFileSync(fileURLToPath(import.meta.url)),
    JSON.stringify(PDF_OPTIONS),
  )
  const hashes = new Map()
  const fileHash = (file) => {
    if (!hashes.has(file)) hashes.set(file, sha256(fs.readFileSync(file)))
    return hashes.get(file)
  }
  const used = new Set()
  const todo = []
  const results = []
  for (const page of pages) {
    const key = pageKey({
      html: page.html,
      file: page.file,
      output: root,
      scope,
      version,
      fileHash,
    })
    const cached = path.join(shelf, `${key}.pdf`)
    const target = path.join(root, page.pdf)
    used.add(cached)
    delete page.html
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(cached)) {
      const bytes = fs.statSync(cached).size
      if (bytes > maxBytes) results.push({ slug: page.slug, cache: "hit", bytes, tooLarge: true })
      else {
        fs.copyFileSync(cached, target)
        results.push({ slug: page.slug, cache: "hit", bytes })
      }
    } else todo.push({ ...page, cached, target })
  }

  let browser
  let blocked = new Set()
  if (todo.length) {
    const opened = await openBrowser({ output: root, origin, allowed })
    browser = opened.browser
    blocked = opened.blocked
    let next = 0
    const worker = async () => {
      const page = await opened.context.newPage()
      try {
        while (next < todo.length) {
          const item = todo[next++]
          const begun = Date.now()
          try {
            const printed = await printPage(page, item)
            // Cached even when too large, so the next deploy doesn't print it again to learn so.
            fs.writeFileSync(item.cached, printed.pdf)
            const tooLarge = printed.pdf.length > maxBytes
            if (!tooLarge) fs.writeFileSync(item.target, printed.pdf)
            results.push({
              ...(tooLarge && { tooLarge: true }),
              slug: item.slug,
              cache: "miss",
              ms: Date.now() - begun,
              bytes: printed.pdf.length,
              notes: printed.prepared.notes,
              embeds: printed.prepared.embeds,
              brokenImages: printed.prepared.broken,
              fitted: printed.fitted,
              overflow: printed.overflow,
              errors: printed.errors,
            })
          } catch (error) {
            results.push({
              slug: item.slug,
              cache: "miss",
              failed: String(error.message).slice(0, 300),
            })
            fs.rmSync(item.target, { force: true })
          }
        }
      } finally {
        await page.close()
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, worker))
    } finally {
      await browser.close()
    }
  }

  if (prune && !only)
    for (const name of fs.readdirSync(shelf))
      if (!used.has(path.join(shelf, name))) fs.rmSync(path.join(shelf, name), { force: true })

  results.sort((a, b) => a.slug.localeCompare(b.slug))
  const failed = results.filter((result) => result.failed)
  const warned = results.filter(
    (result) =>
      result.overflow?.length || result.brokenImages || result.fitted?.some((fit) => !fit.fits),
  )
  const summary = {
    pages: pages.length,
    printed: results.filter((result) => result.cache === "miss" && !result.failed).length,
    cached: results.filter((result) => result.cache === "hit").length,
    failed: failed.length,
    tooLarge: results.filter((result) => result.tooLarge).length,
    warnings: warned.length,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    scope,
    blocked: [...blocked].sort(),
  }
  if (reportFile) {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true })
    fs.writeFileSync(reportFile, JSON.stringify({ summary, pages: results }, null, 1))
  }
  log(
    `render-pdfs: ${summary.pages} pages: ${summary.printed} printed, ${summary.cached} from the cache, ` +
      `${summary.failed} failed, ${summary.warnings} with warnings, in ${summary.seconds} s` +
      (reportFile ? `; report: ${reportFile}` : ""),
  )
  for (const result of failed) log(`render-pdfs: ${result.slug}: ${result.failed}`)
  for (const result of results.filter((result) => result.tooLarge))
    log(
      `render-pdfs: ${result.slug}: ${(result.bytes / 1048576).toFixed(1)} MiB, over ` +
        `${maxBytes / 1048576} MiB: no PDF kept (its menu falls back to printing)`,
    )
  for (const result of warned)
    log(
      `render-pdfs: ${result.slug}: ` +
        [
          result.overflow?.length && `wider than the page: ${result.overflow.join(", ")}`,
          result.brokenImages && `${result.brokenImages} image(s) did not load`,
          result.fitted?.some((fit) => !fit.fits) && "a table or equation still too wide",
        ]
          .filter(Boolean)
          .join("; "),
    )
  if (failed.length > Math.max(0, Math.floor(pages.length * FAILURE_SHARE)))
    throw new Error(`render-pdfs: ${failed.length} of ${pages.length} pages failed to print`)
  return { summary, pages: results }
}

async function main() {
  const [output, origin = DEFAULT_ORIGIN, edition = "public"] = process.argv.slice(2)
  if (!output) {
    console.error("usage: node tools/render-pdfs.mjs <built-site> [origin] [public|members]")
    process.exit(2)
  }
  await renderPdfs(output, { origin, edition })
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href)
  await main()
