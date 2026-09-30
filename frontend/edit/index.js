// /edit: the site's page editor (the Worker's src/edit/). It opens a page's own file in its vault
// as its author wrote it (a Markdown page's .md, a Quarto page's .qmd, a notebook page's .ipynb),
// never the page the site made from it, at main's version, whose blob is the base of the edit.
// Saving keeps a draft on the site that only its author sees (and, as it is typed, a copy in this
// browser); sending it makes it a pull request on the vault, merged by the Worker's hourly run
// once the vault's check passes. If someone else changed the file on main meanwhile, sending is
// refused with their version, and the editor marks each difference to keep or take.

import { slugifyFilePath } from "@quartz-community/utils/path"
import { h, present } from "../dashboard/dom.js"
import { createNotebookEditor } from "./cells.js"
import { openConflictDialog } from "./conflict.js"
import { createSourceEditor } from "./editor.js"
import {
  REPO_LABELS,
  cleanSummary,
  compareWords,
  draftStatus,
  editIntent,
  fileName,
  heldNotice,
  movedNotice,
  lineSeparator,
  othersNotice,
  revertIntent,
  revertNotice,
  besideNote,
  sendHint,
  sendLabel,
  sendRefusal,
  settleNotice,
  stackWords,
  staleNotice,
  startingText,
  storageKey,
} from "./model.js"

/* global fetchData */

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

