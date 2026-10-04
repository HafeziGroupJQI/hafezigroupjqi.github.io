// A page's rating, in its tools row (JqiFrame's [data-page-tools]): ▲ score ▼ and how many members
// have read it, like a reddit post's. A vote shows at once and goes back if the Worker refuses it
// (worker/src/ratings/routes.ts). Pressing the vote you already gave takes it back. Small and
// without dependencies: member-tools.js mounts it on every member page that has a source.

import { h } from "../dashboard/dom.js"
import { nextVote, pagePath, ratingText, ratingUrl, withVote } from "./model.js"

export async function mountRating(tools, { api }) {
  const path = pagePath(location.pathname)
  let rating
  try {
    rating = await api(ratingUrl(path))
  } catch {
    // A page the Worker doesn't rate (or can't reach) simply has no rating.
    return
  }
  const button = (value, symbol) =>
    h("button", {
      type: "button",
      class: `page-rating__vote page-rating__vote--${value > 0 ? "up" : "down"}`,
      "data-vote": value,
      text: symbol,
    })
  const up = button(1, "▲")
  const down = button(-1, "▼")
  const score = h("span", { class: "page-rating__score" })
  const readers = h("span", { class: "page-rating__readers" })
  // What screen readers hear after a vote, and why one didn't save.
  const status = h("span", { class: "page-rating__status", role: "status", "aria-live": "polite" })
  const widget = h(
    "div",
    { class: "page-rating", role: "group", "aria-label": "Rate this page" },
    up,
    score,
    down,
    readers,
    status,
  )

  const show = (shown) => {
    const text = ratingText(shown)
    for (const [node, value, label] of [
      [up, 1, text.up],
      [down, -1, text.down],
    ]) {
      node.setAttribute("aria-pressed", String(shown.mine === value))
      node.setAttribute("aria-label", label)
      node.title = label
    }
    score.textContent = text.score
    score.title = text.scoreTitle
    score.setAttribute("aria-label", text.scoreTitle)
    readers.textContent = text.readers
    readers.title = text.readersTitle
  }

  // Votes go one after another, so the Worker keeps the last one clicked; the widget shows each at
  // once and, if the last one fails, the rating as the Worker last answered it.
  let confirmed = rating
  let clicks = 0
  let queue = Promise.resolve()
  const send = async (value, click) => {
    try {
      confirmed = await api("/api/ratings", {
        method: "PUT",
        body: JSON.stringify({ path, value }),
      })
      if (click !== clicks) return
      rating = confirmed
      show(rating)
      status.textContent = value
        ? `Your ${value > 0 ? "upvote" : "downvote"} is saved.`
        : "Your vote is taken back."
    } catch (error) {
      if (click !== clicks) return
      rating = confirmed
      show(rating)
      status.textContent = `Your vote didn't save: ${error.message}`
      status.classList.add("is-error")
    }
  }
  widget.addEventListener("click", (event) => {
    const pressed = Number(event.target.closest("[data-vote]")?.dataset.vote)
    if (!pressed) return
    const value = nextVote(rating.mine, pressed)
    const click = ++clicks
    rating = withVote(rating, value)
    show(rating)
    status.textContent = ""
    status.classList.remove("is-error")
    queue = queue.then(() => send(value, click))
  })
  show(rating)
  tools.append(widget)
}
