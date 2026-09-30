// /edit: the site's page editor (the Worker's src/edit/). It opens a page's own file in its vault
// as its author wrote it (a Markdown page's .md, a Quarto page's .qmd, a notebook page's .ipynb),
// never the page the site made from it, at main's version, whose blob is the base of the edit.
// Saving keeps a draft on the site that only its author sees (and, as it is typed, a copy in this
// browser); sending it makes it a pull request on the vault, merged by the Worker's hourly run
// once the vault's check passes. If someone else changed the file on main meanwhile, sending is
// refused with their version, and the editor marks each difference to keep or take.

import { h, present } from "../dashboard/dom.js"
import { createSourceEditor } from "./editor.js"
import {
  REPO_LABELS,
  cleanSummary,
  draftStatus,
  editIntent,
  fileName,
  lineSeparator,
  othersNotice,
  sendHint,
  startingText,
  storageKey,
} from "./model.js"

/** A call to the Worker that keeps the answer's body, since a refusal can carry data. */
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

// This browser's copy of unsaved text: a convenience, so a reload or a crash loses nothing. Any
// access can throw (private windows, blocked storage); the editor works without it.
const browserCopy = {
  read(key) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null")
    } catch {
      return null
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  },
  drop(key) {
    try {
      localStorage.removeItem(key)
    } catch {}
  },
}

/** Only a path on this site: the page the editor was opened from. */
const sitePath = (page) => (typeof page === "string" && /^\/(?!\/)/.test(page) ? page : null)

