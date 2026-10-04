import { canReadSitePath } from "../acl"
import type { Env } from "../env"
import type { Session } from "../session"

// Every access decision of ratings and the leaderboard goes through readablePage, one call site per
// use: GET and PUT /api/ratings (routes.ts) and each row of the top pages (leaderboard.ts). A page
// under an access rule the member can't read (acl/index.ts) is as if it didn't exist.

/** Whether `session` may read the page `sitePath` (a page path as pagePath in views.ts gives it). */
export function readablePage(env: Env, session: Session, sitePath: string): Promise<boolean> {
  return canReadSitePath(env, session, sitePath)
}
