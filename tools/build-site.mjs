import { execFileSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { prepareSite } from "./prepare-site.mjs"
import { auditOutput, auditSource } from "./audit-assets.mjs"
import { parseBuildOptions } from "./build-options.mjs"
import { renderDrawings } from "./render-excalidraw.mjs"
import { renderPdfs } from "./render-pdfs.mjs"
import yaml from "yaml"
import { prepareUnified } from "./prepare-unified.mjs"
import { renderPrivateSource } from "./render-private-source.mjs"
import {
  docsManifest,
  documentExtensions,
  pruneDocuments,
  untrackedDocuments,
  writeDocsManifest,
} from "./docs-manifest.mjs"
import { excluded } from "./prepare-unified.mjs"
import { writeAuthPages } from "./members-pages.mjs"
import { DEFAULT_API, bundleMembers } from "./members-bundles.mjs"
import { writeGptSkills } from "./gpt-manifest.mjs"
import { pageHistories } from "./history.mjs"

const options = parseBuildOptions(process.argv.slice(2))
// The members API (Cloudflare Worker) that the github.io site signs in with and that serves the
// member edition to signed-in browsers. Baked into the members bundles (tools/members-bundles.mjs).
const membersApi = process.env.MEMBERS_API_ORIGIN || DEFAULT_API
let prepared
// Private documents are never bundled: the member build records their git blobs and the
// Worker streams them from GitHub. Quartz ignores their extensions so the site stays small.
const manifest =
  options.mode === "internal" ? docsManifest(fs.realpathSync(options.content), { excluded }) : {}
if (options.mode === "internal") {
  const rendered = await renderPrivateSource(options.content)
  try {
    prepared = prepareUnified(options.publicContent, rendered.content, yaml)
  } finally {
    fs.rmSync(rendered.stage, { recursive: true, force: true })
  }
} else {
  prepared = prepareSite(options.content, yaml)
}
const { stage, output, manifest: sourceMap } = prepared
// Each page's revisions, from the vaults' git history (tools/history.mjs): the public vault's in both
// editions, the private vault's only in the member edition. The page-history emitter writes each
// page's beside it (quartz/plugins/local/page-history/), for the page's History button.
const historyFile = path.join(stage, "history.json")
fs.writeFileSync(
  historyFile,
  JSON.stringify(
    pageHistories(
      [
        { repo: "vault", dir: prepared.input },
        ...(options.mode === "internal"
          ? [{ repo: "vault-private", dir: fs.realpathSync(options.content) }]
          : []),
      ],
      prepared.records,
      { pages: (file) => /\.(?:md|qmd|ipynb|nb)$/.test(file) },
    ),
  ),
)
const config = yaml.parse(fs.readFileSync(options.config, "utf8"))
if (options.mode === "internal") {
  const index = config.plugins.find((plugin) => plugin.source === "@quartz-community/content-index")
  index.options = { ...index.options, enableSiteMap: false, enableRSS: false }
  config.configuration.ignorePatterns.push(
    ...documentExtensions(manifest).map((extension) => `resources/**/*${extension}`),
  )
}
const generatedConfig = path.join(stage, "quartz.config.yaml")
fs.writeFileSync(generatedConfig, yaml.stringify(config))
const env = {
  ...process.env,
  CONTENT_DIR: output,
  SITE_MODE: options.mode,
  QUARTZ_CONFIG_PATH: generatedConfig,
  SITE_HISTORY: historyFile,
  ...(options.quartzBaseUrl ? { QUARTZ_BASE_URL: options.quartzBaseUrl } : {}),
}
try {
  fs.mkdirSync(".cache", { recursive: true })
  fs.writeFileSync(".cache/site-source-map.json", JSON.stringify(sourceMap, null, 2))
  const sourceAudit = await auditSource(output)
  if (sourceAudit.errors.length) throw new Error(sourceAudit.errors.join("\n"))
  if (options.mode === "internal") {
    const untracked = untrackedDocuments(output, manifest)
    if (untracked.length)
      throw new Error(
        `private documents must be committed before they can be served:\n${untracked.join("\n")}`,
      )
  }
  await renderDrawings(output)
  execFileSync(process.execPath, ["tools/render-qmd.mjs"], { stdio: "inherit", env })
  // Every other notebook (.ipynb, Wolfram .nb) becomes a page from its saved outputs
  // (tools/notebooks/). Wolfram pages' figures and sounds are served at /notebook-assets/.
  const notebookAssets = path.join(stage, "notebook-assets")
  execFileSync(process.execPath, ["tools/notebooks/render-notebooks.mjs"], {
    stdio: "inherit",
    env: {
      ...env,
      NOTEBOOK_ASSETS: notebookAssets,
      NOTEBOOK_FORK_PREFIX: options.mode === "internal" ? "resources/" : "",
    },
  })
  execFileSync(
    process.execPath,
    [
      "quartz/bootstrap-cli.mjs",
      "build",
      "--directory",
      path.relative(process.cwd(), output),
      ...options.quartzArgs,
    ],
    { stdio: "inherit", env },
  )
  if (fs.existsSync(notebookAssets))
    fs.cpSync(notebookAssets, path.join(options.output, "notebook-assets"), { recursive: true })
  if (options.mode === "internal") {
    await bundleMembers(options.output, "internal", membersApi)
    fs.writeFileSync(path.join(options.output, "robots.txt"), "User-agent: *\nDisallow: /\n")
    const pruned = pruneDocuments(options.output, manifest)
    const written = writeDocsManifest(manifest)
    console.log(
      `${Object.keys(manifest).length} private documents recorded in ${written}${pruned ? ` (${pruned} pruned from the site)` : ""}`,
    )
    const skills = writeGptSkills(fs.realpathSync(options.content))
    console.log(`${skills.count} Hafezi GPT skills written to ${skills.file}`)
  }
  if (options.mode !== "internal") {
    // The public site carries the members entry points: the service worker that serves signed-in
    // browsers the member edition, and the sign-in pages. No member content is in this build.
    await bundleMembers(options.output, "public", membersApi)
    writeAuthPages(options.output)
  }
  // Every page with an Export menu as a PDF at /pdf/<slug>.pdf, printed from this build in
  // headless Chromium (cached by content; PDF_RENDER=0 skips it, e.g. for a quick local build).
  if (process.env.PDF_RENDER !== "0") {
    const host = (options.quartzBaseUrl ?? config.configuration.baseUrl).split("/")[0]
    const local = /^(?:localhost|127\.0\.0\.1)(?::|$)/.test(host)
    await renderPdfs(options.output, {
      origin: `${local ? "http" : "https"}://${host}`,
      edition: options.mode === "internal" ? "members" : "public",
    })
  }
  const outputAudit = await auditOutput(
    options.output,
    options.mode === "internal" ? { external: new Set(Object.keys(manifest)), limits: {} } : {},
  )
  if (outputAudit.errors.length) throw new Error(outputAudit.errors.join("\n"))
} finally {
  fs.rmSync(stage, { recursive: true })
}
