// Hafezi GPT dialogs: project editor (instructions, topics, pinned pages, files), chat sharing,
// and the skills library. All use the site's <dialog class="member-editor"> styling.
import { h } from "../dashboard/dom.js"
import { formatTokens } from "../admin/model.js"

function dialog(title, ...body) {
  const node = h("dialog", { class: "member-editor gpt-dialog" }, h("h2", { text: title }), ...body)
  document.body.append(node)
  node.addEventListener("close", () => node.remove())
  node.showModal()
  return node
}

const alert = () => h("p", { role: "alert" })

const TOPIC_ROOTS = [
  ["project", "Projects"],
  ["research", "Research areas"],
  ["equipment", "Equipment"],
  ["code", "Code"],
  ["library", "Library"],
  ["onboarding", "Onboarding"],
]

const topicLabel = (tag) => tag.split("/").slice(1).join("/").replace(/-/g, " ")

/** Create or edit a project. Resolves with the saved project, `null` when deleted, or undefined. */
export function editProject(gpt, boot, existing = null) {
  return new Promise((resolve) => {
    const p = existing ?? {
      name: "",
      description: "",
      instructions: "",
      visibility: "private",
      topics: [],
      pinned: [],
      default_model: null,
    }
    const topics = new Set(p.topics)
    const pinned = [...p.pinned]
    const form = h("form", { class: "gpt-project-form" })
    const status = alert()
    const field = (label, control, hint) =>
      h(
        "label",
        {},
        label,
        control,
        hint ? h("span", { class: "muted gpt-hint", text: hint }) : null,
      )
    const name = h("input", {
      name: "name",
      required: true,
      maxlength: 120,
      value: p.name,
      placeholder: "e.g. TFLN combs",
    })
    const description = h("input", {
      name: "description",
      maxlength: 500,
      value: p.description,
      placeholder: "One line: what this project is for",
    })
    const instructions = h("textarea", {
      name: "instructions",
      rows: 5,
      maxlength: 20000,
      placeholder:
        "How Hafezi GPT should work in this project: goals, conventions, what to prioritize, output format…",
    })
    instructions.value = p.instructions
    const visibility = h(
      "select",
      { name: "visibility" },
      h("option", { value: "private", text: "Private: only me" }),
      h("option", { value: "group", text: "Group: every lab member can use it and add files" }),
    )
    visibility.value = p.visibility
    const modelSelect = h(
      "select",
      { name: "default_model" },
      h("option", { value: "", text: `Default (${boot.models[0].label})` }),
      boot.models.map((m) => h("option", { value: m.id, text: m.label })),
    )
    modelSelect.value = p.default_model ?? ""

    // Topics: the site's tag scopes. Every page carrying the tag is loaded into the project.
    const topicBox = h("div", { class: "gpt-topics" })
    for (const [root, label] of TOPIC_ROOTS) {
      const values = boot.topics[root] ?? []
      if (!values.length) continue
      topicBox.append(
        h(
          "fieldset",
          {},
          h("legend", { text: label }),
          values.slice(0, 24).map((t) => {
            const box = h("input", {
              type: "checkbox",
              value: t.tag,
              checked: topics.has(t.tag) || null,
            })
            box.onchange = () => (box.checked ? topics.add(t.tag) : topics.delete(t.tag))
            return h(
              "label",
              { class: "gpt-topic" },
              box,
              `${topicLabel(t.tag)} `,
              h("span", { class: "muted", text: String(t.count) }),
            )
          }),
        ),
      )
    }

    // Pinned pages: always in context, found with the same lookup as @-mentions.
    const pinnedList = h("div", { class: "gpt-chips" })
    const pinSearch = h("input", {
      type: "search",
      placeholder: "Search pages to pin…",
      autocomplete: "off",
    })
    const pinResults = h("ul", {
      class: "gpt-popup gpt-popup--inline",
      role: "listbox",
      hidden: true,
    })
    const renderPinned = () =>
      pinnedList.replaceChildren(
        ...pinned.map((slug) =>
          h(
            "span",
            { class: "gpt-chip gpt-chip--removable" },
            slug,
            h("button", {
              type: "button",
              text: "×",
              "aria-label": `Unpin ${slug}`,
              onclick: () => (pinned.splice(pinned.indexOf(slug), 1), renderPinned()),
            }),
          ),
        ),
      )
    let ticket = 0
    pinSearch.oninput = async () => {
      const q = pinSearch.value.trim()
      const mine = ++ticket
      if (!q) return (pinResults.hidden = true)
      const results = (await gpt.pages(q).catch(() => [])).filter((r) => r.kind === "page")
      if (mine !== ticket) return
      pinResults.hidden = !results.length
      pinResults.replaceChildren(
        ...results.map((r) =>
          h(
            "li",
            {
              class: "gpt-option",
              role: "option",
              onmousedown: (e) => {
                e.preventDefault()
                if (!pinned.includes(r.ref)) pinned.push(r.ref)
                pinSearch.value = ""
                pinResults.hidden = true
                renderPinned()
              },
            },
            h("span", { class: "gpt-option-title", text: r.title }),
            h("span", { class: "gpt-option-hint muted", text: r.ref }),
          ),
        ),
      )
    }
    renderPinned()

    // Files and the knowledge meter only exist once the project does.
    const filesBox = h("div", { class: "gpt-project-files" })
    if (existing) {
      const k = existing.knowledge
      const note = k
        ? `${k.included.length} sources in context, about ${formatTokens(k.tokens)} tokens${k.overflow.length ? `; ${k.overflow.length} more over the limit are read on demand` : ""}.`
        : ""
      const list = h("ul", { class: "gpt-file-list" })
      const renderFiles = (files) =>
        list.replaceChildren(
          ...(files.length
            ? files.map((f) =>
                h(
                  "li",
                  {},
                  h("a", { href: gpt.fileUrl(f.id), target: "_blank", text: f.name }),
                  h("span", { class: "muted", text: ` ${formatTokens(f.tokens_est)} tokens` }),
                  existing.can_edit || f.owner === boot.me
                    ? h("button", {
                        type: "button",
                        class: "gpt-link-button",
                        text: "Remove",
                        onclick: async () => {
                          await gpt.deleteFile(f.id).catch((e) => (status.textContent = e.message))
                          files = files.filter((x) => x !== f)
                          renderFiles(files)
                        },
                      })
                    : null,
                ),
              )
            : [h("li", { class: "muted", text: "No files yet." })]),
        )
      renderFiles(existing.files ?? [])
      const upload = h("input", { type: "file", multiple: true, hidden: true })
      upload.onchange = async () => {
        for (const file of upload.files) {
          try {
            const saved = await gpt.upload(
              `projects/${encodeURIComponent(existing.id)}/files`,
              file,
            )
            existing.files = [...(existing.files ?? []), saved]
            renderFiles(existing.files)
          } catch (e) {
            status.textContent = e.message
          }
        }
        upload.value = ""
      }
      filesBox.append(
        h("h3", { text: "Files" }),
        h("p", {
          class: "muted",
          text: "Text and code files join the project's context; PDFs and images are read when asked about.",
        }),
        list,
        upload,
        h("button", { type: "button", text: "Upload files", onclick: () => upload.click() }),
        note ? h("p", { class: "muted", text: note }) : null,
      )
    }

    form.append(
      field("Name", name),
      field("Description", description),
      field(
        "Instructions",
        instructions,
        "Always included at the start of every chat in this project.",
      ),
      h("h3", { text: "Knowledge" }),
      h("p", {
        class: "muted",
        text: "Pick topics to load every page with that tag, and pin individual pages.",
      }),
      topicBox,
      h("label", {}, "Pinned pages", pinSearch, pinResults),
      pinnedList,
      filesBox,
      h(
        "div",
        { class: "gpt-row" },
        field("Who can use it", visibility),
        field("Default model", modelSelect),
      ),
      status,
      h(
        "div",
        { class: "editor-actions" },
        h("button", {
          type: "submit",
          class: "primary",
          text: existing ? "Save" : "Create project",
        }),
        existing?.can_edit
          ? h("button", {
              type: "button",
              class: "danger",
              text: "Delete project",
              onclick: async () => {
                if (
                  !confirm(
                    `Delete “${existing.name}”? Its files are removed; its chats stay in your history.`,
                  )
                )
                  return
                try {
                  await gpt.deleteProject(existing.id)
                  resolved = null
                  node.close()
                } catch (e) {
                  status.textContent = e.message
                }
              },
            })
          : null,
        h("button", { type: "button", text: "Cancel", onclick: () => node.close() }),
      ),
    )

    let resolved
    const node = dialog(existing ? `Project: ${existing.name}` : "New project", form)
    node.addEventListener("close", () => resolve(resolved))
    form.onsubmit = async (event) => {
      event.preventDefault()
      try {
        resolved = await gpt.saveProject(existing?.id, {
          name: name.value,
          description: description.value,
          instructions: instructions.value,
          visibility: visibility.value,
          topics: [...topics],
          pinned,
          default_model: modelSelect.value || null,
        })
        node.close()
      } catch (e) {
        status.textContent = e.message
      }
    }
    name.focus()
  })
}

