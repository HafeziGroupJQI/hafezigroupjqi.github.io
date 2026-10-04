// The editor kit: what the site's Markdown editors share (CodeMirror 6). The page editor's source
// (frontend/edit/editor.js) and the announcement composer (frontend/announcements/) each take
//   editorKit({mode, pages})   page links completed after [[ and ](, from the site's content index
//                              (pages.js), and Mod-b / Mod-i / Mod-k for bold, italic and a link;
//   formatToolbar(view, opts)  a toolbar of the formatting commands (format.js) above the editor.

import { autocompletion } from "@codemirror/autocomplete"
import { EditorSelection, Prec } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { h } from "../dashboard/dom.js"
import { COMMANDS } from "./format.js"
import { completionQuery, pageEntries, rankPages, wikilinkText } from "./pages.js"

/* global fetchData */

/** The site's content index, as the page loaded it (Quartz's fetchData), or none. */
export const siteIndex = () =>
  typeof fetchData === "undefined" ? Promise.resolve({}) : fetchData.catch(() => ({}))

/** Run the formatting command `name` on every selection of `view`. false when it can't. */
export function runFormat(view, name) {
  const command = COMMANDS[name]
  if (!command || view.state.readOnly) return false
  const text = view.state.doc.toString()
  view.dispatch(
    view.state.changeByRange((range) => {
      const result = command(text, range.from, range.to)
      // changeByRange wants the selection after this range's own changes, which it is.
      return {
        changes: result.changes,
        range: EditorSelection.range(result.anchor, result.head),
      }
    }),
    { scrollIntoView: true, userEvent: "input.format" },
  )
  return true
}

const formatKeys = keymap.of([
  { key: "Mod-b", run: (view) => runFormat(view, "bold"), preventDefault: true },
  { key: "Mod-i", run: (view) => runFormat(view, "italic"), preventDefault: true },
  { key: "Mod-k", run: (view) => runFormat(view, "link"), preventDefault: true },
])

/**
 * The completion source for page links in a document of `mode` (pages.js): after [[ it offers
 * pages by title and path and inserts [[path|Title]] (or, in the private vault, a Markdown link to
 * a public page); after ]( it inserts the page's path on the site.
 */
export function pageCompletionSource({ mode = "site", pages = siteIndex() } = {}) {
  let entries = null
  const load = () => (entries ??= Promise.resolve(pages).then(pageEntries))
  return async (context) => {
    const line = context.state.doc.lineAt(context.pos)
    const found = completionQuery(line.text.slice(0, context.pos - line.from))
    if (!found) return null
    // A target after ]( only once it looks like a path: not for every link typed.
    if (found.kind === "link" && !found.query.startsWith("/") && !context.explicit) return null
    const ranked = rankPages(await load(), found.query, { mode, ...found })
    if (context.aborted || !ranked.length) return null
    const from = line.from + found.from
    const start = found.start === null ? null : line.from + found.start
    return {
      from,
      to: context.pos,
      filter: false,
      options: ranked.map(({ entry, link }, i) => ({
        label: entry.title,
        detail: found.kind === "link" ? link.href : (link.wiki ?? link.href),
        type: entry.private ? "class" : "text",
        boost: -i,
        apply: (view, _completion, _from, to) => {
          const doc = view.state.doc
          if (found.kind === "link") {
            const close = doc.sliceString(to, to + 1) === ")" ? "" : ")"
            const insert = link.href + close
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + insert.length },
              userEvent: "input.complete",
            })
            return
          }
          // [[…]]: the whole link, the brackets typed (or closed already) included.
          const end = doc.sliceString(to, to + 2) === "]]" ? to + 2 : to
          const bang = found.embed ? "!" : ""
          const insert = link.wiki ? bang + wikilinkText(link.wiki, entry.title) : link.markdown
          view.dispatch({
            changes: { from: start, to: end, insert },
            selection: { anchor: start + insert.length },
            userEvent: "input.complete",
          })
        },
      })),
    }
  }
}

// The completion list: each page's title, then its path, muted; no wider than a phone.
const kitTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": { maxWidth: "min(40em, calc(100vw - 24px))" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    maxHeight: "18em",
    fontFamily: "Roboto, system-ui, sans-serif",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    padding: "3px 10px",
  },
  ".cm-completionLabel": { whiteSpace: "nowrap" },
  ".cm-completionDetail": {
    marginLeft: "auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontStyle: "normal",
    fontSize: "0.8em",
    fontFamily: "var(--codeFont, ui-monospace, monospace)",
    opacity: "0.75",
  },
})

/** The kit's extensions for an editor whose document is read where `mode` says (pages.js). */
export function editorKit({ mode = "site", pages } = {}) {
  return [
    autocompletion({
      override: [pageCompletionSource({ mode, pages })],
      activateOnTyping: true,
      icons: false,
      maxRenderedOptions: 30,
    }),
    Prec.high(formatKeys),
    kitTheme,
  ]
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const mod = isMac ? "⌘" : "Ctrl+"

// [command, label (what the button shows), name (what it is called), shortcut]
export const TOOLS = [
  ["bold", "B", "Bold", "b"],
  ["italic", "I", "Italic", "i"],
  ["heading", "H", "Heading"],
  ["link", "Link", "Link", "k"],
  ["bullet", "• List", "Bulleted list"],
  ["number", "1. List", "Numbered list"],
  ["quote", "Quote", "Quote"],
  ["code", "</>", "Code"],
  ["codeblock", "{ }", "Code block"],
  ["math", "∑", "Math ($…$)"],
]

/**
 * A formatting toolbar for `view`. `onAttach()`, when given, adds an Attach button (the caller
 * picks and uploads the files). Returns the element, and setDisabled(bool) for a read-only editor.
 */
export function formatToolbar(view, { onAttach, label = "Formatting" } = {}) {
  const buttons = TOOLS.map(([name, text, title, key]) =>
    h("button", {
      type: "button",
      class: `kit-tool kit-tool--${name}`,
      text,
      title: key ? `${title} (${mod}${key.toUpperCase()})` : title,
      "aria-label": title,
      "aria-keyshortcuts": key ? `Control+${key.toUpperCase()} Meta+${key.toUpperCase()}` : null,
      tabindex: "-1",
      // Keep the editor's selection: the button never takes focus from it.
      onmousedown: (event) => event.preventDefault(),
      onclick: () => {
        runFormat(view, name)
        view.focus()
      },
    }),
  )
  if (onAttach)
    buttons.push(
      h("button", {
        type: "button",
        class: "kit-tool kit-tool--attach",
        text: "Attach…",
        title: "Attach files (or drop or paste them into the text)",
        "aria-label": "Attach files",
        tabindex: "-1",
        onmousedown: (event) => event.preventDefault(),
        onclick: () => onAttach(),
      }),
    )
  buttons[0].tabIndex = 0
  const bar = h("div", { class: "kit-toolbar", role: "toolbar", "aria-label": label }, buttons)
  // One tab stop; the arrow keys, Home and End move along it (WAI-ARIA's toolbar pattern).
  bar.addEventListener("keydown", (event) => {
    const at = buttons.indexOf(document.activeElement)
    if (at < 0) return
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % buttons.length
        : event.key === "ArrowLeft"
          ? (at - 1 + buttons.length) % buttons.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    buttons[at].tabIndex = -1
    buttons[next].tabIndex = 0
    buttons[next].focus()
  })
  return {
    element: bar,
    setDisabled(disabled) {
      for (const button of buttons) button.disabled = disabled
    },
  }
}
