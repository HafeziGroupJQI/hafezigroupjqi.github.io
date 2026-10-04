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
  listVaultFiles,
  pruneDocuments,
  untrackedDocuments,
  writeDocsManifest,
} from "./docs-manifest.mjs"
import { excluded } from "./prepare-unified.mjs"
import { writeAuthPages } from "./members-pages.mjs"
import { DEFAULT_API, bundleMembers } from "./members-bundles.mjs"
import { writeGptSkills } from "./gpt-manifest.mjs"
import { pageHistories } from "./history.mjs"
import { vaultFolders } from "./folder-files.mjs"
import { overlayFiles, restrictedDirs } from "./acl/vaults.mjs"
import { normalizeSnapshot } from "./acl/policy.mjs"
import {
  checkCoverage,
  markPages,
  readSnapshot,
  snapshotSource,
  writeBuildVersion,
} from "./acl/snapshot.mjs"
import { aclRefs, writeContentIndex, writeRefs } from "./acl/outputs.mjs"
import { leakScan, report as leakReport } from "./acl-leak-scan.mjs"

const options = parseBuildOptions(process.argv.slice(2))
// The members API (Cloudflare Worker) that the github.io site signs in with and that serves the
// member edition to signed-in browsers. Baked into the members bundles (tools/members-bundles.mjs).
const membersApi = process.env.MEMBERS_API_ORIGIN || DEFAULT_API
let prepared
const privateRoot = options.mode === "internal" ? fs.realpathSync(options.content) : null
// The restricted vaults (tools/acl/vaults.mjs), overlaid onto the private vault at their folders:
// a file outside its vault's folder, or one the private vault has too, fails the build here.
const restricted =
  options.mode === "internal" ? restrictedDirs(process.env.VAULT_RESTRICTED_DIRS) : []
const overlay = overlayFiles(restricted, privateRoot, { excluded })
// The access rules (tools/acl/): the Worker's, exported from D1 to ACL_SNAPSHOT (only that, in CI).
// Every restricted vault file must be covered by one.
const source = options.mode === "internal" ? snapshotSource(process.env, privateRoot) : null
if (source?.warning) console.warn(source.warning)
const acl = readSnapshot(source?.file ?? null)
checkCoverage(acl, overlay)
if (options.mode === "internal")
  console.log(`access rules: version ${acl.version}, ${acl.rules.length} rules`)
if (restricted.length)
  console.log(
    `restricted vaults: ${restricted.map((vault) => `${vault.repo} at ${vault.prefix}`).join(", ")} (${overlay.length} files)`,
  )
// Private documents are never bundled: the member build records their git blobs and the
// Worker streams them from GitHub. Quartz ignores their extensions so the site stays small.
const manifest =
  options.mode === "internal" ? docsManifest(privateRoot, { excluded, restricted }) : {}
if (options.mode === "internal") {
  const rendered = await renderPrivateSource(options.content, { overlay })
  try {
    prepared = prepareUnified(options.publicContent, rendered.content, yaml, { acl })
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
          ? [
              {
                repo: "vault-private",
                dir: privateRoot,
                except: restricted.map((vault) => vault.prefix),
              },
              // A restricted vault's pages are vault-private's (edit_repo), with their own git's history.
              ...restricted.map((vault) => ({
                repo: "vault-private",
                dir: vault.dir,
                only: vault.prefix,
              })),
            ]
          : []),
      ],
      prepared.records,
      { pages: (file) => /\.(?:md|qmd|ipynb|nb)$/.test(file) },
    ),
  ),
)
// The private vault's folders and each one's documents, for the member edition's automatic folder
// pages (quartz/plugins/local/folder-index/): a folder without an index lists them as downloads.
const foldersFile = path.join(stage, "folders.json")
if (options.mode === "internal")
  fs.writeFileSync(
    foldersFile,
    JSON.stringify(vaultFolders(privateRoot, { excluded, restricted, acl })),
  )
