// CodeMirror in the member's theme (the page editor, frontend/edit/; the Wolfram notebook,
// frontend/wolfram-notebook/). The highlight style is @codemirror/language's defaultHighlightStyle
// (MIT, (C) 2018-2021 Marijn Haverbeke and others, version 6.12.4), with each of its colors as the
// fallback of the code token for its role, so the site's own look is exactly as before; which
// token each tag takes follows base16's styling guide, as @catppuccin/codemirror (MIT) does.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { tags as t } from "@lezer/highlight"

const token = (name, color) => `var(--${name}, ${color})`

export const highlightStyle = HighlightStyle.define([
  { tag: t.meta, color: token("syn-comment", "#404740") },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.heading, textDecoration: "underline", fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.keyword, color: token("syn-keyword", "#708") },
  {
    tag: [t.atom, t.bool, t.url, t.contentSeparator, t.labelName],
    color: token("syn-constant", "#219"),
  },
  { tag: [t.literal, t.inserted], color: token("syn-string", "#164") },
  { tag: [t.string, t.deleted], color: token("syn-string", "#a11") },
  { tag: [t.regexp, t.escape, t.special(t.string)], color: token("syn-support", "#e40") },
  { tag: t.definition(t.variableName), color: token("syn-function", "#00f") },
  { tag: t.local(t.variableName), color: token("syn-variable", "#30a") },
  { tag: [t.typeName, t.namespace], color: token("syn-class", "#085") },
  { tag: t.className, color: token("syn-class", "#167") },
  { tag: [t.special(t.variableName), t.macroName], color: token("syn-support", "#256") },
  { tag: t.definition(t.propertyName), color: token("syn-function", "#00c") },
  { tag: t.comment, color: token("syn-comment", "#940") },
  { tag: t.invalid, color: token("c-err", "#f00") },
])

export const highlighting = syntaxHighlighting(highlightStyle, { fallback: true })

/**
 * The parts of CodeMirror's own light look that would stay light on a dark theme: selection,
 * cursor, the search panel and tooltips. Each keeps CodeMirror's color as its fallback.
 */
export const editorChrome = EditorView.theme({
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: token("c-strong", "black") },
  ".cm-selectionBackground": { background: token("c-surface-2", "#d9d9d9") },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: token("c-info-soft", "#d7d4f0"),
  },
  ".cm-activeLineGutter": { backgroundColor: token("c-surface-2", "#e2f2ff") },
  ".cm-panels": {
    backgroundColor: token("c-surface-1", "#f5f5f5"),
    color: token("c-strong", "black"),
  },
  ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${token("c-rule", "#ddd")}` },
  ".cm-tooltip": {
    backgroundColor: token("c-surface-1", "#f5f5f5"),
    border: `1px solid ${token("c-rule", "#bbb")}`,
    color: "inherit",
  },
  ".cm-textfield": { backgroundColor: "inherit", color: "inherit" },
})
