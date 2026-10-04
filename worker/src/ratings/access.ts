import type { Env } from "../env"
import type { Session } from "../session"

// Every access decision of ratings and the leaderboard goes through readablePage, one call site per
// use: GET and PUT /api/ratings (routes.ts) and each row of the top pages (leaderboard.ts). Until
// the site's access rules land, every member may read every page the members site serves; then
// this asks them (acl/index.ts canReadSitePath), and nothing else here changes.

/** Whether `session` may read the page `sitePath` (a page path as pagePath in views.ts gives it). */
export async function readablePage(env: Env, session: Session, sitePath: string): Promise<boolean> {
  void [env, session, sitePath]
  return true
}