const config = yaml.parse(fs.readFileSync(options.config, "utf8"))
if (options.mode === "internal") {
  const index = config.plugins.find((plugin) => plugin.source === "@quartz-community/content-index")
  index.options = { ...index.options, enableSiteMap: false, enableRSS: false }
  config.configuration.ignorePatterns.push(
    ...documentExtensions(manifest).map((extension) => `resources/**/*${extension}`),
  )
  // The restricted pages' search index entries and every private page's file (tools/acl/outputs.mjs).
  config.plugins.push({ source: "./quartz/plugins/local/acl-index", enabled: true })
  // Pages' search text and descriptions without what they hold of other rules' restricted pages:
  // right after Quartz's description plugin (order 70) makes them.
  const description = config.plugins.find(
    (plugin) => plugin.source === "@quartz-community/description",
  )
  config.plugins.push({
    source: "./quartz/plugins/local/acl-text",
    enabled: true,
    order: (description?.order ?? 70) + 1,
  })
}
const generatedConfig = path.join(stage, "quartz.config.yaml")
fs.writeFileSync(generatedConfig, yaml.stringify(config))
const env = {
  ...process.env,
  CONTENT_DIR: output,
  SITE_MODE: options.mode,
  QUARTZ_CONFIG_PATH: generatedConfig,
  SITE_HISTORY: historyFile,
  ...(options.mode === "internal"
    ? { SITE_FOLDERS: foldersFile, SITE_ACL_PAGES: path.join(stage, "acl-pages.json") }
    : {}),
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
  // The notebooks' pages are made after prepare-unified marked the restricted ones: these too.
  if (options.mode === "internal") markPages(output, acl, yaml)
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
    // The search index without restricted pages, and each rule's shard of them (tools/acl/).
    const aclPages = JSON.parse(fs.readFileSync(env.SITE_ACL_PAGES, "utf8"))
    const folders = JSON.parse(fs.readFileSync(foldersFile, "utf8"))
    const split = writeContentIndex(options.output, {
      pages: aclPages,
      folders,
      documents: manifest,
      acl,
    })
    console.log(
      `content index: ${split.base} pages for every member; restricted: ${JSON.stringify(split.restricted)}`,
    )
    await bundleMembers(options.output, "internal", membersApi)
    fs.writeFileSync(path.join(options.output, "robots.txt"), "User-agent: *\nDisallow: /\n")
    const pruned = pruneDocuments(options.output, manifest)
    const written = writeDocsManifest(manifest)
    console.log(
      `${Object.keys(manifest).length} private documents recorded in ${written}${pruned ? ` (${pruned} pruned from the site)` : ""}`,
    )
    writeBuildVersion(options.output, acl)
    const skills = writeGptSkills(privateRoot)
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
  if (options.mode === "internal") {
    // Every private page's, alias's, notebook asset's, PDF's and restricted file's vault path, for
    // the Worker's access checks (tools/acl/outputs.mjs).
    const reportFile = process.env.NOTEBOOK_REPORT ?? path.join(".cache", "notebook-report.json")
    const refs = aclRefs(options.output, {
      acl,
      pages: JSON.parse(fs.readFileSync(env.SITE_ACL_PAGES, "utf8")),
      folders: JSON.parse(fs.readFileSync(foldersFile, "utf8")),
      notebooks: fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null,
      vaultFiles: listVaultFiles(privateRoot, { excluded, restricted }),
    })
    const written = writeRefs(options.output, refs)
    console.log(
      `access refs: ${Object.keys(refs.pages).length} pages, ${Object.keys(refs.aliases).length} aliases, ` +
        `${Object.keys(refs.notebookAssets).length} notebook assets, ${Object.keys(refs.pdfs).length} pdfs, ` +
        `${Object.keys(refs.files).length} restricted files in ${path.relative(options.output, written)}`,
    )
    // No restricted page's words outside what its rule's members get (tools/acl-leak-scan.mjs).
    const started = Date.now()
    const scan = leakScan(options.output, { acl, documents: manifest })
    console.log(
      `acl leak scan: ${scan.needles} needles in ${scan.files} files, ${scan.hits.length} found, in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    )
    if (scan.hits.length)
      throw new Error(
        `restricted pages' words are in files their rules don't cover:\n${leakReport(scan.hits)}`,
      )
  }
  const outputAudit = await auditOutput(
    options.output,
    options.mode === "internal" ? { external: new Set(Object.keys(manifest)), limits: {} } : {},
  )
  if (outputAudit.errors.length) throw new Error(outputAudit.errors.join("\n"))
} finally {
  fs.rmSync(stage, { recursive: true })
}
