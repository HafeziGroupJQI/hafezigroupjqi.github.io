// "Ask Hafezi GPT" on any member page: a side sheet with the same chat as /gpt, started with the
// current page as context. Chats land in the member's history (tagged with the page) and can be
// continued full-screen at /gpt.
import { h } from "../dashboard/dom.js"
import { gptApi } from "./api.js"
import { createChat } from "./chat.js"
import { pageSlug, relativeDay } from "./model.js"

export function createModal({ api, session }) {
  const gpt = gptApi(api)
  const slug = pageSlug(location.pathname)
  const title = (
    document.querySelector("main h1, article h1, h1")?.textContent ||
    document.title.split("|")[0] ||
    slug
  ).trim()
  const origin = { slug, title }

  const dialog = h("dialog", { class: "gpt-modal", "aria-label": "Hafezi GPT" })
  const projectSelect = h(
    "select",
    { class: "gpt-model", "aria-label": "Project" },
    h("option", { value: "", text: "No project" }),
  )
  const history = h(
    "details",
    { class: "gpt-modal-history" },
    h("summary", { text: "Chats about this page" }),
  )
  const historyList = h("ul", { class: "gpt-modal-history-list" })
  history.append(historyList)
  const openFull = h("a", { class: "gpt-link-button", href: "/gpt", text: "Open in Hafezi GPT ↗" })
  const host = h("div", { class: "gpt-modal-chat" })
  dialog.append(
    h(
      "header",
      { class: "gpt-modal-head" },
      h(
        "strong",
        { class: "gpt-modal-title" },
        h("span", { "aria-hidden": "true", text: "✦ " }),
        "Hafezi GPT",
      ),
      h("span", { class: "spacer" }),
      h("button", {
        type: "button",
        class: "gpt-link-button",
        text: "New chat",
        onclick: () => start(null),
      }),
      openFull,
      h("button", {
        type: "button",
        class: "gpt-icon-button",
        "aria-label": "Close",
        text: "×",
        onclick: () => close(),
      }),
    ),
    h("div", { class: "gpt-modal-bar" }, history, projectSelect),
    host,
  )
  document.body.append(dialog)
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close() // backdrop
  })
  dialog.addEventListener("cancel", (event) => {
    // Esc stops a streaming reply first; a second Esc closes.
    if (chat?.busy()) {
      event.preventDefault()
      chat.stop()
    }
  })

  let chat = null
  let ready = null

  async function setup() {
    host.replaceChildren(h("p", { class: "muted gpt-loading", text: "Loading…" }))
    const [boot, projects] = await Promise.all([gpt.bootstrap(), gpt.projects()])
    boot.me = session.user.login
    boot.isAdmin = !!session.user.is_admin
    projectSelect.append(...projects.map((p) => h("option", { value: p.id, text: p.name })))
    chat = createChat({
      gpt,
      boot,
      session,
      host,
      mode: "modal",
      origin,
      project: () => projectSelect.value || null,
      onChange: (event) => {
        if (event.type === "forked") return start(event.conversation.id)
        if (event.conversation)
          openFull.href = `/gpt?c=${encodeURIComponent(event.conversation.id)}`
        if (event.type === "created" || event.type === "title") loadHistory()
      },
    })
    await loadHistory()
  }

  async function loadHistory() {
    const [mine, shared] = await Promise.all([
      gpt.conversations({ origin: slug, limit: 20 }),
      gpt.conversations({ origin: slug, scope: "shared", limit: 20 }),
    ]).catch(() => [[], []])
    const all = [...mine, ...shared].sort((a, b) => b.updated_at - a.updated_at)
    history.hidden = !all.length
    historyList.replaceChildren(
      ...all.map((c) =>
        h(
          "li",
          {},
          h(
            "button",
            {
              type: "button",
              class: "gpt-link-button",
              onclick: () => ((history.open = false), start(c.id)),
            },
            h("span", { text: c.title }),
            h("span", {
              class: "muted",
              text: ` · ${c.owner === session.user.login ? "" : `${c.shared_by ?? c.owner} · `}${relativeDay(c.updated_at)}`,
            }),
          ),
        ),
      ),
    )
  }

  async function start(id) {
    await chat.open(id)
    openFull.href = id ? `/gpt?c=${encodeURIComponent(id)}` : "/gpt"
    chat.focus()
  }

  function open() {
    if (!dialog.open) dialog.showModal()
    document.documentElement.classList.add("gpt-modal-open")
    ready ??= setup().catch((error) => {
      ready = null
      host.replaceChildren(h("p", { class: "gpt-error", role: "alert", text: error.message }))
    })
    ready.then(() => chat?.focus())
  }

  function close() {
    dialog.close()
    document.documentElement.classList.remove("gpt-modal-open")
  }
  dialog.addEventListener("close", () =>
    document.documentElement.classList.remove("gpt-modal-open"),
  )

  return { open, close, isOpen: () => dialog.open }
}
