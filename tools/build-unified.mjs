import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))
if (fs.existsSync("members/.env")) process.loadEnvFile("members/.env")
const env = process.env
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
for (const args of [
  ["--content", publicSource, "--output", publicOutput],
  [
    "--mode",
    "internal",
    "--public-content",
    publicSource,
    "--content",
    privateSource,
    "--output",
    privateOutput,
  ],
])
  execFileSync(process.execPath, ["tools/build-site.mjs", ...args, "--base-url", baseUrl], {
    stdio: "inherit",
    env,
  })
console.log("Unified website built. Start the gateway with members/.venv/bin/hafezi-members.")
