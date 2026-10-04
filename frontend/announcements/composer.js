// The admins' announcement composer on /announcements (index.js loads it for admins only): a title,
// the text in CodeMirror with the editor kit (frontend/editor-kit/: the formatting toolbar, and
// [[ page links completed as the site's paths), attachments by the toolbar's Attach, by dropping
// or pasting files into the text (each is uploaded first, the announcement saved as a draft the
// first time, then a Markdown image or link to it goes where it was dropped), a live preview, and
// the saves that fit where it stands: publish now, schedule (in this browser's time zone, kept as
// UTC ms), save as a draft, or keep a live one live.

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { EditorState } from "@codemirror/state"
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view"
import { h } from "../dashboard/dom.js"
import { codeLanguage } from "../edit/editor.js"
import { editorKit, formatToolbar } from "../editor-kit/index.js"
import { editorChrome, highlighting } from "../theme/highlight.js"
import {
  MAX_TITLE,
  attachmentMarkdown,
  composerActions,
  fromLocalInput,
  saveBody,
  saveProblem,
  sizeLabel,
  statusOf,
  statusText,
  timeZoneName,
  toLocalInput,
  tooBig,
} from "./model.js"
import { renderAnnouncement } from "./render.js"

const ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,.txt,.md,.csv,.tsv,.json,.py,.m,.jl,.tex,.bib,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf"

