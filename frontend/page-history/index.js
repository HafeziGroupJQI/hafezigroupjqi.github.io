// A page's History, under its title beside the Export menu (JqiFrame's [data-page-tools], whose
// data-history is the page's <slug>.history.json; static/page-history.js in both editions): its own
// file's revisions in its vault, newest first, who made each and why, and what changed between any
// two, as a wiki page's history shows it. A public page's history works signed out, its revisions
// read straight from GitHub; a private page's is in the member edition only, its revisions through
// the Worker. Members also see changes to the page waiting to go in, and each author's
// contributions on /recent. #history in the address opens it.

import { h } from "../dashboard/dom.js"
import {
  authorHref,
  commitUrl,
  comparable,
  comparableFile,
  comparePair,
  fileHistoryUrl,
  kindLabel,
  lineCounts,
  revisionUrl,
  versionAt,
  versionBefore,
  revertLinks,
} from "./model.js"

// Signed-in members are shown the member edition (its pages carry .site-internal).
const members = Boolean(document.querySelector(".site-internal"))

const when = (date) =>
  new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

async function getOk(url, what, init = {}) {
  let response
  try {
    response = await fetch(url, init)
  } catch {
    throw new Error(navigator.onLine ? `${what} did not load` : "you are offline")
  }
  if (!response.ok) throw new Error(`${what} did not load (${response.status})`)
  return response
}

// A version of the file, fetched once: a file at a commit never changes.
const texts = new Map()
function textOf(repo, version) {
  if (!version) return Promise.resolve("")
  const key = `${repo}:${version.commit}:${version.path}`
  if (!texts.has(key))
    texts.set(
      key,
      getOk(
        revisionUrl(repo, version.commit, version.path),
        `${version.path} as of ${version.commit.slice(0, 7)}`,
        { cache: "force-cache" },
      )
        .then((response) => response.text())
        .catch((error) => {
          texts.delete(key)
          throw error
        }),
    )
  return texts.get(key).then((text) => comparable(version.path, text))
}

// diff2html's stylesheet, copied into the site by tools/members-bundles.mjs.
function diffStyles() {
  if (document.querySelector("link[data-diff2html]")) return
  document.head.append(
    h("link", { rel: "stylesheet", href: "/static/diff2html.css", "data-diff2html": true }),
  )
}

