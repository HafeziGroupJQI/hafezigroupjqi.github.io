// The editor's conflict dialog (index.js): another member sent a change to the same page that
// touches some of the same lines as this member's. It names them and when theirs goes in, shows
// their change as a diff (the History's, frontend/page-history/diff.js, drawn by diff2html, which
// escapes every line), and offers the member's choices: edit on top of their version, queue this
// change for the first editor or an admin to settle, or discard it. Everything from the other
// member (their name, their text) is shown as text, never as markup.

import { h } from "../dashboard/dom.js"
import { conflictWords } from "./model.js"

// diff2html's stylesheet, copied into the site by tools/members-bundles.mjs (as the History).
function diffStyles() {
  if (document.querySelector("link[data-diff2html]")) return
  document.head.append(
    h("link", { rel: "stylesheet", href: "/static/diff2html.css", "data-diff2html": true }),
  )
}

/**
 * Open the dialog for a send refused with `kind: "pending"` (worker/src/edit/conflicts.ts).
 * `choose(choice)` is called with "stack", "queue" or "discard" once the member picks; closing it
 * any other way leaves the draft as it was.
 */
export function openConflictDialog(body, { repo, choose }) {
  const words = conflictWords(body, repo)
  const diffBody = h("div", {
    class: "page-history__diff-body",
    text: "Loading their change…",
  })
  const button = (text, choice, className = null) =>
    h("button", {
      type: "button",
      class: className,
      text,
      onclick: () => {
        dialog.close()
        choose(choice)
      },
    })
  const dialog = h(
    "dialog",
    { class: "page-history edit-conflict", "aria-labelledby": "edit-conflict-title" },
    h("h2", { id: "edit-conflict-title", text: words.title }),
    h("p", { text: words.line }),
    h("p", { class: "muted", text: words.theirs }),
    diffBody,
    h(
      "div",
      { class: "editor-actions" },
      button("Edit on top of their version", "stack", "primary"),
      button("Queue for review", "queue"),
      button("Discard my changes", "discard", "danger"),
      h("button", { type: "button", text: "Cancel", onclick: () => dialog.close() }),
    ),
    h("p", { class: "muted", text: words.queue }),
  )
  dialog.addEventListener("close", () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  import("../page-history/diff.js")
    .then(({ diffHtml }) => {
      diffStyles()
      const dark = document.documentElement.getAttribute("saved-theme") === "dark"
      const markup = diffHtml(body.base_text ?? "", body.their_text ?? "", { dark })
      if (markup === null) diffBody.replaceChildren(h("p", { text: "No differences." }))
      // diff2html escapes every line of both versions (page-history/diff.test.mjs): nothing runs.
      else diffBody.innerHTML = markup
    })
    .catch((error) =>
      diffBody.replaceChildren(
        h("p", { role: "alert", text: `Their change can't be shown here: ${error.message}` }),
      ),
    )
  return dialog
}
