import assert from "node:assert/strict"
import test from "node:test"
import { diffHtml } from "./diff.js"

const before = "---\ntitle: Ada\n---\n\nShe wrote the first program.\n"

test("shows a revision's HTML and scripts as text, never as markup", () => {
  const after =
    before +
    '<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n<a href="javascript:alert(3)">x</a>\n'
  const html = diffHtml(before, after)
  assert.doesNotMatch(html, /<script|<img|<a href="javascript/i)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;&#x2F;script&gt;/)
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt;/)
  // What was removed is escaped too.
  const removed = diffHtml(after, before)
  assert.doesNotMatch(removed, /<script|<img/i)
  assert.match(removed, /d2h-del/)
})

test("marks what changed, line by line or side by side", () => {
  const after = before.replace("first program", "first published program")
  const inline = diffHtml(before, after)
  assert.match(inline, /d2h-file-diff/)
  assert.match(inline, /<ins>published <\/ins>|<ins>published<\/ins>/)
  assert.match(diffHtml(before, after, { sideBySide: true }), /d2h-file-side-diff/)
  assert.match(diffHtml(before, after, { dark: true }), /d2h-dark-color-scheme/)
  // The same text twice has nothing to show.
  assert.equal(diffHtml(before, before), null)
  // A new file is all additions.
  assert.match(diffHtml("", before), /d2h-ins/)
})
