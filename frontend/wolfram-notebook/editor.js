// CodeMirror 6 editor for Wolfram notebook cells, loaded on the first Edit click (index.js imports it lazily).
// Wolfram syntax via the legacy Mathematica stream mode; completion from the renderer's symbols.json.

import { autocompletion } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { StreamLanguage, bracketMatching } from "@codemirror/language"
import { mathematica } from "@codemirror/legacy-modes/mode/mathematica"
import { EditorState } from "@codemirror/state"
import { EditorView, keymap, lineNumbers } from "@codemirror/view"
import { matchSymbols } from "./cells.js"

const language = StreamLanguage.define(mathematica)

const theme = EditorView.theme({
  "&": { fontSize: "0.9rem", backgroundColor: "transparent" },
  ".cm-content": { fontFamily: "var(--codeFont, ui-monospace, monospace)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--gray)" },
  "&.cm-focused": { outline: "none" },
})

/**
 * Mount an editor in `parent` holding `code`. `symbols()` resolves to [{name, usage}] (fetched
 * once per page). `onRun` fires on Shift+Enter / Mod+Enter. Returns {view, getCode, focus}.
 */
export function createEditor(parent, code, { symbols, onRun }) {
  const complete = async (context) => {
    const word = context.matchBefore(/\$?[A-Za-z][A-Za-z0-9$]*/)
    if (!word || (word.from === word.to && !context.explicit)) return null
    const list = await symbols()
    const options = matchSymbols(list, word.text).map((symbol) => ({
      label: symbol.name,
      type: "function",
      info: symbol.usage || undefined,
    }))
    return options.length ? { from: word.from, options, validFor: /^\$?[A-Za-z0-9$]*$/ } : null
  }
  const run = () => {
    onRun?.()
    return true
  }
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: code,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        language,
        highlighting,
        editorChrome,
        autocompletion({ override: [complete] }),
        keymap.of([
          { key: "Shift-Enter", run },
          { key: "Mod-Enter", run },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        theme,
      ],
    }),
  })
  return { view, getCode: () => view.state.doc.toString(), focus: () => view.focus() }
}
