// /recent, the members' Recently modified page: every change to the site's pages and files in both
// vaults, newest first, from the Worker's changes table (worker/src/changes.ts). It holds each
// commit to either vault (imported on every deploy) and what members do on the site as they do it
// (a draft sent, merged, refused or discarded; a People page published from Settings), so it is
// the site's recent changes, like MediaWiki's, and ?user=<login> is one member's contributions.
// The build's list of the public vault's pages (tools/recent-changes.mjs) stays until this loads.
// Its second tab, Contributions, is the leaderboard: each member's score for the week, the month or
// all time (GET /api/changes/scores), each name linking to that member's contributions.

import { h } from "../dashboard/dom.js"
import { PERIODS, scoreTitle } from "../leaderboard/model.js"
import { rankTable } from "../leaderboard/table.js"
import {
  KINDS,
  REPOS,
  SCORE_COLUMNS,
  SCORE_SENTENCE,
  STATES,
  dayLabel,
  describe,
  feedUrl,
  filtersOf,
  lineCounts,
  scoreCells,
  scoreNotes,
  scoresUrl,
  searchOf,
  stateLabel,
  viewOf,
  viewSearch,
} from "./model.js"

/* global fetchData */

const time = (at) =>
  h("time", {
    datetime: new Date(at).toISOString(),
    text: new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  })

const link = (href, text, attributes = {}) => h("a", { href, text, ...attributes })

function row(change, titles) {
  const { verb, text, href, after } = describe(change, titles)
  const who = change.login
    ? link(`/recent${searchOf({ user: change.login })}`, change.author, {
        title: `${change.author}'s contributions`,
      })
    : h("span", { text: change.author })
  const state = stateLabel(change.state)
  const counts = lineCounts(change)
  const links = [
    href && change.slug ? link(`${href}#history`, "history") : null,
    change.commit ? link(change.commit.url, "commit", { rel: "noopener" }) : null,
    change.pull ? link(change.pull.url, `pull request #${change.pull.number}`) : null,
  ].filter(Boolean)
  return h(
    "li",
    { class: `recent-change recent-change--${change.state}` },
    h(
      "div",
      {},
      time(change.at),
      " ",
      who,
      ` ${verb} `,
      href ? link(href, text, { class: "internal" }) : h("span", { class: "recent-file", text }),
      after ? ` ${after}` : "",
      change.repo === "vault-private" ? h("span", { class: "recent-badge", text: "private" }) : "",
      state ? h("span", { class: `status status-${change.state}`, text: state }) : "",
    ),
    h(
      "div",
      { class: "recent-meta" },
      [
        counts ? h("span", { class: "recent-counts", text: counts }) : null,
        change.summary ? h("span", { class: "recent-summary", text: change.summary }) : null,
        ...links,
      ]
        .filter(Boolean)
        .flatMap((node, i) => (i ? [" · ", node] : [node])),
    ),
  )
}

function select(name, options, value, label) {
  return h(
    "label",
    {},
    h("span", { text: label }),
    h(
      "select",
      { name },
      options.map(([key, text]) =>
        h("option", { value: key, text, selected: key === value ? true : null }),
      ),
    ),
  )
}

/** The leaderboard for a period: a table of members by score, or a line when there is none. */
function scoreTable(board) {
  if (!board.members.length)
    return h("p", { class: "muted", text: "No changes went into the vault in this period." })
  return rankTable(
    SCORE_COLUMNS,
    board.members.map((member) =>
      scoreCells(member).map((text, index) =>
        index === 1
          ? {
              text,
              href: `/recent${searchOf({ user: member.login })}`,
              title: `${text}'s contributions`,
            }
          : index === 2
            ? { text, title: scoreTitle(member) }
            : text,
      ),
    ),
  )
}

