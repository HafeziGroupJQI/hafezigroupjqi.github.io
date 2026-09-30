import { createHandler } from "./app"
import { pruneAudit } from "./audit"
import { expireConflicts } from "./edit/conflicts"
import { commitDue } from "./edit/publish"
import type { Env } from "./env"
import { publishDue } from "./profile/publish"
import { mergeDue } from "./uploads/merge"
// Written by `npm run build:members` in the website root (tools/docs-manifest.mjs and
// tools/gpt-manifest.mjs).
import manifest from "../generated/docs-manifest.json"
import skills from "../generated/gpt-skills.json"

// The Durable Object class must be exported from the entry module for Wrangler to bind it.
export { DeviceHub } from "./devices/hub"
export { ComputeRelay } from "./compute/relay"

const DAILY = "17 4 * * *"
const UPLOADS = "2 * * * *"
const EDITS = "4 * * * *"

export default {
  ...createHandler(manifest, { skills }),
  // triggers.crons in wrangler.jsonc. Daily: drop audit rows past the retention window, send
  // unsettled edit conflicts back to their authors and drop long-unsent page edits. Hourly,
  // each in an invocation of its own (so each has the Workers Free plan's 50 subrequests): on the
  // hour, publish members' People page edits that are due (one vault commit); at :02, merge their
  // uploads and private page edits that are due and checked (src/uploads/merge.ts); at :04, commit
  // their public page edits that are due (src/edit/publish.ts). With HOURLY_RUNS "one" (an account
  // out of cron triggers keeps only the hourly one), the hourly run does all three, fewer of each.
  async scheduled(controller, env, ctx) {
    const fetcher = (input: string, init: RequestInit) => fetch(input, init)
    const run = (what: string, job: () => Promise<unknown>) =>
      job().catch((error) => console.error(`${what} failed`, error))
    if (controller.cron === DAILY)
      ctx.waitUntil(
        Promise.all([pruneAudit(env), run("expiring edit conflicts", () => expireConflicts(env))]),
      )
    else if (controller.cron === UPLOADS)
      ctx.waitUntil(run("merging uploads", () => mergeDue(env, fetcher)))
    else if (controller.cron === EDITS)
      ctx.waitUntil(run("committing page edits", () => commitDue(env, fetcher)))
    else if (env.HOURLY_RUNS === "one")
      ctx.waitUntil(
        run("publishing profile edits", () => publishDue(env, fetcher))
          .then(() => run("merging uploads", () => mergeDue(env, fetcher, Date.now(), 2)))
          .then(() => run("committing page edits", () => commitDue(env, fetcher, Date.now(), 1))),
      )
    else ctx.waitUntil(run("publishing profile edits", () => publishDue(env, fetcher)))
  },
} satisfies ExportedHandler<Env>
