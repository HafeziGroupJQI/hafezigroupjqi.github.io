// The announcements spotlight: on the first page a member opens after an announcement goes live,
// it opens over the page (a native <dialog> with showModal(), the rest of the site dimmed behind
// its ::backdrop), one announcement at a time with "1 of N", Previous and Next. Closing it (the
// button, ×, Esc, a click on the dimmed page, or following one of its links) dismisses the ones
// the member saw, on the Worker, so they never show again on any device; the rest show next time.
// member-tools.js loads this only when GET /api/announcements/pending has something.

import { h, present } from "../dashboard/dom.js"
import { seenIds, spotlightAllowed, stepLabel } from "./model.js"
import { bodyElement, filesList, metaLine } from "./view.js"

/** Tell the Worker the member saw these. keepalive: it still goes when a link leaves the page. */
function dismiss(ids) {
  for (const id of ids)
    fetch(`/api/announcements/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
      keepalive: true,
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
    }).catch((error) => console.error(error))
}

/** Open the spotlight on `announcements` (newest first). Returns the dialog, or null. */
export function showSpotlight(announcements) {
  if (!announcements?.length) return null
  if (
    !spotlightAllowed({
      framed: window.top !== window,
      labOpen: !!document.querySelector(".scratchpad.scratch-open"),
    })
  )
    return null
  if (document.querySelector("dialog.announcement-modal")) return null

  const seen = new Set()
  const sent = new Set()
  let index = 0
  const opener = document.activeElement

  const step = h("span", { class: "announcement-modal__step", "aria-live": "polite" })
  const close = h("button", {
    type: "button",
    class: "announcement-modal__close",
    "aria-label": "Close and dismiss",
    title: "Close",
    text: "×",
    onclick: () => finish(),
  })
  const content = h("div", { class: "announcement-modal__content" })
  const previous = h("button", {
    type: "button",
    class: "announcement-modal__prev",
    text: "Previous",
    onclick: () => {
      show(index - 1)
      // At the first one Previous goes off: focus stays in the dialog.
      if (previous.disabled) next.focus()
    },
  })
  const next = h("button", { type: "button", class: "announcement-modal__primary primary" })
  const dialog = h(
    "dialog",
    { class: "announcement-modal" },
    h(
      "header",
      { class: "announcement-modal__head" },
      h(
        "p",
        { class: "announcement-modal__kicker" },
        h("span", { text: "Announcement" }),
        announcements.length > 1 ? step : null,
      ),
      close,
    ),
    content,
    h(
      "footer",
      { class: "announcement-modal__foot" },
      h("a", {
        href: "/announcements",
        class: "announcement-modal__all",
        text: "All announcements",
      }),
      h("span", { class: "spacer" }),
      announcements.length > 1 ? previous : null,
      next,
    ),
  )

  function show(at) {
    index = Math.max(0, Math.min(at, announcements.length - 1))
    seen.add(index)
    const announcement = announcements[index]
    const titleId = `announcement-title-${index}`
    const bodyId = `announcement-body-${index}`
    dialog.setAttribute("aria-labelledby", titleId)
    dialog.setAttribute("aria-describedby", bodyId)
    content.replaceChildren(
      ...present(
        h("h2", { class: "announcement-modal__title", id: titleId, text: announcement.title }),
        metaLine(announcement),
        bodyElement(announcement, bodyId),
        filesList(announcement.files),
      ),
    )
    content.scrollTop = 0
    step.textContent = stepLabel(index, announcements.length)
    previous.disabled = index === 0
    const last = index === announcements.length - 1
    next.textContent = last ? "Dismiss" : "Next"
    next.onclick = () => (last ? finish() : show(index + 1))
  }

  // Each one the member saw is dismissed once, however the spotlight ends.
  function dismissSeen() {
    const ids = seenIds(announcements, seen).filter((id) => !sent.has(id))
    for (const id of ids) sent.add(id)
    dismiss(ids)
  }

  function finish() {
    dismissSeen()
    if (dialog.open) dialog.close()
  }

  // Esc (the dialog's cancel) and a click on the dimmed page close it as the button does.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault()
    finish()
  })
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) finish()
    // Following a link in it: the member has seen it.
    else if (event.target.closest?.("a[href]")) dismissSeen()
  })
  dialog.addEventListener("close", () => {
    document.documentElement.classList.remove("announcement-open")
    dialog.remove()
    if (opener?.isConnected && opener !== document.body) opener.focus?.()
  })

  document.body.append(dialog)
  show(0)
  document.documentElement.classList.add("announcement-open")
  dialog.showModal()
  // Focus the main button, not the × (showModal's first focusable): Enter goes on.
  next.focus()
  return dialog
}