/** Share a chat with the whole lab or specific members; revoke; copy the link. */
export async function shareChat(gpt, boot, conversation) {
  let shares = await gpt.conversation(conversation.id).then((d) => d.shares)
  const status = alert()
  const list = h("ul", { class: "gpt-share-list" })
  const everyone = h("input", { type: "checkbox" })
  const who = h("input", { list: "gpt-members", placeholder: "GitHub login", autocomplete: "off" })
  const members = h(
    "datalist",
    { id: "gpt-members" },
    boot.members.map((m) => h("option", { value: m })),
  )
  const link = `${location.origin}/gpt?c=${encodeURIComponent(conversation.id)}`
  const render = () => {
    everyone.checked = shares.some((s) => s.grantee === "*")
    const people = shares.filter((s) => s.grantee !== "*")
    list.replaceChildren(
      ...(people.length
        ? people.map((s) =>
            h(
              "li",
              {},
              h("strong", { class: "mono", text: s.grantee }),
              h("button", {
                type: "button",
                class: "gpt-link-button",
                text: "Remove",
                onclick: () => change(() => gpt.unshare(conversation.id, s.grantee)),
              }),
            ),
          )
        : [h("li", { class: "muted", text: "Not shared with anyone individually." })]),
    )
  }
  const change = async (action) => {
    try {
      const result = await action()
      shares = Array.isArray(result) ? result : shares
      status.textContent = ""
      render()
    } catch (e) {
      status.textContent = e.message
    }
  }
  everyone.onchange = () =>
    change(() =>
      everyone.checked ? gpt.share(conversation.id, "*") : gpt.unshare(conversation.id, "*"),
    )
  const add = h(
    "form",
    {
      class: "gpt-row",
      onsubmit: (e) => {
        e.preventDefault()
        const login = who.value.trim()
        if (login) change(() => gpt.share(conversation.id, login)).then(() => (who.value = ""))
      },
    },
    who,
    members,
    h("button", { type: "submit", text: "Share" }),
  )
  const copy = h("button", {
    type: "button",
    text: "Copy link",
    onclick: async () => {
      await navigator.clipboard?.writeText(link)
      copy.textContent = "Link copied"
    },
  })
  const node = dialog(
    `Share “${conversation.title}”`,
    h("p", {
      class: "muted",
      text: "People you share with can read this chat (and its uploads) and continue it in a copy of their own. They can't add to yours.",
    }),
    h("label", { class: "gpt-topic" }, everyone, "Share with the whole lab"),
    add,
    list,
    status,
    h(
      "div",
      { class: "editor-actions" },
      copy,
      h("button", { type: "button", text: "Done", onclick: () => node.close() }),
    ),
  )
  render()
  return new Promise((resolve) => node.addEventListener("close", () => resolve(shares)))
}

