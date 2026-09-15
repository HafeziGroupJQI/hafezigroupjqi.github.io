import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))
if (fs.existsSync("members/.env")) process.loadEnvFile("members/.env")
const env = process.env
// --edition public|members|both: rebuild one edition after a small change (the gateway
// serves the output directories directly, so no restart is needed).
const editionIndex = process.argv.indexOf("--edition")
const edition = editionIndex > 0 ? process.argv[editionIndex + 1] : "both"
if (!["public", "members", "both"].includes(edition))
  throw new Error("--edition must be public, members, or both")
const baseUrl = env.MEMBERS_BASE_URL ?? "http://127.0.0.1:8100"
const publicSource = env.VAULT_PUBLIC_DIR ?? "content"
const privateSource = env.VAULT_PRIVATE_DIR ?? "../vault-private"
const publicOutput = env.MEMBERS_PUBLIC_SITE_PATH ?? "public"
const privateOutput = env.MEMBERS_SITE_PATH ?? ".cache/private-site"
const publicPath = path.resolve(publicOutput)
const privatePath = path.resolve(privateOutput)
if (
  publicPath === privatePath ||
  privatePath.startsWith(publicPath + path.sep) ||
  publicPath.startsWith(privatePath + path.sep)
)
  throw new Error("Public and member build directories must be separate, non-nested paths")
const builds = []
if (edition !== "members") builds.push(["--content", publicSource, "--output", publicOutput])
if (edition !== "public")
  builds.push([
    "--mode",
    "internal",
    "--public-content",
    publicSource,
    "--content",
    privateSource,
    "--output",
    privateOutput,
  ])
for (const args of builds)
  execFileSync(process.execPath, ["tools/build-site.mjs", ...args, "--base-url", baseUrl], {
    stdio: "inherit",
    env,
  })
console.log(
  `${edition === "both" ? "Unified website" : edition + " edition"} built. The gateway (members/.venv/bin/hafezi-members) serves it directly.`,
)
