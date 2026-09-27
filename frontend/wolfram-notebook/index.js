// Wolfram notebook pages: any .nb in the site's content becomes a page (tools/notebooks/), whose
// code cells members can run on the lab's Wolfram Engine, edit, copy, or open in their Scratchpad.
// Each input cell is a <figure class="wl-cell" data-cell data-prelude> holding
// <pre class="wl-code"><code>. member-tools.js mounts this on [data-wolfram-notebook].

import { h } from "../dashboard/dom.js"
import {
  failureMessage,
  frameIndex,
  normalizeSymbols,
  parseControls,
  preludeCodes,
  runPayload,
  spriteStyle,
  valueLabel,
} from "./cells.js"

// POST JSON to a same-origin /api path (the members service worker adds the bearer token).
// Unlike member-tools' api(), non-2xx answers are returned, so 503 can read "host offline".
async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (response.status === 401) {
    location.assign("/auth/login?next=" + encodeURIComponent(location.pathname + location.search))
    throw new Error("Your session expired. Please sign in again.")
  }
  const data = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, data }
}

let editorModule = null
const loadEditor = () => (editorModule ??= import("./editor.js"))

export function mountWolframNotebook(root) {
  if (root.dataset.wlMounted) return
  root.dataset.wlMounted = "1"
  const page = root.dataset.page ?? ""
  // The notebook's path in the private vault (the compute host mirrors it); empty: not forkable.
  const source = root.dataset.source ?? ""
  const cells = new Map()
  let symbolsPromise = null
  const symbols = () =>
    (symbolsPromise ??= root.dataset.symbols
      ? fetch(root.dataset.symbols)
          .then((response) => (response.ok ? response.json() : []))
          .then(normalizeSymbols)
          .catch(() => [])
      : Promise.resolve([]))

  // Open the notebook in the Scratchpad: the page there starts the member's server (the host only
  // knows members who have started one), copies the notebook into their storage and opens it.
  const fork = (status) => {
    status.textContent = "Opening the Scratchpad…"
    location.assign(`/scratchpad?fork=${encodeURIComponent(source)}`)
  }

  if (source) {
    const status = h("span", { class: "wl-status", role: "status" })
    root.prepend(
      h(
        "div",
        { class: "wl-page-actions" },
        h("button", {
          type: "button",
          text: "Open notebook in Scratchpad",
          onclick: () => fork(status),
        }),
        status,
      ),
    )
  }

  for (const figure of root.querySelectorAll("figure.wl-cell")) {
    const pre = figure.querySelector("pre.wl-code")
    const codeNode = pre?.querySelector("code")
    if (!pre || !codeNode) continue
    const original = codeNode.textContent.replace(/\n$/, "")
    const cell = { figure, pre, original, editor: null, running: false }
    cells.set(figure.dataset.cell ?? figure.id, cell)
    const currentCode = () => cell.editor?.getCode() ?? original
    // Inputs the book draws as pictures (graphics, free-form input) keep their code in a hidden
    // <pre>; cells marked data-norun have no runnable code.
    const picture = figure.querySelector(".wl-code-img")
    const codeHidden = pre.hidden

    const output = h("div", { class: "wl-run-out", hidden: true, "aria-live": "polite" })
    const status = h("span", { class: "wl-status", role: "status" })
    const runButton = h("button", { type: "button", class: "wl-run", text: "Run" })
    const editButton = h("button", { type: "button", text: "Edit" })
    const resetButton = h("button", { type: "button", text: "Reset", hidden: true })
    const copyButton = h("button", { type: "button", text: "Copy" })
    const forkButton = h("button", { type: "button", text: "Open in Scratchpad" })

    const run = async () => {
      if (cell.running) return
      cell.running = true
      runButton.disabled = true
      output.hidden = false
      output.replaceChildren(h("p", { class: "muted", text: "Running…" }))
      try {
        const prelude = preludeCodes(figure.dataset.prelude, (id) => {
          const other = cells.get(id)
          return other ? (other.editor?.getCode() ?? other.original) : null
        })
        const {
          ok,
          status: code,
          data,
        } = await post(
          "/api/compute/wolfram/run",
          runPayload({
            page,
            cell: figure.dataset.cell ?? figure.id,
            code: currentCode(),
            prelude,
          }),
        )
        if (!ok) throw new Error(failureMessage(code, data))
        renderResult(output, data)
      } catch (error) {
        output.replaceChildren(h("p", { class: "wl-error", role: "alert", text: error.message }))
      } finally {
        cell.running = false
        runButton.disabled = false
      }
    }
    runButton.onclick = run

    editButton.onclick = async () => {
      if (cell.editor) return cell.editor.focus()
      editButton.disabled = true
      status.textContent = "Loading editor…"
      try {
        const { createEditor } = await loadEditor()
        const host = h("div", { class: "wl-editor" })
        pre.after(host)
        cell.editor = createEditor(host, original, { symbols, onRun: run })
        pre.hidden = true
        if (picture) picture.hidden = true
        resetButton.hidden = false
        editButton.hidden = true
        status.textContent = ""
        cell.editor.focus()
      } catch (error) {
        status.textContent = `Editor unavailable: ${error.message}`
      } finally {
        editButton.disabled = false
      }
    }
    resetButton.onclick = () => {
      cell.editor?.view.destroy()
      figure.querySelector(".wl-editor")?.remove()
      cell.editor = null
      pre.hidden = codeHidden
      if (picture) picture.hidden = false
      resetButton.hidden = true
      editButton.hidden = false
    }
    copyButton.onclick = async () => {
      try {
        await navigator.clipboard.writeText(currentCode())
        status.textContent = "Copied"
      } catch {
        status.textContent = "Copy failed"
      }
      setTimeout(() => (status.textContent = ""), 1500)
    }
    forkButton.onclick = () => fork(status)
    if (!source) forkButton.hidden = true
    if ("norun" in figure.dataset) {
      runButton.hidden = true
      if (!original) editButton.hidden = copyButton.hidden = true
    }

    figure.prepend(
      h(
        "div",
        { class: "wl-toolbar" },
        runButton,
        editButton,
        resetButton,
        copyButton,
        forkButton,
        status,
      ),
    )
    figure.append(output)
  }

  for (const player of root.querySelectorAll(".wl-manipulate")) mountPlayer(player)
}