function historyDialog(url, edit = {}) {
  const title = h("h2", { id: "page-history-title", text: "History" })
  const close = h("button", {
    type: "button",
    class: "page-history__close",
    "aria-label": "Close the history",
    text: "×",
  })
  const place = h("p", { class: "page-history__place" })
  const status = h("p", { class: "page-history__status", role: "status" })
  const pending = h("div", { class: "page-history__pending" })
  const list = h("ol", { class: "page-history__list" })
  const compare = h("button", { type: "submit", text: "Compare the selected revisions" })
  const hint = h("p", {
    class: "page-history__status",
    text: "See the changes one revision made, or compare any two: pick one in the left column to compare from and one in the right to compare to.",
  })
  const form = h("form", { class: "page-history__form", hidden: true }, hint, list, compare)
  const revisions = h("div", {}, pending, status, form)
  // One comparison at a time, in place of the list, which Back returns to where it was.
  const back = h("button", { type: "button", text: "← All revisions" })
  const diffTitle = h("strong")
  let sideBySide = false
  const layout = h("button", { type: "button", text: "Side by side" })
  const diffBody = h("div", { class: "page-history__diff-body" })
  const diff = h(
    "section",
    { class: "page-history__diff", hidden: true, "aria-label": "Comparison" },
    h("div", { class: "page-history__diff-head" }, back, diffTitle, layout),
    diffBody,
  )
  const dialog = h(
    "dialog",
    { class: "page-history", "aria-labelledby": "page-history-title" },
    h("header", {}, title, close),
    place,
    revisions,
    diff,
  )
  close.addEventListener("click", () => dialog.close())
  // A click on the backdrop closes it too (the dialog itself is the target of both).
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return
    const box = dialog.getBoundingClientRect()
    const x = event.clientX
    const y = event.clientY
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) dialog.close()
  })
  dialog.addEventListener("close", () => {
    if (location.hash === "#history")
      history.replaceState(history.state, "", location.pathname + location.search)
  })

  let page = null
  let shown = null
  // The comparison asked for last: one still loading when another is asked for is dropped.
  let asked = 0
  let listScroll = 0
  back.addEventListener("click", () => {
    asked++
    shown = null
    diff.hidden = true
    revisions.hidden = false
    dialog.scrollTop = listScroll
  })
  const showDiff = async (before, after, label) => {
    const mine = ++asked
    if (!revisions.hidden) listScroll = dialog.scrollTop
    shown = [before, after, label]
    revisions.hidden = true
    diff.hidden = false
    dialog.scrollTop = 0
    back.focus()
    diffTitle.textContent = label
    layout.textContent = sideBySide ? "Line by line" : "Side by side"
    diffBody.replaceChildren(h("p", { class: "page-history__status", text: "Loading…" }))
    try {
      const [old, now, { diffHtml }] = await Promise.all([
        textOf(page.repo, before),
        textOf(page.repo, after),
        import("./diff.js"),
      ])
      if (mine !== asked) return
      diffStyles()
      const dark = document.documentElement.getAttribute("saved-theme") === "dark"
      const markup = diffHtml(old, now, { sideBySide, dark })
      if (markup === null) diffBody.replaceChildren(h("p", { text: "No differences." }))
      // diff2html escapes every line of both versions (diff.test.mjs): nothing in them runs.
      else diffBody.innerHTML = markup
    } catch (error) {
      if (mine === asked)
        diffBody.replaceChildren(h("p", { role: "alert", text: `Can't compare: ${error.message}` }))
    }
  }
  layout.addEventListener("click", () => {
    sideBySide = !sideBySide
    if (shown) showDiff(...shown)
  })

  const row = (revision, index, all) => {
    const at = when(revision.date)
    const author = authorHref(revision, { members })
    const counts = lineCounts(revision)
    const action = (text, before, after, label, disabled = false) =>
      h("button", {
        type: "button",
        class: "page-history__action",
        text,
        disabled: disabled ? true : null,
        onclick: () => showDiff(before, after, label),
      })
    const compares = comparableFile(page.path)
    return h(
      "li",
      { class: `page-history__revision page-history__revision--${revision.kind}` },
      compares &&
        h(
          "span",
          { class: "page-history__pick" },
          h("input", {
            type: "radio",
            name: "older",
            value: index,
            "aria-label": `Compare from ${at}`,
            checked: index === 1 || (all.length === 1 && index === 0) ? true : null,
          }),
          h("input", {
            type: "radio",
            name: "newer",
            value: index,
            "aria-label": `Compare to ${at}`,
            checked: index === 0 ? true : null,
          }),
        ),
      h(
        "div",
        { class: "page-history__entry" },
        h(
          "div",
          {},
          h("time", { datetime: revision.date, text: at }),
          " · ",
          author ? h("a", { href: author, text: revision.author }) : revision.author,
          " · ",
          h("span", { class: "page-history__kind", text: kindLabel(revision) }),
          counts ? h("span", { class: "page-history__counts", text: counts }) : null,
        ),
        revision.summary
          ? h("div", { class: "page-history__summary", text: revision.summary })
          : null,
        h(
          "div",
          { class: "page-history__actions" },
          compares &&
            action(
              "Changes made",
              versionBefore(revision),
              versionAt(revision),
              `What changed on ${at}`,
            ),
          compares &&
            action(
              "Compare with now",
              versionAt(revision),
              versionAt(all[0]),
              `From ${at} to now`,
              index === 0 || revision.kind === "delete",
            ),
          // Members: open this version, or the page without this change, in the editor.
          ...(members
            ? revertLinks(revision, index, edit, location.pathname).map((link) =>
                h("a", { class: "page-history__action", href: link.href, text: link.label }),
              )
            : []),
          h("a", {
            href: commitUrl(page.repo, revision.commit, page.github),
            text: revision.commit.slice(0, 7),
            title: "The commit on GitHub",
            rel: "noopener",
          }),
        ),
      ),
    )
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const a = Number(data.get("older"))
    const b = Number(data.get("newer"))
    if (a === b) {
      status.textContent = "Pick two different revisions to compare."
      return
    }
    status.textContent = ""
    const [before, after] = comparePair(page.revisions, a, b)
    const [older, newer] = a > b ? [a, b] : [b, a]
    showDiff(
      before,
      after,
      `From ${when(page.revisions[older].date)} to ${when(page.revisions[newer].date)}`,
    )
  })

  const load = async () => {
    status.textContent = "Loading…"
    try {
      page = await (await getOk(url, "the page's history", { cache: "no-cache" })).json()
    } catch (error) {
      status.textContent = `The history didn't load: ${error.message}`
      page = null
      return
    }
    const name = page.path.split("/").pop()
    title.textContent = `History of ${name}`
    place.replaceChildren(
      page.repo === "vault" ? "Public vault: " : "Private vault: ",
      h("code", { text: page.path }),
      " · ",
      h("a", {
        href: fileHistoryUrl(page.repo, page.path, page.github),
        text: "on GitHub",
        rel: "noopener",
      }),
      ...(members ? [" · ", h("a", { href: "/recent", text: "recent changes" })] : []),
    )
    list.replaceChildren(...page.revisions.map((revision, i) => row(revision, i, page.revisions)))
    form.hidden = page.revisions.length === 0
    compare.hidden = !comparableFile(page.path) || page.revisions.length < 2
    if (!comparableFile(page.path))
      hint.textContent =
        "Wolfram notebooks aren't compared here: each revision links to its commit on GitHub."
    status.textContent = page.revisions.length
      ? page.more
        ? `The newest ${page.revisions.length} revisions; older ones are on GitHub.`
        : ""
      : "No revisions recorded yet."
    if (members) showPending(page)
  }

  // Members: sent changes to this file that haven't gone in yet (worker/src/changes.ts).
  const showPending = async ({ repo, path }) => {
    try {
      const query = new URLSearchParams({ repo, path, state: "sent,review,failed,conflict" })
      const { changes } = await (
        await getOk(`/api/changes?${query}&limit=10`, "changes waiting to go in", {
          cache: "no-store",
        })
      ).json()
      pending.replaceChildren(
        ...changes.map((change) =>
          h(
            "p",
            { class: "page-history__waiting" },
            `${change.author} sent a change on ${when(change.at)}: `,
            {
              sent: "it goes in at the end of its hour, once the vault's check passes",
              review: "an admin merges it",
              failed: "the vault's check failed",
              conflict: "it's waiting to be settled, since another change touches the same lines",
            }[change.state] ?? change.state,
            change.pull ? " (" : "",
            change.pull
              ? h("a", { href: change.pull.url, text: `pull request #${change.pull.number}` })
              : "",
            change.pull ? ")" : "",
          ),
        ),
      )
    } catch {
      pending.replaceChildren()
    }
  }

  return { dialog, load, loaded: () => page !== null }
}

export function mountPageHistory(tools) {
  const url = tools.dataset.history
  if (!url) return
  const button = h("button", {
    type: "button",
    class: "page-history-button",
    "aria-haspopup": "dialog",
    text: "History",
  })
  tools.append(button)
  let panel = null
  const open = () => {
    if (!panel) {
      panel = historyDialog(url, tools.dataset)
      document.body.append(panel.dialog)
    }
    if (!panel.dialog.open) panel.dialog.showModal()
    if (location.hash !== "#history") history.replaceState(history.state, "", "#history")
    if (!panel.loaded()) panel.load()
  }
  button.addEventListener("click", open)
  if (location.hash === "#history") open()
}

const tools = document.querySelector("[data-page-tools][data-history]")
if (tools) mountPageHistory(tools)
