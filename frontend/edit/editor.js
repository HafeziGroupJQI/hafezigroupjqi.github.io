// The page editor's CodeMirror 6 source editor (index.js loads it with the page): Markdown with its
// YAML front matter, fenced code highlighted by its language (a Quarto chunk's {python} too), search,
// undo, and the file's own line separator kept, so a file saved unchanged is byte-identical.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { yamlFrontmatter } from "@codemirror/lang-yaml"
import {
  LanguageDescription,
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language"
import { languages } from "@codemirror/language-data"
import { json } from "@codemirror/legacy-modes/mode/javascript"
import { StreamLanguage } from "@codemirror/language"
import { unifiedMergeView } from "@codemirror/merge"
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search"
import { Compartment, EditorState } from "@codemirror/state"
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import { h } from "../dashboard/dom.js"

const theme = EditorView.theme({
  "&": { fontSize: "0.9rem", backgroundColor: "#fff", height: "100%" },
  ".cm-scroller": { fontFamily: "var(--codeFont, ui-monospace, monospace)", lineHeight: "1.5" },
  ".cm-gutters": { backgroundColor: "#fafafa", borderRight: "1px solid #eee", color: "#999" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { padding: "8px 0" },
})

/** A fenced block's language: its info string's first word, a Quarto chunk's inside its braces. */
export function codeLanguage(info) {
  const name = info
    .trim()
    .replace(/^\{\s*/, "")
    .split(/[\s,}]/)[0]
  return name ? LanguageDescription.matchLanguageName(languages, name, true) : null
}

function language(kind) {
  if (kind === "ipynb") return StreamLanguage.define(json)
  return yamlFrontmatter({
    content: markdown({ base: markdownLanguage, codeLanguages: codeLanguage }),
  })
}

/**
 * Mount an editor for a file of `kind` (md, qmd, ipynb) in `parent`. `onChange(text)` follows
 * every edit, `onSave()` is Ctrl/⌘+S. Returns the view and what the page needs of it.
 */
export function createSourceEditor(parent, text, { kind, separator, readOnly, onChange, onSave }) {
  const merge = new Compartment()
  const editable = new Compartment()
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        EditorState.lineSeparator.of(separator),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        bracketMatching(),
        search({ top: true }),
        highlightSelectionMatches(),
        language(kind),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSave?.()
              return true
            },
          },
          indentWithTab,
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": `Source of the page (${kind})` }),
        editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        merge.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange?.(update.state.doc.toString())
        }),
        theme,
      ],
    }),
  })
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText: (next) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } }),
    focus: () => view.focus(),
    /**
     * Mark where this text differs from `original` (main's newer version of the file): each
     * difference can be kept as the member wrote it, or taken from main. null ends it.
     */
    compareWith(original) {
      view.dispatch({
        effects: merge.reconfigure(
          original === null
            ? []
            : unifiedMergeView({
                original,
                gutter: true,
                mergeControls: (type, action) =>
                  h("button", {
                    type: "button",
                    class: `edit-merge-${type}`,
                    text: type === "accept" ? "Keep mine" : "Take main's",
                    onmousedown: action,
                  }),
              }),
        ),
      })
    },
  }
}