export async function mountEdit(root) {
  root.replaceChildren()
  root.classList.add("dashboard", "edit-page")
  const intent = editIntent(location.search)
  const title = h("h1", { class: "dash-title", text: "Edit" })
  root.append(h("header", { class: "dash-header" }, title))
  if (!intent.repo || !intent.path) {
    root.append(h("p", { text: "Open a page and use its Edit button to edit its source here." }))
    return
  }
  const loading = h("p", { class: "muted", text: "Loading…" })
  root.append(loading)
  const got = await call(
    `/api/edit/source?${new URLSearchParams({ repo: intent.repo, path: intent.path })}`,
  )
  loading.remove()
  if (!got.ok) {
    root.append(
      h("p", {
        class: "dash-error",
        role: "alert",
        text: got.body.detail ?? `The file didn't load (${got.status}).`,
      }),
    )
    return
  }
  const source = got.body
  const key = storageKey(source.repo, source.path)
  let draft = source.draft
  let base = draft?.base_sha ?? source.main?.sha
  let saved = { text: draft?.text ?? source.main?.text ?? "", summary: draft?.summary ?? "" }
  const start = startingText(source, browserCopy.read(key))
  let busy = false

  title.textContent = `Edit ${fileName(source.path)}`
  const page = sitePath(intent.page)
  root.firstChild.append(
    h("p", { class: "dash-summary", text: `${REPO_LABELS[source.repo]} · ${source.path}` }),
  )
  const links = h(
    "p",
    { class: "edit-links" },
    page ? h("a", { href: page, text: "View the page" }) : null,
    h("a", { href: source.github_url, target: "_blank", rel: "noopener", text: "On GitHub" }),
  )

  const notices = h("div", { class: "edit-notices" })
  const notice = (text, ...extra) =>
    notices.append(h("div", { class: "settings-pending", role: "note" }, h("p", { text }), extra))
  if (!source.can_edit) notice(source.why ?? "You can't edit this file.")
  if (intent.note === "generated")
    notice(
      "Parts of this page are made by the site from other pages; here you edit the text around them.",
    )
  if (intent.sha && source.main && intent.sha !== source.main.sha)
    notice(
      "The page you came from was built from an older version of this file: here is the newest, from main.",
    )
  const others = othersNotice(source.others)
  if (others) notice(others)
  if (source.review)
    notice(
      "Something in this file runs when the site builds (its code cells), so an admin merges edits to it after checking them.",
    )

  const summary = h("input", {
    class: "edit-summary",
    maxlength: 120,
    value: saved.summary,
    placeholder: "What you changed, in a line (it goes into the vault's history)",
    "aria-label": "Summary of your change",
    disabled: !source.can_edit,
  })
  summary.value = saved.summary
  const pane = h("div", { class: "edit-source" })
  const status = h("span", { class: "edit-status", role: "status", "aria-live": "polite" })
  const problems = h("ul", {
    class: "edit-problems",
    "aria-label": "Problems the vault's check would find",
  })
  const stateLine = h("p", { class: "muted edit-state", text: draftStatus(draft) })
  const hint = h("p", { class: "muted edit-hint", text: sendHint(source) })
  const saveButton = h("button", { type: "button", text: "Save draft" })
  const sendButton = h("button", { type: "button", class: "primary", text: "Send" })
  const discardButton = h("button", { type: "button", class: "danger", text: "Discard" })
  const actions = h(
    "div",
    { class: "editor-actions edit-actions" },
    saveButton,
    sendButton,
    discardButton,
    status,
  )
  const comparing = h("div", { class: "edit-compare", hidden: true })
  root.append(
    links,
    notices,
    comparing,
    ...present(
      source.can_edit ? h("label", { class: "edit-summary-label" }, "Summary", summary) : null,
    ),
    pane,
    ...present(source.can_edit ? [actions, problems, stateLine, hint] : null),
  )

  const say = (text, error = false) => {
    status.textContent = text
    status.classList.toggle("dash-error", error)
    if (error) status.scrollIntoView({ block: "nearest" })
  }
  const showProblems = (list = []) =>
    problems.replaceChildren(...list.map((problem) => h("li", { text: problem })))

  let copyTimer = null
  const editor = createSourceEditor(pane, start.text, {
    kind: source.kind,
    separator: lineSeparator(saved.text),
    readOnly: !source.can_edit,
    onSave: () => void save(),
    onChange: (text) => {
      refresh()
      clearTimeout(copyTimer)
      copyTimer = setTimeout(
        () =>
          text === saved.text
            ? browserCopy.drop(key)
            : browserCopy.write(key, { text, base, at: Date.now() }),
        500,
      )
    },
  })
  const dirty = () =>
    editor.getText() !== saved.text || cleanSummary(summary.value) !== (saved.summary ?? "")
  function refresh() {
    const sent = draft?.status === "open" && !draft.unsent
    saveButton.disabled = busy || !dirty()
    sendButton.disabled = busy || (!draft && !dirty()) || (sent && !dirty())
    discardButton.disabled = busy || (!draft && !dirty())
    sendButton.textContent = draft?.pull ? "Send the new version" : "Send"
    stateLine.textContent = dirty() ? "Unsaved changes." : draftStatus(draft)
  }
  summary.addEventListener("input", refresh)
  if (start.restored)
    notice(
      "This browser had unsaved changes to this file; they are back in the editor.",
      h("button", {
        type: "button",
        text: "Drop them",
        onclick: (event) => {
          editor.setText(saved.text)
          browserCopy.drop(key)
          event.target.closest(".settings-pending").remove()
        },
      }),
    )

  /** Keep what the Worker said about the draft (its view, with its text and base). */
  const took = (answer, text) => {
    draft = { ...answer, text }
    base = answer.base_sha ?? base
    saved = { text, summary: answer.summary ?? "" }
    browserCopy.drop(key)
    showProblems(answer.problems)
    refresh()
  }

  async function save({ quiet = false } = {}) {
    if (busy || !source.can_edit) return false
    if (draft && !dirty()) return true
    busy = true
    refresh()
    if (!quiet) say("Saving…")
    const text = editor.getText()
    try {
      const answer = draft
        ? await call(`/api/edit/drafts/${draft.id}`, {
            method: "PUT",
            body: JSON.stringify({ text, summary: summary.value }),
          })
        : await call("/api/edit/drafts", {
            method: "POST",
            body: JSON.stringify({
              repo: source.repo,
              path: source.path,
              base_sha: base,
              text,
              summary: summary.value,
            }),
          })
      if (!answer.ok) {
        say(answer.body.detail ?? `Saving failed (${answer.status}).`, true)
        return false
      }
      took(answer.body, text)
      say(answer.body.problems?.length ? "Saved, with problems to fix before sending." : "Saved.")
      return true
    } catch (error) {
      say(error.message, true)
      return false
    } finally {
      busy = false
      refresh()
    }
  }

  // Someone changed the file on main since this draft's base: mark each difference to keep or
  // take, then make main's version the draft's base.
  function compare(incoming) {
    editor.compareWith(incoming.text)
    comparing.hidden = false
    comparing.replaceChildren(
      h("p", {
        text: "Someone changed this file on main since you started. Where your version differs from theirs, keep yours or take theirs; then say you're done, and send it again.",
      }),
      h(
        "div",
        { class: "editor-actions" },
        h("button", {
          type: "button",
          class: "primary",
          text: "I've taken in their changes",
          onclick: async () => {
            const text = editor.getText()
            const answer = await call(`/api/edit/drafts/${draft.id}`, {
              method: "PUT",
              body: JSON.stringify({ base_sha: incoming.sha, text, summary: summary.value }),
            })
            if (!answer.ok) return say(answer.body.detail ?? "That didn't save.", true)
            took(answer.body, text)
            editor.compareWith(null)
            comparing.hidden = true
            say("Your draft is on main's newest version now: send it when you're ready.")
          },
        }),
        h("button", {
          type: "button",
          text: "Stop comparing",
          onclick: () => {
            editor.compareWith(null)
            comparing.hidden = true
          },
        }),
      ),
    )
    comparing.scrollIntoView({ block: "nearest" })
  }
  if (draft && source.main && draft.base_sha !== source.main.sha) {
    notice(
      "This file changed on main since you started your draft.",
      h("button", {
        type: "button",
        text: "Compare with main's version",
        onclick: () => compare(source.main),
      }),
    )
  }

  sendButton.onclick = async () => {
    if (!cleanSummary(summary.value)) {
      summary.focus()
      return say("Say in a line what you changed, then send it.", true)
    }
    if (!(await save())) return
    busy = true
    refresh()
    say("Sending…")
    try {
      const answer = await call(`/api/edit/drafts/${draft.id}/send`, { method: "POST" })
      if (answer.status === 409 && answer.body.incoming) {
        say(answer.body.detail, true)
        compare(answer.body.incoming)
      } else if (!answer.ok) say(answer.body.detail ?? `Sending failed (${answer.status}).`, true)
      else {
        draft = { ...answer.body, text: draft.text, base_sha: base }
        say(answer.body.pull ? `Sent as pull request #${answer.body.pull.number}.` : "Sent.")
      }
    } catch (error) {
      say(error.message, true)
    } finally {
      busy = false
      refresh()
    }
  }

  discardButton.onclick = async () => {
    if (
      !confirm(
        draft?.pull
          ? "Discard your draft? Its pull request closes, and the file stays as it is on main."
          : "Discard your changes? The file stays as it is on main.",
      )
    )
      return
    if (draft) {
      const answer = await call(`/api/edit/drafts/${draft.id}`, { method: "DELETE" })
      if (!answer.ok) return say(answer.body.detail ?? "Discarding failed.", true)
    }
    draft = null
    base = source.main?.sha
    saved = { text: source.main?.text ?? "", summary: "" }
    summary.value = ""
    editor.setText(saved.text)
    browserCopy.drop(key)
    showProblems()
    say("Discarded.")
    refresh()
  }
  saveButton.onclick = () => void save()

  // A draft is saved on the site every two minutes while it has unsaved changes, and leaving the
  // page with some asks first (this browser keeps a copy either way).
  setInterval(() => {
    if (source.can_edit && dirty() && !busy) void save({ quiet: true })
  }, 120_000)
  setInterval(() => {
    hint.textContent = sendHint(source)
  }, 60_000)
  window.addEventListener("beforeunload", (event) => {
    if (source.can_edit && dirty()) event.preventDefault()
  })
  refresh()
}