function renderResult(output, data) {
  const children = []
  for (const message of data?.messages ?? [])
    children.push(h("pre", { class: "wl-messages", text: String(message) }))
  if (data?.image?.data_b64)
    children.push(
      h("img", {
        class: "wl-img",
        alt: "Result",
        src: `data:${data.image.mime ?? "image/png"};base64,${data.image.data_b64}`,
      }),
    )
  if (typeof data?.text === "string" && data.text && !data?.image?.data_b64)
    children.push(h("pre", { class: "wl-text", text: data.text }))
  if (!children.length) children.push(h("p", { class: "muted", text: "(no output)" }))
  if (typeof data?.ms === "number")
    children.push(h("p", { class: "wl-timing", text: `${(data.ms / 1000).toFixed(2)} s` }))
  output.replaceChildren(...children)
}

// A precomputed Manipulate: a sprite grid of frames and one slider per control. The sprite loads
// on first interaction; until then the static snapshot stays.
export function mountPlayer(player) {
  const controls = parseControls(player.dataset.controls)
  const cols = Number(player.dataset.cols) || 1
  const rows = Number(player.dataset.rows) || 1
  const width = Number(player.dataset.frameWidth) || 0
  const height = Number(player.dataset.frameHeight) || 0
  const sprite = player.dataset.sprite
  if (!sprite || !controls.length || !width || !height) return
  const snapshot = player.querySelector("img")
  const view = h("div", {
    class: "wl-sprite",
    hidden: true,
    role: "img",
    "aria-label": "Manipulate frame",
    style: `aspect-ratio:${width}/${height};max-width:${width}px`,
  })
  const indices = controls.map((control) => control.initial)
  let loaded = false
  let loading = false
  const show = () => {
    const { size, position } = spriteStyle(frameIndex(controls, indices), cols, rows)
    view.style.backgroundSize = size
    view.style.backgroundPosition = position
  }
  const load = () => {
    if (loaded || loading) return
    loading = true
    const image = new Image()
    image.onload = () => {
      loaded = true
      view.style.backgroundImage = `url("${sprite}")`
      show()
      view.hidden = false
      if (snapshot) snapshot.hidden = true
    }
    image.onerror = () => (loading = false)
    image.src = sprite
  }
  const sliders = controls.map((control, k) => {
    const value = h("output", { text: valueLabel(control.values[control.initial]) })
    const input = h("input", {
      type: "range",
      min: 0,
      max: control.values.length - 1,
      step: 1,
      value: control.initial,
      "aria-label": control.label,
    })
    input.addEventListener("pointerdown", load)
    input.addEventListener("focus", load)
    input.addEventListener("input", () => {
      load()
      indices[k] = Number(input.value)
      value.textContent = valueLabel(control.values[indices[k]])
      if (loaded) show()
    })
    return h("label", { class: "wl-control" }, h("span", { text: control.label }), input, value)
  })
  player.prepend(h("div", { class: "wl-controls" }, sliders))
  ;(snapshot ?? player.lastChild).after(view)
}