/** The page's slug on the site, which its links are resolved from. */
function pageSlug(source, page) {
  if (page) return decodeURIComponent(page).replace(/^\/+|\/+$/g, "") || "index"
  const file =
    source.repo === "vault"
      ? source.path.replace(/^content\//, "")
      : `resources/${source.path.replace(/\.(?:qmd|ipynb)$/i, ".md")}`
  return slugifyFilePath(file)
}

const escapeAttribute = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")

// The preview's frame: the site's own stylesheets (and KaTeX's), and nothing that runs. Its
// sandbox allows no scripts; it keeps the site's origin, so the page's images load as they do on
// the page, and its links open in a new tab.
function previewFrame() {
  const styles = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .map((link) => `<link rel="stylesheet" href="${escapeAttribute(link.href)}">`)
    .join("")
  const frame = h("iframe", {
    class: "edit-preview",
    title: "Preview of the page",
    sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    referrerpolicy: "no-referrer",
  })
  frame.srcdoc = `<!doctype html><html lang="en"${themeAttributes()}><head><meta charset="utf-8"><base target="_blank">${styles}<style>body{margin:0;padding:12px 20px;background:var(--light, #fff)}body>div>h1{margin:8px 0 16px;font-size:1.9rem;font-weight:600}.edit-runs{display:inline-block;margin:8px 0 4px;padding:1px 8px;border-radius:10px;background:var(--c-warn-soft, #fff3cd);color:var(--c-warn, #664d03);font-size:.75rem}</style></head><body><div class="page-content__main"><h1></h1><article class="text-content page-body"></article></div></body></html>`
  // The member's theme changed (frontend/theme/): the preview follows.
  document.addEventListener("themechange", () => {
    const html = frame.contentDocument?.documentElement
    if (!html) return
    for (const name of THEME_ATTRIBUTES) {
      const value = document.documentElement.getAttribute(name)
      if (value === null) html.removeAttribute(name)
      else html.setAttribute(name, value)
    }
  })
  return frame
}

// The member's theme on the preview's page as on this one: its attributes and its tokens (set
// inline on <html>).
const THEME_ATTRIBUTES = ["saved-theme", "data-palette", "data-figures", "style"]
const themeAttributes = () =>
  THEME_ATTRIBUTES.map((name) => [name, document.documentElement.getAttribute(name)])
    .filter(([, value]) => value !== null)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("")

export async function mountEdit(root) {
  root.replaceChildren()
  root.classList.add("dashboard", "edit-page")
  const intent = editIntent(location.search)
  // A conflict to settle (/edit?conflict=<id>) has a view of its own (settle.js).
  if (intent.conflict)
    return import("./settle.js").then(({ mountSettle }) => mountSettle(root, intent.conflict))
  const title = h("h1", { class: "dash-title", text: "Edit" })
  root.append(h("header", { class: "dash-header" }, title))
  if (!intent.repo || !intent.path) {
    root.append(h("p", { text: "Open a page and use its Edit button to edit its source here." }))
    return
  }
  const loading = h("p", { class: "muted", text: "Loading…" })
  root.append(loading)
  const got = await call(
    `/api/edit/source?${new URLSearchParams({
      repo: intent.repo,
      path: intent.path,
      ...(intent.new ? { new: "1" } : {}),
    })}`,
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
  let draft = source.draft && { ...source.draft, conflict: source.conflict ?? null }
  let base = draft?.base_sha ?? source.main?.sha
  let saved = { text: draft?.text ?? source.main?.text ?? "", summary: draft?.summary ?? "" }
  let start = startingText(source, browserCopy.read(key))
  // A folder's new page starts from a first text the vault's check takes.
  if (source.new && !draft && !start.restored)
    start = { text: source.template ?? "", restored: false }
  let busy = false
  // From the page's History: a version to restore or a change to undo, opened as a new draft
  // (the Worker's /api/edit/revert). Nothing is saved until the member saves or sends it.
  const wanted = revertIntent(intent)
  let revert = null
  let reverted = null
  if (wanted && !draft) {
    const answer = await call(
      `/api/edit/revert?${new URLSearchParams({
        repo: source.repo,
        path: source.path,
        rev: wanted.rev,
        mode: wanted.mode,
        ...(intent.from ? { from: intent.from } : {}),
      })}`,
    )
    if (answer.ok) {
      reverted = answer.body
      revert = { rev: wanted.rev, mode: wanted.mode }
      base = answer.body.base_sha
      start = { text: answer.body.text, restored: false }
    } else
      reverted = { error: answer.body.detail ?? `That version didn't load (${answer.status}).` }
  }

  title.textContent = source.new ? `New page: ${source.path}` : `Edit ${fileName(source.path)}`
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
  // Conflicts on this page the viewer may settle: they sent the first change, or are an admin.
  for (const conflict of source.to_settle ?? [])
    notice(
      settleNotice(conflict),
      h("a", {
        href: `/edit?${new URLSearchParams({ conflict: conflict.id })}`,
        text: "Settle it",
      }),
    )
  // The member's own change, held until someone settles it: withdrawing it lets them change it.
  let heldNote = null
  const showHeld = () => {
    heldNote?.remove()
    heldNote = null
    if (!draft?.conflict) return
    heldNote = h(
      "div",
      { class: "settings-pending", role: "note" },
      h("p", { text: heldNotice(draft.conflict) }),
      h("button", {
        type: "button",
        text: "Withdraw it",
        onclick: async () => {
          const answer = await call(`/api/edit/conflicts/${draft.conflict.id}/withdraw`, {
            method: "POST",
          })
          if (!answer.ok) return say(answer.body.detail ?? "Withdrawing failed.", true)
          draft = { ...draft, ...answer.body.draft, text: draft.text, conflict: null }
          showHeld()
          say("Withdrawn: it's your draft again. Change it, then send it when you're ready.")
          refresh()
        },
      }),
    )
    notices.append(heldNote)
  }
  if (source.review)
    notice(`An admin merges edits to this file after checking them, since ${source.review}.`)

  const summary = h("input", {
    class: "edit-summary",
    maxlength: 120,
    value: saved.summary,
    placeholder: "What you changed, in a line (it goes into the vault's history)",
    "aria-label": "Summary of your change",
    disabled: !source.can_edit,
  })
  summary.value = revert ? reverted.summary : saved.summary
  const pane = h("div", { class: "edit-source" })
  // Pages are previewed beside their source (on phones, one or the other), a notebook as its
  // Markdown and code.
  const preview = previewFrame()
  const panes = h("div", { class: "edit-panes", "data-view": "source" }, pane, preview)
  const views = h(
    "div",
    { class: "seg edit-views", role: "radiogroup", "aria-label": "Show" },
    ["source", "preview"].map((view) =>
      h("button", {
        type: "button",
        role: "radio",
        "aria-checked": String(view === "source"),
        text: view === "source" ? "Source" : "Preview",
        onclick: (event) => {
          panes.dataset.view = view
          for (const button of event.target.parentElement.children)
            button.setAttribute("aria-checked", String(button === event.target))
        },
      }),
    ),
  )
  const yamlProblems = h("ul", {
    class: "edit-problems",
    "aria-label": "Problems in the front matter",
  })
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
    ...present(views, yamlProblems),
    panes,
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
  // A notebook is edited by its cells (cells.js), anything else as its text.
  const create = source.kind === "ipynb" ? createNotebookEditor : createSourceEditor
  const editor = create(pane, start.text, {
    kind: source.kind,
    separator: lineSeparator(saved.text),
    readOnly: !source.can_edit || Boolean(draft?.conflict),
    onSave: () => void save(),
    onChange: (text) => {
      refresh()
      schedulePreview()
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
  // The preview follows the text, 300 ms after typing stops; the front matter's problems too.
  const slug = pageSlug(source, page)
  const slugs =
    typeof fetchData === "undefined"
      ? Promise.resolve([])
      : fetchData.then((index) => Object.keys(index ?? {})).catch(() => [])
  let previewTimer = null
  // The preview's renderer (unified, KaTeX) loads beside the editor, not before it.
  const previewing = import("./preview.js")
  async function showPreview() {
    const { frontMatterProblems, renderPreview } = await previewing
    const text = editor.getText()
    if (source.kind !== "ipynb")
      yamlProblems.replaceChildren(
        ...frontMatterProblems(text).map((problem) =>
          h("li", { text: `Front matter, line ${problem.line}: ${problem.message}` }),
        ),
      )
    const body = preview?.contentDocument?.querySelector(".page-body")
    if (!body) return
    const notebook = source.kind === "ipynb"
    const markdown = notebook ? editor.previewMarkdown() : text
    const { html, title } = renderPreview(markdown, {
      kind: notebook ? "md" : source.kind,
      repo: source.repo,
      path: source.path,
      slug,
      allSlugs: await slugs,
      origin: location.origin,
    })
    // Sanitized already, and the frame runs no script.
    body.innerHTML = html
    preview.contentDocument.querySelector("h1").textContent = notebook ? "" : title
  }
  function schedulePreview() {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => void showPreview().catch(console.error), 300)
  }
  preview?.addEventListener("load", () => void showPreview().catch(console.error))
  const dirty = () =>
    editor.getText() !== saved.text || cleanSummary(summary.value) !== (saved.summary ?? "")
  let wasHeld = Boolean(draft?.conflict)
  function refresh() {
    const sent = draft?.status === "open" && !draft.unsent
    // A held draft waits as it is; withdrawing it (above) makes it the member's again.
    const held = Boolean(draft?.conflict)
    if (held !== wasHeld) editor.setReadOnly?.(!source.can_edit || held)
    wasHeld = held
    saveButton.disabled = busy || held || !dirty()
    sendButton.disabled = busy || held || (!draft && !dirty()) || (sent && !dirty())
    discardButton.disabled = busy || (!draft && !dirty())
    sendButton.textContent = sendLabel(source.repo, draft)
    stateLine.textContent = dirty() ? "Unsaved changes." : draftStatus(draft)
    // When a send would go in says nothing once it is sent and unchanged.
    hint.hidden = sent && !dirty()
  }
  summary.addEventListener("input", refresh)
  if (wanted && draft) notice("You already have a draft of this page. Finish or discard it first.")
  else if (reverted?.error) notice(reverted.error)
  else if (reverted) {
    notice(revertNotice(reverted))
    // What the revert changes on the page as it is now.
    if (source.main && reverted.text !== source.main.text) {
      editor.compareWith(source.main.text, { keep: "Keep this", take: "Take the current" })
      comparing.hidden = false
      comparing.replaceChildren(
        h("p", { text: "The marks show what this changes on the page as it is now." }),
        h(
          "div",
          { class: "editor-actions" },
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
    }
  }
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
    draft = { ...answer, text, conflict: answer.conflict ?? null }
    base = answer.base_sha ?? base
    saved = { text, summary: answer.summary ?? "" }
    browserCopy.drop(key)
    showProblems(answer.problems)
    refresh()
  }

  async function save({ quiet = false } = {}) {
    if (busy || !source.can_edit || draft?.conflict) return false
    if (draft && !dirty()) return true
    busy = true
    refresh()
    if (!quiet) say("Saving…")
    const text = editor.getText()
    try {
      const answer = draft
        ? await call(`/api/edit/drafts/${draft.id}`, {
            method: "PUT",
            body: JSON.stringify({ text, summary: summary.value, version: draft.version }),
          })
        : await call("/api/edit/drafts", {
            method: "POST",
            body: JSON.stringify({
              repo: source.repo,
              path: source.path,
              ...(source.new ? { new: true } : { base_sha: base }),
              text,
              summary: summary.value,
              ...(revert ? { revert } : {}),
            }),
          })
      if (answer.status === 409 && answer.body.kind === "stale") {
        stale(answer.body)
        return false
      }
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

  // This draft was saved somewhere else since this tab loaded it (another tab or device): the
  // member picks which text stays. Nothing is overwritten until they do.
  let staleNote = null
  function stale(newer) {
    say("You saved a newer version of this draft somewhere else.", true)
    staleNote?.remove()
    staleNote = h(
      "div",
      { class: "settings-pending", role: "alert" },
      h("p", { text: staleNotice(newer) }),
      h("button", {
        type: "button",
        text: "Use that version",
        onclick: () => {
          draft = { ...draft, version: newer.version, edited_at: newer.edited_at, text: newer.text }
          saved = { text: newer.text, summary: newer.summary ?? saved.summary }
          summary.value = saved.summary
          editor.setText(newer.text)
          browserCopy.drop(key)
          staleNote.remove()
          say("This is the version you saved last.")
          refresh()
        },
      }),
      h("button", {
        type: "button",
        text: "Keep this one",
        onclick: () => {
          draft = { ...draft, version: newer.version }
          staleNote.remove()
          void save()
        },
      }),
    )
    notices.append(staleNote)
    staleNote.scrollIntoView({ block: "nearest" })
  }

  // Someone changed the file on main since this draft's base. The Worker merged their changes
  // with the member's where they touch different lines (`text`); the editor marks each place the
  // result differs from main's version, to keep or to take main's, and then main's version
  // becomes the draft's base.
  function compare(incoming, { kind = "main", text = null, stack = null } = {}) {
    if (text !== null && text !== editor.getText()) editor.setText(text)
    const words = stack ? stackWords(stack, source.repo) : compareWords(kind, source.repo)
    editor.compareWith(incoming.text, words.labels)
    comparing.hidden = false
    comparing.replaceChildren(
      h("p", { text: words.message }),
      h(
        "div",
        { class: "editor-actions" },
        h("button", {
          type: "button",
          class: "primary",
          text: words.done,
          onclick: async () => {
            const text = editor.getText()
            const answer = await call(`/api/edit/drafts/${draft.id}`, {
              method: "PUT",
              body: JSON.stringify({
                ...(stack
                  ? { stack_on: stack.draft, stack_sha: stack.sha }
                  : { base_sha: incoming.sha }),
                text,
                summary: summary.value,
                version: draft.version,
              }),
            })
            if (answer.status === 409 && answer.body.kind === "stale") return stale(answer.body)
            if (!answer.ok) return say(answer.body.detail ?? "That didn't save.", true)
            took(answer.body, text)
            editor.compareWith(null)
            comparing.hidden = true
            say(words.after)
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
      return say("Say in a line what you changed first.", true)
    }
    if (!(await save())) return
    busy = true
    refresh()
    say(source.repo === "vault" ? "Publishing…" : "Sending…")
    try {
      const answer = await call(`/api/edit/drafts/${draft.id}/send`, { method: "POST" })
      if (answer.status === 409 && answer.body.kind === "pending") {
        say(sendRefusal(answer.body), true)
        openConflictDialog(answer.body, {
          repo: source.repo,
          choose: (choice) => void chose(choice, answer.body),
        })
      } else if (answer.status === 409 && answer.body.kind === "moved") {
        say(sendRefusal(answer.body), true)
        moved()
      } else if (answer.status === 409 && answer.body.incoming) {
        // Main's version is the newest the page knows of now (Discard goes back to it).
        source.main = { ...answer.body.incoming, size: answer.body.incoming.text.length }
        say(sendRefusal(answer.body), true)
        // Their changes to other lines are merged in already; the rest is the member's to settle.
        compare(answer.body.incoming, {
          kind: answer.body.kind,
          text: answer.body.merged_text ?? answer.body.proposed ?? null,
        })
      } else if (!answer.ok) say(answer.body.detail ?? `Sending failed (${answer.status}).`, true)
      else {
        draft = { ...answer.body, text: draft.text, base_sha: base, conflict: null }
        say(
          (answer.body.pull
            ? `Sent as pull request #${answer.body.pull.number}.`
            : source.repo === "vault"
              ? "Published."
              : "Sent.") + besideNote(answer.body.beside),
        )
      }
    } catch (error) {
      say(error.message, true)
    } finally {
      busy = false
      refresh()
    }
  }

  // The member's choice in the conflict dialog (conflict.js).
  async function chose(choice, body) {
    if (choice === "discard") return discard(false)
    if (choice === "stack")
      return compare(
        { sha: null, text: body.their_text },
        { text: body.proposed ?? null, stack: { ...body.with, sha: body.their_sha } },
      )
    busy = true
    refresh()
    try {
      const answer = await call(`/api/edit/drafts/${draft.id}/queue`, { method: "POST" })
      if (!answer.ok) return say(answer.body.detail ?? `Queueing failed (${answer.status}).`, true)
      draft = { ...draft, ...answer.body.draft, conflict: answer.body.conflict }
      showHeld()
      say("Queued for review.")
    } finally {
      busy = false
      refresh()
    }
  }

  // The page was moved or deleted on main: the member's text is still here to copy.
  let movedNote = null
  function moved() {
    movedNote?.remove()
    movedNote = h(
      "div",
      { class: "settings-pending", role: "alert" },
      h("p", { text: movedNotice() }),
      h("button", {
        type: "button",
        text: "Copy your text",
        onclick: async (event) => {
          try {
            await navigator.clipboard.writeText(editor.getText())
            event.target.textContent = "Copied"
          } catch {
            say("This browser didn't let the page copy: select the text and copy it.", true)
          }
        },
      }),
    )
    notices.append(movedNote)
    movedNote.scrollIntoView({ block: "nearest" })
  }

  async function discard(ask = true) {
    if (
      ask &&
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
    heldNote?.remove()
    say("Discarded.")
    refresh()
  }
  discardButton.onclick = () => void discard()
  saveButton.onclick = () => void save()
  // Ctrl/⌘+S saves from anywhere on the page (the editors handle it themselves first).
  root.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key !== "s") return
    event.preventDefault()
    void save()
  })

  // A draft is saved on the site every two minutes while it has unsaved changes, and leaving the
  // page with some asks first (this browser keeps a copy either way).
  // A text the site filled in (a new folder page's first lines, a restore or an undo) isn't saved
  // by itself: only once the member has changed it, or saves it.
  const offered = (source.new && !draft) || revert ? start.text : null
  setInterval(() => {
    if (source.can_edit && dirty() && !busy && editor.getText() !== offered)
      void save({ quiet: true })
  }, 120_000)
  setInterval(() => {
    hint.textContent = sendHint(source)
  }, 60_000)
  window.addEventListener("beforeunload", (event) => {
    if (source.can_edit && dirty()) event.preventDefault()
  })
  showHeld()
  refresh()
}
