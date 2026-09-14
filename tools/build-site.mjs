import { execFileSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { prepareSite } from "./prepare-site.mjs"
import { auditOutput, auditSource } from "./audit-assets.mjs"
import { renderDrawings } from "./render-excalidraw.mjs"
import yaml from "yaml"

const { stage, output, manifest } = prepareSite(process.env.CONTENT_DIR ?? "content", yaml)
const env = { ...process.env, CONTENT_DIR: output }
const quartzArgs = process.argv.slice(2)
const outputIndex = quartzArgs.findIndex((argument) => argument === "--output" || argument === "-o")
const siteOutput = path.resolve(outputIndex >= 0 ? quartzArgs[outputIndex + 1] : "public")
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
      ...quartzArgs,
    ],
    { stdio: "inherit", env },
  )
  const outputAudit = await auditOutput(siteOutput)
  if (outputAudit.errors.length) throw new Error(outputAudit.errors.join("\n"))
} finally {
  fs.rmSync(stage, { recursive: true })
}
