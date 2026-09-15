import { execFileSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { prepareSite } from "./prepare-site.mjs"
import { auditOutput, auditSource } from "./audit-assets.mjs"
import { parseBuildOptions } from "./build-options.mjs"
import { renderDrawings } from "./render-excalidraw.mjs"
import yaml from "yaml"
import { prepareUnified } from "./prepare-unified.mjs"
import { build as bundle } from "esbuild"
import { renderPrivateSource } from "./render-private-source.mjs"

const options = parseBuildOptions(process.argv.slice(2))
let prepared
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
const { stage, output, manifest } = prepared
const config = yaml.parse(fs.readFileSync(options.config, "utf8"))
if (options.mode === "internal") {
  const index = config.plugins.find((plugin) => plugin.source === "@quartz-community/content-index")
  index.options = { ...index.options, enableSiteMap: false, enableRSS: false }
  config.configuration.ignorePatterns = config.configuration.ignorePatterns.filter(
    (pattern) => pattern !== "**/*.pdf",
  )
}
const generatedConfig = path.join(stage, "quartz.config.yaml")
fs.writeFileSync(generatedConfig, yaml.stringify(config))
const env = {
  ...process.env,
  CONTENT_DIR: output,
  SITE_MODE: options.mode,
  QUARTZ_CONFIG_PATH: generatedConfig,
  ...(options.quartzBaseUrl ? { QUARTZ_BASE_URL: options.quartzBaseUrl } : {}),
}
try {
  fs.mkdirSync(".cache", { recursive: true })
  fs.writeFileSync(".cache/site-source-map.json", JSON.stringify(manifest, null, 2))
  const sourceAudit = await auditSource(output)
  if (sourceAudit.errors.length) throw new Error(sourceAudit.errors.join("\n"))
  await renderDrawings(output)
  execFileSync(process.execPath, ["tools/render-qmd.mjs"], { stdio: "inherit", env })
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
  if (options.mode === "internal") {
    await bundle({
      entryPoints: ["members/frontend/member-tools.js"],
      outfile: path.join(options.output, "static/member-tools.js"),
      bundle: true,
      minify: true,
      format: "esm",
    })
    fs.writeFileSync(path.join(options.output, "robots.txt"), "User-agent: *\nDisallow: /\n")
  }
  const outputAudit = await auditOutput(options.output)
  if (outputAudit.errors.length) throw new Error(outputAudit.errors.join("\n"))
} finally {
  fs.rmSync(stage, { recursive: true })
}
