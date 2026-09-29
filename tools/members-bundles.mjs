import path from "node:path"
import { fileURLToPath } from "node:url"
import { build as bundle } from "esbuild"

// The three bundles that carry the members API origin (MEMBERS_API_ORIGIN):
//   public edition:  /sw.js (the members service worker) and /static/members-auth.js (sign-in pages)
//   member edition:  /static/member-tools.js (calendar, dashboard, admin, Hafezi GPT; streams call the API)
// and, in both editions, /static/page-export.js: every page's Export menu, which needs no API.
export const DEFAULT_API = "https://hafezi-members.anishgoyal1108.workers.dev"

export async function bundleMembers(output, mode, apiOrigin = DEFAULT_API) {
  const define = { __MEMBERS_API__: JSON.stringify(apiOrigin.replace(/\/$/, "")) }
  const common = { bundle: true, minify: true, define, logLevel: "warning" }
  await bundle({
    ...common,
    entryPoints: ["frontend/page-export/index.js"],
    outfile: path.join(output, "static/page-export.js"),
    format: "esm",
  })
  if (mode === "internal") {
    // Split so heavy tools (Hafezi GPT's Markdown renderer, the Scratchpad, the Wolfram guide and
    // its CodeMirror editor) load only when opened: static/member-tools.js on every member page,
    // static/chunks/* on demand.
    await bundle({
      ...common,
      entryPoints: { "member-tools": "frontend/member-tools.js" },
      outdir: path.join(output, "static"),
      chunkNames: "chunks/[name]-[hash]",
      splitting: true,
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
