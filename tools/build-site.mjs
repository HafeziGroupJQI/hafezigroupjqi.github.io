import { execFileSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { prepareSite } from "./prepare-site.mjs"
import yaml from "yaml"

const { stage, output, manifest } = prepareSite(process.env.CONTENT_DIR ?? "content", yaml)
const env = { ...process.env, CONTENT_DIR: output }
try {
  fs.mkdirSync(".cache", { recursive: true })
  fs.writeFileSync(".cache/site-source-map.json", JSON.stringify(manifest, null, 2))
  execFileSync(process.execPath, ["tools/render-qmd.mjs"], { stdio: "inherit", env })
  execFileSync(
    process.execPath,
    [
      "quartz/bootstrap-cli.mjs",
      "build",
      "--directory",
      path.relative(process.cwd(), output),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env },
  )
} finally {
  fs.rmSync(stage, { recursive: true })
}
