import { execFileSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { prepareSite } from "./prepare-site.mjs"
import { auditOutput, auditSource } from "./audit-assets.mjs"
import { parseBuildOptions } from "./build-options.mjs"
import { renderDrawings } from "./render-excalidraw.mjs"
import yaml from "yaml"

const options = parseBuildOptions(process.argv.slice(2))
const { stage, output, manifest } = prepareSite(options.content, yaml, { mode: options.mode })
const env = {
  ...process.env,
  CONTENT_DIR: output,
  SITE_MODE: options.mode,
  QUARTZ_CONFIG_PATH: path.resolve(options.config),
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
  const outputAudit = await auditOutput(options.output)
  if (outputAudit.errors.length) throw new Error(outputAudit.errors.join("\n"))
} finally {
  fs.rmSync(stage, { recursive: true })
}
