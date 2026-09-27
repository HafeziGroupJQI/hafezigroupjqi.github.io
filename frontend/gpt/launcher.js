// The "Ask Hafezi GPT" button on every member page (and Ctrl/⌘+J). Tiny on purpose: the chat
// itself (modal.js → chat.js, Markdown, KaTeX) loads only when first opened.
import { h } from "../dashboard/dom.js"

export function installLauncher({ api, session }) {
  const path = location.pathname.replace(/\/+$/, "")
  if (path === "/gpt" || document.querySelector("[data-hafezi-gpt]")) return
  let modal = null
  let loading = null
  const open = async () => {
    loading ??= import("./modal.js").then(
      ({ createModal }) => (modal = createModal({ api, session })),
    )
    await loading
    modal.open()
  }
  const button = h(
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
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      event.shiftKey ||
      event.key.toLowerCase() !== "j"
    )
      return
    event.preventDefault()
    if (modal?.isOpen()) modal.close()
    else open().catch((error) => console.error(error))
  })
}
