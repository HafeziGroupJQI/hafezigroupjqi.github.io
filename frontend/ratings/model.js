// Pure helpers for a page's rating (frontend/ratings/index.js), so node:test covers them. A rating
// is the Worker's answer for one page (worker/src/ratings/routes.ts, GET/PUT /api/ratings):
// {path, score, up, down, mine, viewers, views7}.

/**
 * A page as ratings key it, from its address: no leading or trailing slash, no ".html", no
 * trailing "index"; the home page is "index" (the Worker's pagePath, worker/src/ratings/views.ts).
 */
export function pagePath(pathname) {
  let path = pathname
  try {
    path = decodeURIComponent(pathname)
  } catch {
    // An address the browser couldn't decode is taken as it is; the Worker refuses it.
  }
  path = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.html$/, "")
    .replace(/(^|\/)index$/, "")
    .replace(/\/+$/, "")
  return path || "index"
}

/** The Worker's rating of a page. */
export const ratingUrl = (path) => `/api/ratings?${new URLSearchParams({ path })}`

/** The vote a button sends: its own value, or 0 (none) when it is already the member's vote. */
export const nextVote = (mine, pressed) => (mine === pressed ? 0 : pressed)

/** The rating as it will be once the member's vote is `value`: shown before the Worker answers. */
export function withVote(rating, value) {
  const up = rating.up - (rating.mine === 1 ? 1 : 0) + (value === 1 ? 1 : 0)
  const down = rating.down - (rating.mine === -1 ? 1 : 0) + (value === -1 ? 1 : 0)
  return { ...rating, up, down, score: up - down, mine: value }
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** What the widget says: each button's label, the score's, and the readers'. */
export function ratingText(rating) {
  return {
    up: rating.mine === 1 ? "Remove your upvote" : "Upvote this page",
    down: rating.mine === -1 ? "Remove your downvote" : "Downvote this page",
    score: String(rating.score),
    scoreTitle: `Score ${rating.score}: ${plural(rating.up, "upvote")}, ${plural(rating.down, "downvote")}`,
    readers: plural(rating.viewers, "reader"),
    readersTitle: `${plural(rating.viewers, "member has", "members have")} read this page, ${rating.views7} in the last 7 days`,
  }
}

/**
 * Whether a page takes a rating: one with its own source in the tools row (JqiFrame's
 * [data-page-tools][data-source]), not one of the site's tool pages (a .member-tools body: /recent,
 * /leaderboard, the dashboards).
 */
export const rateable = ({ hasSource, isToolPage }) => hasSource && !isToolPage
