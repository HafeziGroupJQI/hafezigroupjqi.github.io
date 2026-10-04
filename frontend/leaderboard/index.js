// /leaderboard, the members' Leaderboard: members by Total (their contributions, and the votes and
// readers of the pages they wrote) and the pages members liked most, for the week, the month or
// all time, from the Worker (worker/src/ratings/leaderboard.ts). ?tab=pages&period=week picks the
// view; each member links to their contributions on /recent, each page to itself.

import { h } from "../dashboard/dom.js"
import {
  MEMBER_COLUMNS,
  MEMBERS_SENTENCE,
  PAGE_COLUMNS,
  PERIODS,
  TABS,
  memberCells,
  membersNotes,
  membersUrl,
  pageCells,
  pagesSentence,
  pagesUrl,
  stateOf,
  stateSearch,
} from "./model.js"
import { rankTable } from "./table.js"

/* global fetchData */

export async function mountLeaderboard(root, { api }) {
  let { tab, period } = stateOf(location.search)
  const titles = typeof fetchData === "undefined" ? {} : await fetchData.catch(() => ({}))
  const tabs = h(
    "div",
    { class: "recent-tabs", role: "tablist", "aria-label": "Leaderboard" },
    TABS.map(([key, text]) => h("button", { type: "button", role: "tab", "data-tab": key, text })),
  )
  const periods = h(
    "div",
    { class: "recent-tabs recent-periods", role: "group", "aria-label": "Period" },
    PERIODS.map(([key, text]) => h("button", { type: "button", "data-period": key, text })),
  )
  const intro = h("p", {})
  const status = h("p", { class: "recent-status", role: "status", "aria-live": "polite" })
  const board = h("div", { role: "tabpanel" })
  let loading = 0

  const show = async () => {
    for (const button of tabs.children)
      button.setAttribute("aria-selected", String(button.dataset.tab === tab))
    for (const button of periods.children)
      button.setAttribute("aria-pressed", String(button.dataset.period === period))
    intro.textContent = tab === "pages" ? pagesSentence(period) : MEMBERS_SENTENCE
    history.replaceState(null, "", `${location.pathname}${stateSearch({ tab, period })}`)
    const mine = ++loading
    status.textContent = "Loading…"
    try {
      if (tab === "pages") {
        const result = await api(pagesUrl(period))
        if (mine !== loading) return
        board.replaceChildren(
          result.pages.length
            ? rankTable(
                PAGE_COLUMNS,
                result.pages.map((page) => pageCells(page, titles)),
              )
            : h("p", { class: "muted", text: "No member voted on or read a page in this period." }),
        )
      } else {
        const result = await api(membersUrl(period))
        if (mine !== loading) return
        board.replaceChildren(
          result.members.length
            ? rankTable(
                MEMBER_COLUMNS,
                result.members.map((member) => memberCells(member)),
              )
            : h("p", {
                class: "muted",
                text: "Nothing went into the vault, and no page of a member's was voted on or read, in this period.",
              }),
          h("p", { class: "muted", text: membersNotes(result.bulk_files) }),
        )
      }
      status.textContent = ""
    } catch (error) {
      if (mine === loading) status.textContent = `The leaderboard didn't load: ${error.message}`
    }
  }
  tabs.addEventListener("click", (event) => {
    const chosen = event.target.closest("[data-tab]")?.dataset.tab
    if (!chosen || chosen === tab) return
    tab = chosen
    show()
  })
  periods.addEventListener("click", (event) => {
    const chosen = event.target.closest("[data-period]")?.dataset.period
    if (!chosen || chosen === period) return
    period = chosen
    show()
  })
  root.replaceChildren(tabs, intro, periods, status, board)
  await show()
}
