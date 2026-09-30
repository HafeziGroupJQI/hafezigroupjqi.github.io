// The "Ask Hafezi GPT" button on every member page (and Ctrl/⌘+J). Tiny on purpose: the chat
// itself (modal.js → chat.js, Markdown, KaTeX) loads only when first opened.
import { h } from "../dashboard/dom.js"

let deps = null
let modal = null
let loading = null
let button = null

async function open() {
  loading ??= import("./modal.js").then(({ createModal }) => (modal = createModal(deps)))
  await loading
  modal.open()
}

/** What a keydown does here: Ctrl/⌘+J opens the modal, or closes it when open; null otherwise. */
export function shortcutAction(event, modalOpen) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return null
  if (event.key?.toLowerCase() !== "j") return null
  return modalOpen ? "close" : "open"
}

export function installLauncher({ api, session }) {
  const path = location.pathname.replace(/\/+$/, "")
  if (path === "/gpt" || document.querySelector("[data-hafezi-gpt]")) return
  deps = { api, session }
  button = h(
    "button",
    {
      type: "button",
      class: "gpt-fab",
      title: "Ask Hafezi GPT about this page (Ctrl+J)",
      "aria-keyshortcuts": "Control+J Meta+J",
      onclick: () => open().catch((error) => console.error(error)),
    },
    h("span", { class: "gpt-fab-icon", "aria-hidden": "true", text: "✦" }),
    h("span", { class: "gpt-fab-label", text: "Ask Hafezi GPT" }),
  )
  document.body.append(button)
  document.addEventListener("keydown", (event) => {
    const action = shortcutAction(event, !!modal?.isOpen())
    if (!action) return
    event.preventDefault()
    if (action === "close") modal.close()
    else open().catch((error) => console.error(error))
  })
}
