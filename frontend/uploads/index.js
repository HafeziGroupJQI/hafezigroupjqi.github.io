// /uploads: a member's uploads to the private vault (the Worker's src/uploads/). A draft is one
// change set: files added to a folder, new versions of files, files moved or deleted. Sending it
// makes a draft pull request on GitHub (its diff is the review), and the Worker's hourly run
// merges it at the end of the hour after it was last sent once the vault's check passes, so it
// can be revised or discarded until then. Files are picked with the browser's own file input or
// dropped on it: uploads are single requests of at most 25 MB, so a library like Uppy (resumable
// uploads, remote sources) would add weight and nothing the Worker could use.
import { h, present } from "../dashboard/dom.js"
import { editUrl } from "../edit/link.js"
import {
  changeLabel,
  crumbs,
  draftForPage,
  draftName,
  fileProblem,
  folderOf,
  formatBytes,
  intentOf,
  isLive,
  joinPath,
  replaceProblem,
  replaceDraft,
  statusLabel,
  statusTarget,
} from "./model.js"

export async function mountUploads(root, { api }) {
  root.replaceChildren()
  root.classList.add("dashboard", "uploads-page")
  root.append(
    h(
      "header",
      { class: "dash-header" },
      h("h1", { class: "dash-title", text: "Uploads" }),
      h("p", {
        class: "dash-summary",
        text: "Add, replace, move or delete files in the private vault",
      }),
    ),
  )
  const status = h("p", { class: "uploads-status", role: "status", "aria-live": "polite" })
  const list = h("section", { class: "settings-section", "aria-labelledby": "uploads-drafts" })
  const editor = h("section", { class: "settings-section", "aria-labelledby": "uploads-draft" })
  root.append(status, list, editor)
  // An open draft's messages go beside its actions (showDraft keeps this line there), where the
  // member is looking, not at the top of the page, off screen once the draft is open.
  const draftStatus = h("p", { class: "uploads-status", role: "status", "aria-live": "polite" })

  let state
  let current = null // the draft being edited
  let folder = ""
  const say = (text, error = false) => {
    const line = statusTarget(current) === "draft" ? draftStatus : status
    for (const other of [status, draftStatus]) if (other !== line) other.textContent = ""
    line.textContent = text
    line.classList.toggle("dash-error", error)
    line.setAttribute("role", error ? "alert" : "status")
    if (error && text && line.isConnected) line.scrollIntoView({ block: "nearest" })
  }
  const fail = (error) => say(error.message, true)

  try {
    state = await api("/api/uploads")
  } catch (error) {
    fail(error)
    return
  }
  if (!state.ready) {
    list.replaceChildren(
      h("p", { text: "Uploading from the site isn't set up yet. Ask an admin." }),
    )
    return
  }

  async function reload() {
    state = await api("/api/uploads")
    showList()
  }

  function showList() {
    const live = state.drafts.filter(isLive)
    const done = state.drafts.filter((draft) => !isLive(draft))
    const card = (draft) =>
      h(
        "li",
        { class: `cmd-card${draft.id === current?.id ? " uploads-current" : ""}` },
        h(
          "header",
          {},
          h("strong", { text: draftName(draft) }),
          h("span", { class: "spacer" }),
          draft.pull
            ? h("a", {
                href: draft.pull.url,
                target: "_blank",
                rel: "noopener",
                text: `Pull request #${draft.pull.number}`,
              })
            : null,
          // A page edit is changed in the editor (frontend/edit/), an upload here.
          isLive(draft)
            ? draft.kind === "edit"
              ? h("a", {
                  class: "btn",
                  href: editUrl({ repo: draft.repo, path: draft.path }),
                  text: "Open in the editor",
                })
              : h("button", { type: "button", text: "Open", onclick: () => open(draft.id) })
            : null,
        ),
        h("p", { class: "muted", text: statusLabel(draft) }),
        h("p", {
          class: "muted",
          text: `${draft.changes.length} ${draft.changes.length === 1 ? "change" : "changes"}${draft.bytes ? `, ${formatBytes(draft.bytes)}` : ""}`,
        }),
      )
    list.replaceChildren(
      ...present(
        h("h2", { id: "uploads-drafts", text: "Your drafts" }),
        h("p", {
          class: "muted",
          text: `Each draft becomes a pull request on GitHub when you send it. It is merged into the vault at the end of the hour after you last sent it, once the vault's check passes, so you have at least an hour to change or discard it. Files of up to ${formatBytes(state.limits.file)}, ${state.limits.changes} changes per draft.`,
        }),
        h(
          "ul",
          { class: "admin-list uploads-drafts" },
          live.length ? live.map(card) : h("li", { class: "dash-empty", text: "No drafts open." }),
        ),
        h("button", {
          type: "button",
          class: "primary",
          text: "New draft",
          disabled: live.length >= state.limits.drafts,
          onclick: () =>
            create()
              .then((draft) => open(draft.id))
              .catch(fail),
        }),
        done.length
          ? h(
              "details",
              {},
              h("summary", { text: `Merged and discarded (${done.length})` }),
              h("ul", { class: "admin-list" }, done.map(card)),
            )
          : null,
      ),
    )
  }

  async function create() {
    const draft = await api("/api/uploads/drafts", { method: "POST", body: "{}" })
    await reload()
    return draft
  }

  async function open(id, at = folder) {
    say("")
    current = await api(`/api/uploads/drafts/${id}`)
    folder = at
    const url = new URL(location.href)
    url.search = `?draft=${id}`
    history.replaceState(history.state, "", url)
    showList()
    await showDraft()
    editor.scrollIntoView({ block: "start" })
  }

  // Apply a change to the draft and show the result.
  // The draft as the Worker answered a change to it, on its card too: its changes, size and
  // state show there at once, not only once it is sent.
  function keep(draft) {
    current = draft
    state.drafts = replaceDraft(state.drafts, draft)
    showList()
  }

  async function change(request, done = "") {
    try {
      keep({ ...(await request()), check: current.check })
      say(done)
    } catch (error) {
      fail(error)
    }
    await showDraft()
  }

  const draftPath = (part = "") => `/api/uploads/drafts/${current.id}${part}`

  function upload(path, file, mode) {
    return api(`${draftPath("/file")}?${new URLSearchParams({ path, mode })}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    })
  }

  async function addFiles(files, listing) {
    const names = new Set(listing.filter((e) => e.type === "file").map((e) => e.name))
    const problems = []
    let i = 0
    for (const file of files) {
      i++
      const problem = fileProblem(file, state)
      if (problem) {
        problems.push(problem)
        continue
      }
      const path = joinPath(folder, file.name)
      const replace = names.has(file.name)
      if (replace && !confirm(`${path} is already in the vault. Replace it with the new file?`))
        continue
      say(`Uploading ${file.name} (${i} of ${files.length})…`)
      try {
        keep({ ...(await upload(path, file, replace ? "replace" : "add")), check: null })
      } catch (error) {
        problems.push(`${file.name}: ${error.message}`)
      }
    }
    say(problems.join(" · "), problems.length > 0)
    await showDraft()
  }

  function moveDialog(from) {
    const input = h("input", {
      value: from,
      required: true,
      spellcheck: "false",
      "aria-label": "New path in the vault",
    })
    const dialog = h(
      "dialog",
      { class: "member-editor", "aria-labelledby": "uploads-move-title" },
      h("h2", { id: "uploads-move-title", text: "Move or rename" }),
      h(
        "form",
        {
          method: "dialog",
          onsubmit: (event) => {
            event.preventDefault()
            dialog.close()
            if (input.value.trim() === from) return
            void change(
              () =>
                api(draftPath("/changes"), {
                  method: "POST",
                  body: JSON.stringify({ action: "rename", from, to: input.value.trim() }),
                }),
              `Moving ${from} is part of the draft now.`,
            )
          },
        },
        h("p", { class: "muted", text: `${from} moves to (the folder and the name, same type):` }),
        input,
        h(
          "div",
          { class: "editor-actions" },
          h("button", { type: "submit", text: "Move" }),
          h("button", { type: "button", text: "Cancel", onclick: () => dialog.close() }),
        ),
      ),
    )
    dialog.addEventListener("close", () => dialog.remove())
    document.body.append(dialog)
    dialog.showModal()
    input.select()
  }

  function replaceInput(path, label = `Choose the new version of ${path}`) {
    return h(
      "label",
      { class: "uploads-pick" },
      label,
      h("input", {
        type: "file",
        onchange: (event) => {
          const [file] = event.target.files
          if (!file) return
          const problem = replaceProblem(file, path, state)
          if (problem) return say(problem, true)
          say(`Uploading ${file.name}…`)
          void change(
            () => upload(path, file, "replace"),
            `The new ${path} is part of the draft now.`,
          )
        },
      }),
    )
  }

  async function showDraft() {
    if (!current) return editor.replaceChildren()
    const draft = current
    const live = isLive(draft)
    const heading = h("h2", { id: "uploads-draft", text: draftName(draft) })
    const facts = h(
      "div",
      { class: "settings-pending" },
      h("p", { text: statusLabel(draft) }),
      draft.pull
        ? h("a", { href: draft.pull.url, target: "_blank", rel: "noopener", text: "Pull request" })
        : null,
      draft.check?.url || draft.detail?.url
        ? h("a", {
            href: draft.check?.url ?? draft.detail.url,
            target: "_blank",
            rel: "noopener",
            text: draft.status === "conflict" ? "See on GitHub" : "The vault's check",
          })
        : null,
      draft.merge
        ? h("a", { href: draft.merge.url, target: "_blank", rel: "noopener", text: "The commit" })
        : null,
    )
    const note = h("textarea", {
      rows: 2,
      maxlength: 1000,
      "aria-label": "A note for the pull request",
      placeholder: "What is this, and why? (goes into the pull request)",
      disabled: !live,
    })
    note.value = draft.note
    const noteForm = h(
      "form",
      {
        class: "uploads-note",
        onsubmit: (event) => {
          event.preventDefault()
          void change(
            () => api(draftPath(), { method: "PATCH", body: JSON.stringify({ note: note.value }) }),
            "Note saved.",
          )
        },
      },
      note,
      live ? h("button", { type: "submit", text: "Save note" }) : null,
    )
    const changes = h(
      "ul",
      { class: "uploads-changes" },
      draft.changes.length
        ? draft.changes.map((item) =>
            h(
              "li",
              {},
              h("span", { text: changeLabel(item) }),
              item.review
                ? h("span", { class: "uploads-review", text: ` · ${item.review}` })
                : null,
              item.action === "add" || item.action === "replace"
                ? h("a", {
                    href: `${draftPath("/file")}?${new URLSearchParams({ path: item.path })}`,
                    target: "_blank",
                    rel: "noopener",
                    text: "View",
                  })
                : null,
              live
                ? h("button", {
                    type: "button",
                    class: "link",
                    text: "Take out",
                    "aria-label": `Take out: ${changeLabel(item)}`,
                    onclick: () =>
                      change(
                        () =>
                          api(
                            `${draftPath("/changes")}?${new URLSearchParams({ path: item.path })}`,
                            {
                              method: "DELETE",
                            },
                          ),
                        `${item.path} is out of the draft.`,
                      ),
                  })
                : null,
            ),
          )
        : h("li", {
            class: "muted",
            text: "No changes yet: add files below, or move or delete some.",
          }),
    )
    const actions = live
      ? h(
          "div",
          { class: "editor-actions" },
          h("button", {
            type: "button",
            class: "primary",
            text: draft.pull ? "Send the new version" : "Send to GitHub",
            disabled:
              !draft.changes.length || (draft.pull && !draft.unsent && draft.status === "open"),
            onclick: () =>
              change(
                () => api(draftPath("/send"), { method: "POST" }),
                "Sent. The pull request is on GitHub; the vault's check runs now.",
              ).then(reload),
          }),
          h("button", {
            type: "button",
            class: "danger",
            text: "Discard draft",
            onclick: () => {
              if (
                !confirm("Discard this draft? Its pull request closes and its files are dropped.")
              )
                return
              void change(() => api(draftPath(), { method: "DELETE" }), "Discarded.").then(reload)
            },
          }),
        )
      : null
    editor.replaceChildren(
      ...present(
        heading,
        facts,
        noteForm,
        h("h3", { text: "Changes" }),
        changes,
        actions,
        draftStatus,
        live ? await browser() : null,
      ),
    )
  }

  // The vault's folders at main: where new files go, and which files to replace, move or delete.
  async function browser() {
    const section = h("div", { class: "uploads-browser" })
    let listing
    try {
      listing = await api(`/api/uploads/folder?${new URLSearchParams({ path: folder })}`)
    } catch (error) {
      return h("p", { class: "dash-error", role: "alert", text: error.message })
    }
    const go = (path) => {
      folder = path
      void showDraft()
    }
    const trail = h(
      "nav",
      { class: "uploads-crumbs", "aria-label": "Folder" },
      crumbs(folder).flatMap((crumb, i, all) =>
        i === all.length - 1
          ? h("strong", { text: crumb.name })
          : [
              h("button", {
                type: "button",
                class: "link",
                text: crumb.name,
                onclick: () => go(crumb.path),
              }),
              " / ",
            ],
      ),
    )
    const inDraft = new Set(current.changes.flatMap((c) => [c.path, c.from]))
    const rows = listing.entries.map((entry) =>
      h(
        "li",
        {},
        entry.type === "folder"
          ? h("button", {
              type: "button",
              class: "link",
              text: `${entry.name}/`,
              onclick: () => go(entry.path),
            })
          : h("span", { text: entry.name }),
        entry.size != null ? h("span", { class: "muted", text: formatBytes(entry.size) }) : null,
        h("span", { class: "spacer" }),
        entry.changeable && !inDraft.has(entry.path)
          ? [
              replaceInput(entry.path, "Replace…"),
              h("button", { type: "button", text: "Move…", onclick: () => moveDialog(entry.path) }),
              h("button", {
                type: "button",
                text: "Delete",
                onclick: () => {
                  if (!confirm(`Delete ${entry.path} from the vault when this draft merges?`))
                    return
                  void change(
                    () =>
                      api(draftPath("/changes"), {
                        method: "POST",
                        body: JSON.stringify({ action: "delete", path: entry.path }),
                      }),
                    `Deleting ${entry.path} is part of the draft now.`,
                  )
                },
              }),
            ]
          : entry.type === "file" && inDraft.has(entry.path)
            ? h("span", { class: "muted", text: "in this draft" })
            : null,
      ),
    )
    section.append(
      ...present(
        h("h3", { text: "The vault" }),
        trail,
        folder && !listing.exists
          ? h("p", { class: "muted", text: "A new folder: the files you add here create it." })
          : null,
        h("ul", { class: "uploads-files" }, rows),
      ),
    )
    if (folder) {
      const input = h("input", {
        type: "file",
        multiple: true,
        onchange: (event) => void addFiles([...event.target.files], listing.entries),
      })
      const zone = h(
        "div",
        { class: "uploads-drop" },
        h("label", {}, `Add files to ${folder}/ `, input),
        h("p", { class: "muted", text: "or drop them here" }),
      )
      zone.addEventListener("dragover", (event) => {
        event.preventDefault()
        zone.classList.add("dragging")
      })
      zone.addEventListener("dragleave", () => zone.classList.remove("dragging"))
      zone.addEventListener("drop", (event) => {
        event.preventDefault()
        zone.classList.remove("dragging")
        void addFiles([...event.dataTransfer.files], listing.entries)
      })
      section.append(
        zone,
        h("button", {
          type: "button",
          class: "link",
          text: "New folder here…",
          onclick: () => {
            const name = prompt("Name of the new folder")?.trim()
            if (name) go(joinPath(folder, name))
          },
        }),
      )
    } else section.append(h("p", { class: "muted", text: "Open a folder to add files to it." }))
    return section
  }

  showList()
  // A page's tools send members here to replace or move that page's file (?replace=, ?rename=),
  // and a folder page's to add files to its folder (?folder=).
  const intent = intentOf(location.search)
  try {
    if (intent.replace || intent.rename) {
      const path = intent.replace ?? intent.rename
      const target = draftForPage(state.drafts) ?? (await create())
      await open(target.id, folderOf(path))
      if (intent.rename) moveDialog(path)
      else editor.prepend(h("div", { class: "settings-pending" }, replaceInput(path)))
    } else if (intent.folder) {
      // A folder page's "Upload to this folder": the newest unsent draft, opened at that folder.
      const target = draftForPage(state.drafts) ?? (await create())
      await open(target.id, intent.folder)
    } else if (intent.draft && state.drafts.some((d) => d.id === intent.draft && isLive(d)))
      await open(intent.draft)
  } catch (error) {
    fail(error)
  }
}
