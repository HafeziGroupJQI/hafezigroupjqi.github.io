import path from "node:path"
import { fileURLToPath } from "node:url"
import { build as bundle } from "esbuild"

// The three bundles that carry the members API origin (MEMBERS_API_ORIGIN):
//   public edition:  /sw.js (the members service worker) and /static/members-auth.js (sign-in pages)
//   member edition:  /static/member-tools.js (calendar + dashboard; the live stream calls the API)
export const DEFAULT_API = "https://hafezi-members.anishgoyal1108.workers.dev"

export async function bundleMembers(output, mode, apiOrigin = DEFAULT_API) {
  const define = { __MEMBERS_API__: JSON.stringify(apiOrigin.replace(/\/$/, "")) }
  const common = { bundle: true, minify: true, define, logLevel: "warning" }
  if (mode === "internal") {
    await bundle({
      ...common,
      entryPoints: ["frontend/member-tools.js"],
      outfile: path.join(output, "static/member-tools.js"),
      format: "esm",
    })
    return
  }
  await bundle({
    ...common,
    entryPoints: ["frontend/members/sw.js"],
    outfile: path.join(output, "sw.js"),
    format: "iife",
  })
  await bundle({
    ...common,
    entryPoints: ["frontend/members/pages.js"],
    outfile: path.join(output, "static/members-auth.js"),
    format: "esm",
  })
}

// CLI (tools/verify-members.sh): re-point already-built editions at another API origin.
//   node tools/members-bundles.mjs <api-origin> <public-dir> <private-dir>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [api, publicDir, privateDir] = process.argv.slice(2)
  await bundleMembers(publicDir, "public", api)
  await bundleMembers(privateDir, "internal", api)
}