const theme = EditorView.theme({
  "&": { fontSize: "0.92rem", backgroundColor: "var(--light, #fff)", height: "100%" },
  ".cm-scroller": {
    fontFamily: "var(--codeFont, ui-monospace, monospace)",
    lineHeight: "1.55",
    minHeight: "240px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { padding: "10px 12px" },
  ".cm-placeholder": { color: "var(--c-muted, #777)" },
})

/** A file upload: the Worker's answer, or an Error with its words. */
async function sendFile(id, file) {
  const form = new FormData()
  form.append("file", file)
  const response = await fetch(`/api/announcements/${encodeURIComponent(id)}/files`, {
    method: "POST",
    cache: "no-store",
    body: form,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.detail ?? `${file.name} could not be attached.`)
  return body
}

export function createComposer(host, { api, onSaved }) {
  let current = null // the announcement being edited, once it is saved
  let files = []
  let saved = { title: "", body_md: "" }
  let busy = false

  const heading = h("h2", { text: "New announcement" })
  const state = h("p", { class: "muted announcement-compose-state" })
  const title = h("input", {
    class: "announcement-compose-title",
    maxlength: MAX_TITLE,
    placeholder: "Title",
    "aria-label": "Title",
    autocomplete: "off",
  })
  const editorBox = h("div", { class: "announcement-compose-editor" })
  const previewTitle = h("h3", { class: "announcement-preview-title" })
  const previewBody = h("div", { class: "announcement-body text-content" })
  const preview = h(
    "div",
    { class: "announcement-compose-preview", "aria-label": "Preview", role: "region" },
    h("p", { class: "announcement-compose-label", text: "Preview" }),
    previewTitle,
    previewBody,
  )
  const fileList = h("ul", { class: "announcement-compose-files", "aria-label": "Attachments" })
  const picker = h("input", {
    type: "file",
    multiple: true,
    accept: ACCEPT,
    hidden: true,
    onchange: () => {
      const chosen = [...picker.files]
      picker.value = ""
      void attach(chosen, null)
    },
  })
  const status = h("p", { class: "announcement-compose-status", role: "status" })
  const actions = h("div", { class: "editor-actions announcement-compose-actions" })
  const when = h("input", { type: "datetime-local", "aria-label": "Goes live at" })
  const scheduleRow = h(
    "div",
    { class: "announcement-schedule", hidden: true },
    h("label", {}, "Goes live at ", when),
    h("span", { class: "muted", text: `Your time: ${timeZoneName()}` }),
    h("button", {
      type: "button",
      class: "primary",
      text: "Schedule",
      onclick: () => void save("schedule"),
    }),
    h("button", {
      type: "button",
      text: "Cancel",
      onclick: () => {
        scheduleRow.hidden = true
      },
    }),
  )
  const reset = h("button", {
    type: "button",
    class: "announcement-compose-new",
    text: "New announcement",
    onclick: () => {
      if (dirty() && !confirm("Drop the changes you haven't saved?")) return
      edit(null)
    },
  })

  const view = new EditorView({
    parent: editorBox,
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        drawSelection(),
        markdown({ base: markdownLanguage, codeLanguages: codeLanguage }),
        highlighting,
        editorChrome,
        editorKit({ mode: "site" }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        placeholder(
          "Write in Markdown: **bold**, _italic_, [[ to link a page, $math$, > [!note] callouts. Drop or paste files to attach them.",
        ),
        EditorView.contentAttributes.of({ "aria-label": "Text of the announcement" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changed()
        }),
        // Files dropped or pasted into the text are attached where they land.
        EditorView.domEventHandlers({
          drop(event, editor) {
            const dropped = [...(event.dataTransfer?.files ?? [])]
            if (!dropped.length) return false
            event.preventDefault()
            const at = editor.posAtCoords({ x: event.clientX, y: event.clientY })
            void attach(dropped, at)
            return true
          },
          paste(event) {
            const pasted = [...(event.clipboardData?.files ?? [])]
            if (!pasted.length) return false
            event.preventDefault()
            void attach(pasted, null)
            return true
          },
        }),
        theme,
      ],
    }),
  })
  const toolbar = formatToolbar(view, {
    label: "Format the announcement",
    onAttach: () => picker.click(),
  })
  editorBox.prepend(toolbar.element)

  host.replaceChildren(
    h(
      "section",
      { class: "announcement-composer", "aria-labelledby": "announcement-composer-title" },
      h("div", { class: "announcement-composer__head" }, heading, reset),
      state,
      title,
      h("div", { class: "announcement-compose-panes" }, editorBox, preview),
      fileList,
      picker,
      actions,
      scheduleRow,
      status,
    ),
  )
  heading.id = "announcement-composer-title"

  const fields = () => ({ title: title.value.replace(/\s+/g, " ").trim(), body_md: text() })
  const text = () => view.state.doc.toString()
  const dirty = () => title.value.trim() !== saved.title || text() !== saved.body_md
  const say = (words, error = false) => {
    status.textContent = words
    status.classList.toggle("dash-error", error)
  }

  let previewTimer = null
  async function showPreview() {
    previewTitle.textContent = title.value.trim() || "(no title yet)"
    previewBody.innerHTML = text().trim() ? await renderAnnouncement(text()) : ""
  }
  function changed() {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => void showPreview().catch(console.error), 300)
    drawActions()
  }
  title.addEventListener("input", changed)

  function drawActions() {
    const stand = current ? statusOf(current) : undefined
    actions.replaceChildren(
      ...composerActions(stand).map(({ action, label }, i) =>
        h("button", {
          type: "button",
          class: i === 0 ? "primary" : null,
          text: label,
          disabled: busy || (action === "keep" && !dirty()),
          "aria-expanded": action === "schedule" ? String(!scheduleRow.hidden) : null,
          onclick: () => {
            if (action !== "schedule") return void save(action)
            scheduleRow.hidden = !scheduleRow.hidden
            if (!scheduleRow.hidden) {
              const at =
                current?.publish_at && current.publish_at > Date.now()
                  ? current.publish_at
                  : Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000
              when.value = toLocalInput(at)
              when.min = toLocalInput(Date.now())
              when.focus()
            }
            drawActions()
          },
        }),
      ),
    )
  }

  function drawFiles() {
    fileList.replaceChildren(
      ...files.map((file) =>
        h(
          "li",
          {},
          h("a", { href: file.url, target: "_blank", rel: "noopener", text: file.name }),
          h("span", { class: "muted", text: ` ${sizeLabel(file.size)}` }),
          h("button", {
            type: "button",
            text: "Insert",
            "aria-label": `Insert ${file.name} into the text`,
            onclick: () => insert(attachmentMarkdown(file), null),
          }),
          h("button", {
            type: "button",
            class: "danger",
            text: "Remove",
            "aria-label": `Remove ${file.name}`,
            onclick: () => void removeFile(file),
          }),
        ),
      ),
    )
  }

  /** Put `snippet` at `at` (or the cursor) on a line of its own when it is an image. */
  function insert(snippet, at) {
    const pos = at ?? view.state.selection.main.head
    const line = view.state.doc.lineAt(pos)
    const block = snippet.startsWith("!")
    const before = block && pos > line.from ? "\n" : ""
    const after = block && pos < line.to ? "\n" : ""
    const insertText = `${before}${snippet}${after}`
    view.dispatch({
      changes: { from: pos, insert: insertText },
      selection: { anchor: pos + insertText.length },
      scrollIntoView: true,
    })
    view.focus()
  }

  /** The announcement's id, saving it as a draft first when it has none yet. */
  async function ensureSaved() {
    if (current) return current.id
    const created = await api("/api/announcements", {
      method: "POST",
      body: JSON.stringify({ ...fields(), publish_at: null }),
    })
    took(created)
    void onSaved?.()
    return created.id
  }

  async function attach(chosen, at) {
    if (!chosen.length) return
    const refused = chosen.map(tooBig).filter(Boolean)
    if (refused.length) return say(refused.join(" "), true)
    busy = true
    drawActions()
    try {
      const id = await ensureSaved()
      for (const file of chosen) {
        say(`Uploading ${file.name}…`)
        const stored = await sendFile(id, file)
        files.push(stored)
        drawFiles()
        insert(attachmentMarkdown(stored), at)
        at = null // the next one goes after it
      }
      say(chosen.length === 1 ? `Attached ${chosen[0].name}.` : `Attached ${chosen.length} files.`)
    } catch (error) {
      say(error.message, true)
    } finally {
      busy = false
      drawActions()
    }
  }

  async function removeFile(file) {
    if (!confirm(`Remove ${file.name}? Links to it in the text stop working.`)) return
    try {
      await api(file.url, { method: "DELETE" })
      files = files.filter((other) => other.id !== file.id)
      drawFiles()
      say(`Removed ${file.name}.`)
    } catch (error) {
      say(error.message, true)
    }
  }

  /** Keep what the Worker answered for the announcement. */
  function took(announcement) {
    current = announcement
    files = announcement.files ?? files
    saved = { title: announcement.title, body_md: announcement.body_md }
    heading.textContent = `Edit: ${announcement.title || "untitled draft"}`
    reset.hidden = false
    state.textContent = statusText(announcement)
    drawFiles()
    drawActions()
  }

  async function save(action) {
    const scheduledAt = action === "schedule" ? fromLocalInput(when.value) : null
    const problem = saveProblem(fields(), action, scheduledAt)
    if (problem) return say(problem, true)
    busy = true
    drawActions()
    say("Saving…")
    try {
      const body = JSON.stringify(saveBody(fields(), action, scheduledAt))
      const answer = current
        ? await api(`/api/announcements/${encodeURIComponent(current.id)}`, { method: "PUT", body })
        : await api("/api/announcements", { method: "POST", body })
      scheduleRow.hidden = true
      const done = statusOf(answer)
      if (action === "now" || action === "schedule") {
        // Out of the composer: it's on the list now, with its status.
        edit(null)
        say(
          done === "live"
            ? `Published “${answer.title}”: members see it on their next page.`
            : `${statusText(answer)}: “${answer.title}”.`,
        )
      } else {
        took(answer)
        say(done === "draft" ? "Saved as a draft: only admins see it." : "Saved.")
      }
      await onSaved?.()
    } catch (error) {
      say(error.message, true)
    } finally {
      busy = false
      drawActions()
    }
  }

  /** Start a new announcement (null), or edit `announcement`. */
  function edit(announcement) {
    current = null
    files = []
    saved = { title: "", body_md: "" }
    scheduleRow.hidden = true
    title.value = announcement?.title ?? ""
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: announcement?.body_md ?? "" },
    })
    if (announcement) took(announcement)
    else {
      heading.textContent = "New announcement"
      reset.hidden = true
      state.textContent = "Only admins see it until you publish it."
      drawFiles()
      drawActions()
    }
    say("")
    void showPreview().catch(console.error)
    if (announcement) {
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches
      host.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" })
      title.focus({ preventScroll: true })
    }
  }

  // Leaving with unsaved text asks first.
  window.addEventListener("beforeunload", (event) => {
    if (dirty()) event.preventDefault()
  })

  edit(null)
  return { edit, editing: () => current?.id ?? null }
}
