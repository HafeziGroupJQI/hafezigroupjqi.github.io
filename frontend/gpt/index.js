// /gpt: Hafezi GPT's full-screen app. Left: projects and chat history (mine / shared with me).
// Centre: the chat. Right: the current project's context and the chat's sharing.
// State lives in the query string (?c=<chat>&p=<project>) so links and reloads land in place.
import { h, present } from "../dashboard/dom.js"
import { formatTokens } from "../admin/model.js"
import { gptApi } from "./api.js"
import { createChat } from "./chat.js"
import { editProject, shareChat, skillLibrary } from "./dialogs.js"
import { groupConversations, relativeDay } from "./model.js"

export async function mountGpt(root, { api, session }) {
  const gpt = gptApi(api)
  root.replaceChildren(h("p", { class: "muted", text: "Loading Hafezi GPT…" }))
  let boot
  let projects
  try {
    ;[boot, projects] = await Promise.all([gpt.bootstrap(), gpt.projects()])
  } catch (error) {
    root.replaceChildren(h("div", { class: "dash-error", role: "alert", text: error.message }))
    return
  }
  boot.me = session.user.login
  boot.isAdmin = !!session.user.is_admin

  const params = new URLSearchParams(location.search)
  let projectId = params.get("p")
  let scope = "mine"
  let query = ""
  let conversations = []

  // ---- layout ----
  root.replaceChildren()
  root.classList.add("gpt-app")
  const rail = h("aside", { class: "gpt-rail", "aria-label": "Projects and chats" })
  const main = h("section", { class: "gpt-main" })
  const side = h("aside", { class: "gpt-side", "aria-label": "Context" })
  const header = h("header", { class: "gpt-header" })
  const chatHost = h("div", { class: "gpt-chat-host" })
  main.append(header, chatHost)
  const railToggle = h("button", {
    type: "button",
    class: "gpt-icon-button gpt-rail-toggle",
    "aria-label": "Show chats",
    text: "☰",
    onclick: () => root.classList.toggle("gpt-rail-open"),
  })
  root.append(rail, main, side)

  const chat = createChat({
    gpt,
    boot,
    session,
    host: chatHost,
    mode: "page",
    project: () => projectId,
    onChange: async (event) => {
      if (event.type === "created") setUrl({ c: event.conversation.id })
      if (event.type === "forked") return openChat(event.conversation.id)
      if (event.type === "title" || event.type === "updated" || event.type === "created") {
        renderHeader()
        await loadConversations()
      }
    },
  })

  // ---- rail ----
  const search = h("input", {
    type: "search",
    class: "gpt-search",
    placeholder: "Search chats",
    "aria-label": "Search chats",
  })
  const tabs = h(
    "div",
    { class: "dash-tabs gpt-scope", role: "tablist" },
    [
      ["mine", "My chats"],
      ["shared", "Shared with me"],
    ].map(([id, label]) =>
      h("button", {
        type: "button",
        role: "tab",
        "data-scope": id,
        "aria-selected": String(id === scope),
        text: label,
        onclick: () => {
          scope = id
          tabs
            .querySelectorAll("[role=tab]")
            .forEach((t) => t.setAttribute("aria-selected", String(t.dataset.scope === scope)))
          loadConversations()
        },
      }),
    ),
  )
  const projectList = h("ul", { class: "gpt-project-list" })
  const chatList = h("div", { class: "gpt-chat-list" })
  rail.append(
    h(
      "div",
      { class: "gpt-rail-head" },
      h("h1", { class: "gpt-title", text: "Hafezi GPT" }),
      h("button", { type: "button", class: "primary", text: "New chat", onclick: () => newChat() }),
    ),
    h(
      "div",
      { class: "gpt-rail-section" },
      h(
        "div",
        { class: "gpt-rail-label" },
        h("span", { text: "Projects" }),
        h("button", {
          type: "button",
          class: "gpt-link-button",
          text: "+ New",
          onclick: async () => {
            const created = await editProject(gpt, boot)
            if (created) {
              projects = await gpt.projects()
              selectProject(created.id)
            }
          },
        }),
      ),
      projectList,
    ),
    h("div", { class: "gpt-rail-section gpt-rail-grow" }, tabs, search, chatList),
    h(
      "div",
      { class: "gpt-rail-foot" },
      h("button", {
        type: "button",
        class: "gpt-link-button",
        text: "Skills",
        onclick: () => skillLibrary(gpt, boot),
      }),
      boot.isAdmin ? h("a", { href: "/admin?tab=usage", text: "Usage" }) : null,
    ),
  )

  function renderProjects() {
    const item = (id, label, badge) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: "gpt-project",
            "aria-current": String((projectId ?? null) === id),
            onclick: () => selectProject(id),
          },
          h("span", { text: label }),
          badge ? h("span", { class: "gpt-badge", text: badge }) : null,
        ),
      )
    projectList.replaceChildren(
      item(null, "All chats"),
      ...projects.map((p) =>
        item(
          p.id,
          p.name,
          p.visibility === "group" ? (p.owner === boot.me ? "group" : p.owner) : null,
        ),
      ),
    )
  }

  function renderChats() {
    chatList.replaceChildren()
    if (!conversations.length) {
      chatList.append(
        h("p", {
          class: "muted gpt-empty-list",
          text:
            scope === "shared"
              ? "Nothing has been shared with you yet."
              : query
                ? "No chats match."
                : "No chats yet.",
        }),
      )
      return
    }
    const groups =
      scope === "shared"
        ? [{ key: "shared", label: "", items: conversations }]
        : groupConversations(conversations, projects)
    for (const group of groups) {
      if (group.label && !(projectId && groups.length === 1))
        chatList.append(h("h2", { class: "gpt-rail-label", text: group.label }))
      chatList.append(
        h(
          "ul",
          {},
          group.items.map((c) =>
            h(
              "li",
              {},
              h(
                "a",
                {
                  href: `/gpt?c=${encodeURIComponent(c.id)}`,
                  class: "gpt-chat-link",
                  "aria-current": String(chat.conversation?.id === c.id),
                  onclick: (e) => (e.preventDefault(), openChat(c.id)),
                },
                h("span", { class: "gpt-chat-title", text: c.title }),
                h("span", {
                  class: "muted gpt-chat-sub",
                  text: [
                    scope === "shared" ? `from ${c.shared_by}` : null,
                    c.lab_name ? "lab" : null,
                    c.origin_slug && group.key === "pages" ? c.origin_slug.split("/").pop() : null,
                    c.share_count ? "shared" : null,
                    relativeDay(c.updated_at),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }),
              ),
            ),
          ),
        ),
      )
    }
  }

  async function loadConversations() {
    try {
      conversations = await gpt.conversations({
        scope,
        project: scope === "mine" ? projectId : null,
        q: query,
      })
      renderChats()
    } catch (error) {
      chatList.replaceChildren(h("p", { class: "gpt-error", text: error.message }))
    }
  }
  let searchTimer = 0
  search.oninput = () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => ((query = search.value.trim()), loadConversations()), 200)
  }

  // ---- header + side panel ----
  function renderHeader() {
    const c = chat.conversation
    const project = projects.find((p) => p.id === (c?.project_id ?? projectId))
    header.replaceChildren(
      ...present(
        railToggle,
        h(
          "div",
          { class: "gpt-header-title" },
          h("strong", { text: c?.title ?? (project ? `New chat in ${project.name}` : "New chat") }),
          project ? h("span", { class: "muted", text: ` · ${project.name}` }) : null,
          c?.origin_slug
            ? h("a", {
                class: "muted",
                href: `/${c.origin_slug}`,
                text: ` · about ${c.origin_slug}`,
              })
            : null,
        ),
        h("span", { class: "spacer" }),
        c && c.owner === boot.me
          ? h("button", {
              type: "button",
              text: "Share",
              onclick: async () => (await shareChat(gpt, boot, c), loadConversations()),
            })
          : null,
        c && c.owner === boot.me
          ? h("button", {
              type: "button",
              class: "gpt-link-button",
              text: "Rename",
              onclick: async () => {
                const title = prompt("Rename chat", c.title)
                if (!title) return
                await gpt.updateConversation(c.id, { title })
                await openChat(c.id)
                loadConversations()
              },
            })
          : null,
        c && c.owner === boot.me
          ? h("button", {
              type: "button",
              class: "gpt-link-button danger-text",
              text: "Delete",
              onclick: async () => {
                if (!confirm(`Delete “${c.title}”? This can't be undone.`)) return
                await gpt.deleteConversation(c.id)
                newChat()
                loadConversations()
              },
            })
          : null,
        h("button", {
          type: "button",
          class: "gpt-icon-button gpt-side-toggle",
          "aria-label": "Show context",
          text: "ⓘ",
          onclick: () => root.classList.toggle("gpt-side-open"),
        }),
      ),
    )
  }

  async function renderSide() {
    const id = chat.conversation?.project_id ?? projectId
    side.replaceChildren()
    if (!id) {
      side.append(
        h("h2", { text: "Context" }),
        h("p", {
          class: "muted",
          text: "Hafezi GPT searches and reads the whole lab site as needed: public pages and the members-only resources (onboarding, notes, projects, code, library, equipment documents).",
        }),
        h(
          "p",
          { class: "muted" },
          "Type ",
          h("kbd", { text: "@" }),
          " to add specific pages or documents, ",
          h("kbd", { text: "/" }),
          " for a skill, or attach files. Use a project to keep a topic's pages and instructions in every chat.",
        ),
        h(
          "p",
          { class: "muted" },
          "On any page, press ",
          h("kbd", { text: "Ctrl J" }),
          " to ask about it.",
        ),
      )
      return
    }
    side.append(h("p", { class: "muted", text: "Loading project…" }))
    try {
      const project = await gpt.project(id)
      const k = project.knowledge
      side.replaceChildren(
        ...present(
          h(
            "div",
            { class: "gpt-side-head" },
            h("h2", { text: project.name }),
            project.can_edit || project.visibility === "group"
              ? h("button", {
                  type: "button",
                  class: "gpt-link-button",
                  text: "Edit",
                  onclick: async () => {
                    const saved = await editProject(gpt, boot, project)
                    projects = await gpt.projects()
                    if (saved === null) selectProject(null)
                    else (renderProjects(), renderSide(), renderHeader())
                  },
                })
              : null,
          ),
          project.description ? h("p", { text: project.description }) : null,
          h("p", {
            class: "muted",
            text: `${project.visibility === "group" ? "Group project" : "Private project"} · by ${project.owner}`,
          }),
          project.instructions
            ? h(
                "details",
                { class: "gpt-instructions" },
                h("summary", { text: "Instructions" }),
                h("p", { text: project.instructions }),
              )
            : null,
          h("h3", { text: `Knowledge · ${formatTokens(k.tokens)} tokens` }),
          h(
            "div",
            {
              class: "gpt-meter-bar",
              role: "meter",
              "aria-valuemin": "0",
              "aria-valuemax": "150000",
              "aria-valuenow": String(k.tokens),
              title: "Share of the project context budget",
            },
            h("span", { style: `width:${Math.min(100, (k.tokens / 150_000) * 100).toFixed(1)}%` }),
          ),
          project.topics.length
            ? h(
                "div",
                { class: "gpt-chips" },
                project.topics.map((t) =>
                  h("a", { class: "gpt-chip", href: `/tags/${t}`, text: `#${t}` }),
                ),
              )
            : null,
          h(
            "ul",
            { class: "gpt-source-list" },
            k.included.map((s) =>
              h(
                "li",
                {},
                s.source === "file"
                  ? h("span", { text: `📎 ${s.title}` })
                  : h("a", { href: `/${s.slug}`, text: s.title }),
                h("span", { class: "muted", text: ` ${formatTokens(s.tokens)}` }),
              ),
            ),
          ),
          k.overflow.length
            ? h(
                "details",
                {},
                h("summary", { class: "muted", text: `${k.overflow.length} more read on demand` }),
                h(
                  "ul",
                  { class: "gpt-source-list" },
                  k.overflow.map((s) => h("li", { text: s.title })),
                ),
              )
            : null,
        ),
      )
    } catch (error) {
      side.replaceChildren(h("p", { class: "gpt-error", text: error.message }))
    }
  }

  // ---- navigation ----
  function setUrl(next) {
    const url = new URL(location.href)
    for (const [key, value] of Object.entries(next))
      value ? url.searchParams.set(key, value) : url.searchParams.delete(key)
    history.replaceState(history.state, "", url)
  }

  async function openChat(id) {
    try {
      const data = await chat.open(id)
      if (data?.conversation.project_id && data.access === "owner")
        projectId = data.conversation.project_id
      setUrl({ c: id, p: projectId })
    } catch (error) {
      setUrl({ c: null })
      await chat.open(null)
      chatHost.prepend(h("p", { class: "gpt-error", role: "alert", text: error.message }))
    }
    root.classList.remove("gpt-rail-open")
    renderProjects()
    renderHeader()
    renderSide()
    renderChats()
    chat.focus()
  }

  function newChat() {
    chat.open(null)
    setUrl({ c: null })
    renderHeader()
    renderChats()
    root.classList.remove("gpt-rail-open")
    chat.focus()
  }

  function selectProject(id) {
    projectId = id
    setUrl({ p: id, c: null })
    chat.open(null)
    renderProjects()
    renderHeader()
    renderSide()
    loadConversations()
  }

  renderProjects()
  await loadConversations()
  if (params.get("c")) await openChat(params.get("c"))
  else {
    renderHeader()
    renderSide()
    chat.focus()
  }
}