export async function mountRecent(root, { api }) {
  const fallback = [...root.childNodes]
  let filters = filtersOf(location.search)
  const titles = typeof fetchData === "undefined" ? {} : await fetchData.catch(() => ({}))
  const heading = h("h2", { class: "recent-heading" })
  const status = h("p", { class: "recent-status", role: "status", "aria-live": "polite" })
  const list = h("ol", { class: "recent-feed" })
  const more = h("button", { type: "button", class: "recent-more", text: "Older changes" })
  const user = h("input", {
    name: "user",
    value: filters.user,
    placeholder: "GitHub login",
    autocomplete: "off",
    spellcheck: "false",
  })
  const form = h(
    "form",
    { class: "recent-filters", role: "search" },
    h("label", {}, h("span", { text: "Member" }), user),
    select("repo", REPOS, filters.repo, "Vault"),
    select("kind", KINDS, filters.kind, "Kind"),
    select("state", STATES, filters.state, "State"),
    h("button", { type: "submit", text: "Show" }),
  )
  // The two tabs: the feed of changes, and the leaderboard.
  let { view, period } = viewOf(location.search)
  const tab = (key, text) => h("button", { type: "button", role: "tab", "data-view": key, text })
  const tabs = h(
    "div",
    { class: "recent-tabs", role: "tablist", "aria-label": "Recently modified" },
    tab("changes", "Changes"),
    tab("contributions", "Contributions"),
  )
  const periods = h(
    "div",
    { class: "recent-tabs recent-periods", role: "group", "aria-label": "Period" },
    PERIODS.map(([key, text]) => h("button", { type: "button", "data-period": key, text })),
  )
  const board = h("div", {})
  const scores = h(
    "section",
    { class: "recent-contributions", role: "tabpanel" },
    h("p", { text: SCORE_SENTENCE }),
    periods,
    board,
  )
  const intro = h("p", {
    class: "muted",
    text: "Every change to the site's pages and files, newest first: members' edits, uploads and People pages as they send them, and each commit to either vault. Pick a member for their contributions.",
  })
  let next = null
  let lastDay = null
  let loading = 0

  const show = async (append = false) => {
    const mine = ++loading
    more.disabled = true
    status.textContent = "Loading…"
    try {
      const page = await api(feedUrl(filters, append ? next : null))
      if (mine !== loading) return
      if (!append) {
        list.replaceChildren()
        lastDay = null
      }
      for (const change of page.changes) {
        const day = dayLabel(change.at)
        if (day !== lastDay) list.append(h("li", { class: "recent-day", text: day }))
        lastDay = day
        list.append(row(change, titles))
      }
      // A member's contributions go by their name once a change shows it.
      if (filters.user && page.changes.length)
        heading.textContent = `Contributions by ${page.changes[0].author}`
      next = page.next
      more.hidden = !next
      status.textContent = list.children.length
        ? ""
        : filters.user || filters.repo || filters.kind || filters.state
          ? "No changes match these filters."
          : "No changes yet: each deploy of the members site adds the vaults' commits."
      // The build's list goes once the live one has loaded.
      for (const node of fallback) node.remove()
      fallback.length = 0
    } catch (error) {
      if (mine === loading) status.textContent = `The live list didn't load: ${error.message}`
    } finally {
      if (mine === loading) more.disabled = false
    }
  }

  const apply = () => {
    const data = new FormData(form)
    filters = filtersOf(new URLSearchParams([...data].map(([key, value]) => [key, String(value)])))
    history.replaceState(null, "", `${location.pathname}${searchOf(filters)}`)
    heading.textContent = filters.user ? `Contributions by ${filters.user}` : "All changes"
    show()
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    apply()
  })
  for (const field of form.querySelectorAll("select")) field.addEventListener("change", apply)
  more.addEventListener("click", () => show(true))
  more.hidden = true
  heading.textContent = filters.user ? `Contributions by ${filters.user}` : "All changes"

  const showScores = async () => {
    const mine = ++loading
    status.textContent = "Loading…"
    try {
      const result = await api(scoresUrl(period))
      if (mine !== loading) return
      board.replaceChildren(
        scoreTable(result),
        h("p", { class: "muted", text: scoreNotes(result.bulk_files) }),
      )
      status.textContent = ""
      for (const node of fallback) node.remove()
      fallback.length = 0
    } catch (error) {
      if (mine === loading) status.textContent = `The leaderboard didn't load: ${error.message}`
    }
  }
  // Show one tab: its parts, its address, and its data.
  const showView = () => {
    const contributions = view === "contributions"
    for (const button of tabs.children)
      button.setAttribute("aria-selected", String(button.dataset.view === view))
    for (const button of periods.children)
      button.setAttribute("aria-pressed", String(button.dataset.period === period))
    for (const node of [intro, form, heading, list]) node.hidden = contributions
    scores.hidden = !contributions
    if (contributions) more.hidden = true
    history.replaceState(null, "", `${location.pathname}${viewSearch({ view, period }, filters)}`)
    return contributions ? showScores() : show()
  }
  tabs.addEventListener("click", (event) => {
    const chosen = event.target.closest("[data-view]")?.dataset.view
    if (!chosen || chosen === view) return
    view = chosen
    showView()
  })
  periods.addEventListener("click", (event) => {
    const chosen = event.target.closest("[data-period]")?.dataset.period
    if (!chosen || chosen === period) return
    period = chosen
    showView()
  })
  root.prepend(tabs, intro, form, heading, scores, status, list, more)
  await showView()
}
