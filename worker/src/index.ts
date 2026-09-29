import { createHandler } from "./app"
import { pruneAudit } from "./audit"
import type { Env } from "./env"
import { publishDue } from "./profile/publish"
// Written by `npm run build:members` in the website root (tools/docs-manifest.mjs and
// tools/gpt-manifest.mjs).
import manifest from "../generated/docs-manifest.json"
import skills from "../generated/gpt-skills.json"

// The Durable Object class must be exported from the entry module for Wrangler to bind it.
export { DeviceHub } from "./devices/hub"
export { ComputeRelay } from "./compute/relay"

const DAILY = "17 4 * * *"

export default {
  ...createHandler(manifest, { skills }),
  // triggers.crons in wrangler.jsonc. Hourly: publish members' People page edits that are due
  // (one vault commit). Daily: drop audit rows past the retention window.
  async scheduled(controller, env, ctx) {
    if (controller.cron === DAILY) ctx.waitUntil(pruneAudit(env))
    else
      ctx.waitUntil(
        publishDue(env, (input, init) => fetch(input, init)).catch((error) =>
          console.error("publishing profile edits failed", error),
        ),
      )
  },
} satisfies ExportedHandler<Env>
