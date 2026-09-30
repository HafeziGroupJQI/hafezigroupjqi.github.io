// /edit?conflict=<id>: settle a conflict between two members' changes to one page (the Worker's
// src/edit/conflicts.ts). Only the member who sent the first change, or an admin, may settle it.
// The editor starts from the two changes merged, the second's lines winning where both changed
// the same ones, and marks where that differs from the first change's version, each to keep or
// to take the first's. The settler keeps the first change (the second goes back to its author),
// takes the second, or saves the merged text as it stands; the result goes in after a full hour.

import { h } from "../dashboard/dom.js"
import { createNotebookEditor } from "./cells.js"
import { createSourceEditor } from "./editor.js"
import { fileName, lineSeparator, settleWords } from "./model.js"

async function call(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  })
  if (response.status === 401) {
    location.assign("/auth/login?next=" + encodeURIComponent(location.pathname + location.search))
    throw new Error("Your session expired. Please sign in again.")
  }
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, body }
}

export async function mountSettle(root, id) {
  const title = h("h1", { class: "dash-title", text: "Settle a conflict" })
  root.append(h("header", { class: "dash-header" }, title))
  const got = await call(`/api/edit/conflicts/${encodeURIComponent(id)}`)
  if (!got.ok) {
    root.append(
      h("p", {
        class: "dash-error",
        role: "alert",
        text: got.body.detail ?? `The conflict didn't load (${got.status}).`,
      }),
    )
    return
  }
  const detail = got.body
  const { conflict } = detail
  const words = settleWords(detail)
  title.textContent = `Settle a conflict on ${fileName(conflict.path)}`
  root.firstChild.append(h("p", { class: "dash-summary", text: conflict.path }))
  const status = h("span", { class: "edit-status", role: "status", "aria-live": "polite" })
  const say = (text, error = false) => {
    status.textContent = text
    status.classList.toggle("dash-error", error)
  }
  root.append(h("div", { class: "edit-notices" }, ...words.lines.map((text) => h("p", { text }))))
  if (!detail.can_settle || conflict.state !== "open") {
    root.append(h("p", { class: "muted", text: words.closed }))
    return
  }
  const pane = h("div", { class: "edit-source" })
  root.append(h("div", { class: "edit-panes", "data-view": "source" }, pane))
  const create = conflict.kind === "ipynb" ? createNotebookEditor : createSourceEditor
  const editor = create(pane, detail.proposed, {
    kind: conflict.kind,
    separator: lineSeparator(detail.first_text),
    readOnly: false,
  })
  editor.compareWith(detail.first_text, words.labels)
  const problems = h("ul", { class: "edit-problems", "aria-label": "Why it wasn't settled" })
  const settle = async (choice) => {
    for (const button of buttons.querySelectorAll("button")) button.disabled = true
    say("Settling…")
    const answer = await call(`/api/edit/conflicts/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify(choice === "merged" ? { choice, text: editor.getText() } : { choice }),
    })
    if (!answer.ok) {
      for (const button of buttons.querySelectorAll("button")) button.disabled = false
      problems.replaceChildren()
      return say(answer.body.detail ?? `Settling failed (${answer.status}).`, true)
    }
    say(words.done[choice])
    editor.setReadOnly?.(true)
  }
  const buttons = h(
    "div",
    { class: "editor-actions edit-actions" },
    h("button", { type: "button", text: words.first, onclick: () => void settle("first") }),
    h("button", { type: "button", text: words.second, onclick: () => void settle("second") }),
    h("button", {
      type: "button",
      class: "primary",
      text: "Save this merged text",
      onclick: () => void settle("merged"),
    }),
    status,
  )
  root.append(buttons, problems, h("p", { class: "muted edit-hint", text: words.when }))
}
