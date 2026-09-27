import { createHandler } from "./app"
import { pruneAudit } from "./audit"
import type { Env } from "./env"
// Written by `npm run build:members` in the website root (tools/docs-manifest.mjs and
// tools/gpt-manifest.mjs).
import manifest from "../generated/docs-manifest.json"
import skills from "../generated/gpt-skills.json"

// The Durable Object class must be exported from the entry module for Wrangler to bind it.
export { DeviceHub } from "./devices/hub"

export default {
  ...createHandler(manifest, { skills }),
  // Daily (triggers.crons in wrangler.jsonc): drop audit rows past the retention window.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(pruneAudit(env))
  },
} satisfies ExportedHandler<Env>
