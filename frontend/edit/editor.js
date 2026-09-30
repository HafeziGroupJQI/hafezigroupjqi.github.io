// The page editor's CodeMirror 6 source editor (index.js loads it with the page): Markdown with its
// YAML front matter, fenced code highlighted by its language (a Quarto chunk's {python} too), search,
// undo, and the file's own line separator kept, so a file saved unchanged is byte-identical.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { yamlFrontmatter } from "@codemirror/lang-yaml"
import { LanguageDescription, bracketMatching } from "@codemirror/language"
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
import { editorChrome, highlighting } from "../theme/highlight.js"

const theme = EditorView.theme({
  "&": { fontSize: "0.9rem", backgroundColor: "var(--light, #fff)", height: "100%" },
  ".cm-scroller": { fontFamily: "var(--codeFont, ui-monospace, monospace)", lineHeight: "1.5" },
  ".cm-gutters": {
    backgroundColor: "var(--c-surface-1, #fafafa)",
    borderRight: "1px solid var(--c-rule, #eee)",
    color: "var(--c-muted, #999)",
  },
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

/** Ctrl/⌘+S saves (the browser's own save would download the page). */
const saveKey = (onSave) => ({
  key: "Mod-s",
  preventDefault: true,
  run: () => {
    onSave?.()
    return true
  },
})

const cellTheme = EditorView.theme({
  "&": { fontSize: "0.88rem", backgroundColor: "var(--c-surface-1, #fafafa)" },
  ".cm-scroller": { fontFamily: "var(--codeFont, ui-monospace, monospace)", lineHeight: "1.45" },
  "&.cm-focused": { outline: "1px solid var(--c-rule, #bbb)" },
  ".cm-content": { padding: "6px 8px" },
})

/**
 * One notebook cell's editor (cells.js): its code (Python, the notebook's language) or its
 * Markdown, with undo and search but no line numbers. `onChange(text)` follows every edit.
 */
export function createCellEditor(parent, text, { type, readOnly, onChange, onSave }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        drawSelection(),
        bracketMatching(),
        search({ top: true }),
        type === "code"
          ? python()
          : type === "markdown"
            ? markdown({ base: markdownLanguage, codeLanguages: codeLanguage })
            : [],
        highlighting,
        editorChrome,
        keymap.of([
          saveKey(onSave),
          indentWithTab,
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": `${type} cell` }),
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange?.(update.state.doc.toString())
        }),
        cellTheme,
      ],
    }),
  })
  return { view, getText: () => view.state.doc.toString(), focus: () => view.focus() }
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
        highlighting,
        editorChrome,
        keymap.of([
          saveKey(onSave),
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
    setReadOnly: (readOnly) =>
      view.dispatch({
        effects: editable.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      }),
    previewMarkdown: () => view.state.doc.toString(),
    /**
     * Mark where this text differs from `original` (main's newer version of the file, or the
     * version another member sent): each difference can be kept as it is here, or taken from
     * `original`, with the buttons' words given. null ends it.
     */
    compareWith(original, { keep = "Keep mine", take = "Take main's" } = {}) {
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
                    text: type === "accept" ? keep : take,
                    onmousedown: action,
                  }),
              }),
        ),
      })
    },
  }
}
