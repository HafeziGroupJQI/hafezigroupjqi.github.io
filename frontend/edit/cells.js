// The page editor's notebook view (index.js): a Jupyter notebook as its cells, each edited on its
// own (its code, or its Markdown), with the outputs it saved shown as they are, text and figures
// (never HTML or scripts: those aren't shown here), and cells added, moved or deleted. It is
// written back in its own JSON layout (notebook.js), so only what changed differs on GitHub. The
// notebook's JSON can be edited as text too: when its layout can't be kept, that is the view, and
// taking in someone else's change to the notebook is done there, where the differences show.

import { h } from "../dashboard/dom.js"
import { createCellEditor, createSourceEditor } from "./editor.js"
import {
  ANSI,
  cellText,
  clearOutputs,
  newCell,
  notebookLayout,
  notebookMarkdown,
  parseJson,
  serializeJson,
  setCellText,
} from "./notebook.js"

const LABELS = { code: "Code", markdown: "Text", raw: "Raw" }
/** At most this much of an output's text is shown (a notebook can print megabytes). */
const OUTPUT_CAP = 4000
const joined = (value) =>
  Array.isArray(value) ? value.join("") : typeof value === "string" ? value : ""

function outputText(text) {
  const clean = text.replace(ANSI, "")
  return h("pre", {
    text:
      clean.length > OUTPUT_CAP
        ? `${clean.slice(0, OUTPUT_CAP)}\n… (${clean.length - OUTPUT_CAP} more characters)`
        : clean,
  })
}

/** A saved output, read only: its text, or its figure (PNG, JPEG, GIF). */
function outputNode(output) {
  const kind = output.get?.("output_type")
  if (kind === "stream") return outputText(joined(output.get("text")))
  if (kind === "error")
    return outputText(
      `${output.get("ename")}: ${output.get("evalue")}\n${(output.get("traceback") ?? []).join("\n")}`,
    )
  const data = output.get?.("data")
  if (!data) return null
  for (const type of ["image/png", "image/jpeg", "image/gif"])
    if (data.has(type))
      return h("img", {
        src: `data:${type};base64,${joined(data.get(type)).replace(/\s/g, "")}`,
        alt: "A figure the notebook saved",
      })
  if (data.has("text/plain")) return outputText(joined(data.get("text/plain")))
  return h("p", {
    class: "muted",
    text: "This output (HTML or a widget) isn't shown in the editor.",
  })
}

/**
 * Mount a notebook editor in `parent` for the notebook `text`. The same calls as the source
 * editor's (editor.js): getText, setText, focus, compareWith, and previewMarkdown for the preview.
 */