/** Browse skills; write, edit or delete your own. Resolves when closed (skills may have changed). */
export async function skillLibrary(gpt, boot) {
  const status = alert()
  const list = h("div", { class: "gpt-skill-list" })
  const node = dialog(
    "Skills",
    h(
      "p",
      { class: "muted" },
      "Skills are reusable procedures. Hafezi GPT uses one when a request matches its description, or when you type ",
      h("code", { text: "/name" }),
      ". Built-in skills live in the private vault under ",
      h("code", { text: "gpt/skills/" }),
      ".",
    ),
    list,
    status,
    h(
      "div",
      { class: "editor-actions" },
      h("button", {
        type: "button",
        class: "primary",
        text: "New skill",
        onclick: () => edit(null),
      }),
      h("button", { type: "button", text: "Close", onclick: () => node.close() }),
    ),
  )
  async function refresh() {
    const skills = await gpt.skills()
    boot.skills = skills
    list.replaceChildren(
      ...skills.map((s) =>
        h(
          "details",
          { class: "gpt-skill" },
          h(
            "summary",
            {},
            h("code", { text: `/${s.name}` }),
            " ",
            h("span", {
              class: "muted",
              text:
                s.source === "repo"
                  ? "built-in"
                  : `${s.visibility === "group" ? "shared" : "private"} · ${s.owner}`,
            }),
          ),
          h("p", { text: s.description }),
          h("pre", { class: "gpt-skill-body", text: s.body }),
          s.source === "member" && (s.owner === boot.me || boot.isAdmin)
            ? h(
                "div",
                { class: "editor-actions" },
                h("button", { type: "button", text: "Edit", onclick: () => edit(s) }),
                h("button", {
                  type: "button",
                  class: "danger",
                  text: "Delete",
                  onclick: async () => {
                    if (!confirm(`Delete /${s.name}?`)) return
                    await gpt.deleteSkill(s.id).catch((e) => (status.textContent = e.message))
                    refresh()
                  },
                }),
              )
            : null,
        ),
      ),
    )
  }
  function edit(skill) {
    const name = h("input", {
      required: true,
      pattern: "[a-z0-9]+(-[a-z0-9]+)*",
      maxlength: 64,
      value: skill?.name ?? "",
      placeholder: "fit-ring-resonance",
    })
    const description = h("textarea", {
      required: true,
      rows: 2,
      maxlength: 1024,
      placeholder: "What it does and when to use it",
    })
    description.value = skill?.description ?? ""
    const body = h("textarea", {
      required: true,
      rows: 10,
      maxlength: 40000,
      placeholder: "Step-by-step instructions (Markdown)",
    })
    body.value = skill?.body ?? ""
    const visibility = h(
      "select",
      {},
      h("option", { value: "private", text: "Private" }),
      h("option", { value: "group", text: "Shared with the lab" }),
    )
    visibility.value = skill?.visibility ?? "private"
    const err = alert()
    const form = h(
      "form",
      {},
      h("label", {}, "Name", name),
      h("label", {}, "Description", description),
      h("label", {}, "Instructions", body),
      h("label", {}, "Visibility", visibility),
      err,
      h(
        "div",
        { class: "editor-actions" },
        h("button", { type: "submit", class: "primary", text: "Save" }),
        h("button", { type: "button", text: "Cancel", onclick: () => inner.close() }),
      ),
    )
    const inner = dialog(skill ? `Edit /${skill.name}` : "New skill", form)
    form.onsubmit = async (e) => {
      e.preventDefault()
      try {
        await gpt.saveSkill(skill?.id, {
          name: name.value,
          description: description.value,
          body: body.value,
          visibility: visibility.value,
        })
        inner.close()
        refresh()
      } catch (error) {
        err.textContent = error.message
      }
    }
  }
  await refresh()
  return new Promise((resolve) => node.addEventListener("close", resolve))
}