export function createNotebookEditor(parent, text, { separator, readOnly, onChange, onSave }) {
  let notebook = null
  let layout = null
  try {
    notebook = parseJson(text)
    layout = Array.isArray(notebook?.get?.("cells")) ? notebookLayout(text, notebook) : null
  } catch {}
  const cellsHost = h("div", { class: "edit-cells" })
  const jsonHost = h("div", { class: "edit-json" })
  const message = h("p", { class: "dash-error", role: "alert", hidden: true })
  let view = layout ? "cells" : "json"
  let json = null
  const serialized = () => serializeJson(notebook, layout)
  const current = () => (view === "cells" ? serialized() : json.getText())
  const changed = () => onChange?.(current())

  function show(next) {
    if (next === "cells") {
      try {
        notebook = parseJson(json.getText())
        if (!Array.isArray(notebook?.get?.("cells"))) throw new SyntaxError("no cells")
      } catch (error) {
        message.textContent = `The JSON isn't a notebook yet (${error.message}): fix it to see its cells.`
        message.hidden = false
        return
      }
      render()
      queueMicrotask(changed)
    } else {
      json ??= createSourceEditor(jsonHost, text, {
        kind: "ipynb",
        separator,
        readOnly,
        onChange,
        onSave,
      })
      if (view === "cells") json.setText(serialized())
    }
    message.hidden = true
    view = next
    cellsHost.hidden = view !== "cells"
    jsonHost.hidden = view !== "json"
    for (const button of switcher?.children ?? [])
      button.setAttribute("aria-checked", String(button.dataset.view === view))
  }

  const button = (text, label, onclick, disabled = false) =>
    h("button", { type: "button", class: "link", text, "aria-label": label, disabled, onclick })

  function restructure(change) {
    change(notebook.get("cells"))
    render()
    changed()
  }

  function cellNode(cell, index, cells) {
    const type = cell.get("cell_type")
    const source = h("div", { class: "edit-cell-source" })
    const outputs = type === "code" ? (cell.get("outputs") ?? []) : []
    const label = `${LABELS[type] ?? type} cell ${index + 1}`
    const node = h(
      "section",
      { class: `edit-cell edit-cell-${type}`, "aria-label": label },
      h(
        "header",
        {},
        h("span", { class: "edit-cell-type", text: LABELS[type] ?? type }),
        readOnly
          ? null
          : h(
              "span",
              { class: "edit-cell-actions" },
              button(
                "↑",
                `Move ${label} up`,
                () => restructure((all) => all.splice(index - 1, 0, ...all.splice(index, 1))),
                index === 0,
              ),
              button(
                "↓",
                `Move ${label} down`,
                () => restructure((all) => all.splice(index + 1, 0, ...all.splice(index, 1))),
                index === cells.length - 1,
              ),
              button("+ Code", `Add a code cell below ${label}`, () =>
                restructure((all) => all.splice(index + 1, 0, newCell(notebook, "code", layout))),
              ),
              button("+ Text", `Add a text cell below ${label}`, () =>
                restructure((all) =>
                  all.splice(index + 1, 0, newCell(notebook, "markdown", layout)),
                ),
              ),
              outputs.length
                ? button("Clear output", `Clear the output of ${label}`, () =>
                    restructure(() => clearOutputs(cell)),
                  )
                : null,
              button("Delete", `Delete ${label}`, () => {
                if (cellText(cell).trim() && !confirm(`Delete ${label}?`)) return
                restructure((all) => all.splice(index, 1))
              }),
            ),
      ),
      source,
      outputs.length
        ? h(
            "div",
            { class: "edit-cell-outputs", "aria-label": `Saved output of ${label}` },
            outputs.map(outputNode),
          )
        : null,
    )
    createCellEditor(source, cellText(cell), {
      type,
      readOnly,
      onSave,
      onChange: (next) => {
        setCellText(cell, next)
        changed()
      },
    })
    return node
  }

  function render() {
    const cells = notebook.get("cells")
    cellsHost.replaceChildren(
      ...cells.map((cell, index) => cellNode(cell, index, cells)),
      ...(readOnly || cells.length
        ? []
        : [
            button("+ Add a code cell", "Add a code cell", () =>
              restructure((all) => all.push(newCell(notebook, "code", layout))),
            ),
          ]),
    )
  }

  const switcher = layout
    ? h(
        "div",
        {
          class: "seg edit-notebook-view",
          role: "radiogroup",
          "aria-label": "Edit the notebook as",
        },
        ["cells", "json"].map((which) =>
          h("button", {
            type: "button",
            role: "radio",
            "data-view": which,
            "aria-checked": String(which === view),
            text: which === "cells" ? "Cells" : "JSON",
            onclick: () => show(which),
          }),
        ),
      )
    : h("p", {
        class: "muted",
        text: "This notebook's JSON isn't laid out in a way the cell editor can keep, so here you edit its JSON.",
      })
  parent.classList.add("edit-notebook")
  parent.append(switcher, message, cellsHost, jsonHost)
  if (layout) {
    render()
    jsonHost.hidden = true
  } else show("json")

  return {
    /** Whether its cells can be edited (its layout is one it can keep), else only its JSON. */
    cells: Boolean(layout),
    getText: current,
    setText(next) {
      if (view === "json") return json.setText(next)
      notebook = parseJson(next)
      render()
      changed()
    },
    focus: () => cellsHost.querySelector(".cm-content")?.focus(),
    // Someone else's version of the notebook is compared as JSON, where the differences show.
    compareWith(original) {
      if (original !== null) show("json")
      json?.compareWith(original)
    },
    previewMarkdown() {
      try {
        return notebookMarkdown(view === "cells" ? notebook : parseJson(json.getText()))
      } catch {
        return ""
      }
    },
  }
}
