import assert from "node:assert/strict"
import test from "node:test"
import plugin, { css, script, sourceOf } from "./index.js"

// A stand-in for a <code> element: just what sourceOf reads.
const code = ({ clipboard = null, textContent = "", innerText = "" } = {}) => ({
  getAttribute: (name) => (name === "data-clipboard" ? clipboard : null),
  textContent,
  innerText,
})

test("copies a block's code as written, whether or not it is shown", () => {
  // Safari's innerText is empty for a block inside a closed <details>; textContent is not.
  assert.equal(sourceOf(code({ textContent: "a = 1\n\nb = 2", innerText: "" })), "a = 1\n\nb = 2")
  assert.equal(sourceOf(code({ textContent: "", innerText: "x" })), "x")
  assert.equal(sourceOf(code()), "")
})

test("prefers a block's data-clipboard source, and ignores one that is not a JSON string", () => {
  assert.equal(
    sourceOf(code({ clipboard: JSON.stringify("graph TD; A-->B"), textContent: "svg" })),
    "graph TD; A-->B",
  )
  assert.equal(sourceOf(code({ clipboard: "{not json", textContent: "kept" })), "kept")
  assert.equal(sourceOf(code({ clipboard: "42", textContent: "kept" })), "kept")
})

test("the page script parses, reads the block at click time and falls back to manual copying", () => {
  assert.doesNotThrow(() => new Function(script))
  assert.match(script, /var text=sourceOf\(code\)/)
  assert.match(script, /execCommand\("copy"\)/)
  assert.match(script, /navigator\.clipboard\.writeText/)
  assert.match(script, /selectCode\(code\)/)
})

test("shows the button on hover, focus and touch, and hides it in print", () => {
  assert.match(css, /pre:focus-within > \.clipboard-button/)
  assert.match(css, /@media \(hover: none\)/)
  assert.match(css, /@media print \{\s*\.clipboard-button \{\s*display: none;/)
})

test("the site's stylesheet wraps code only where a member chose it", async () => {
  const { readFile } = await import("node:fs/promises")
  const scss = await readFile(new URL("../../../styles/custom.scss", import.meta.url), "utf8")
  assert.match(
    scss,
    /html\[data-code-wrap="on"\] pre > code \{\s*grid-template-columns: minmax\(0, 1fr\);/,
  )
  assert.match(scss, /white-space: pre-wrap;\s*overflow-wrap: anywhere;/)
  assert.doesNotMatch(scss, /data-code-wrap="off"\]/)
})

test("ships the script after the page is ready and the styles inline", () => {
  // Quartz skips a transformer without textTransform, markdownPlugins or htmlPlugins.
  assert.deepEqual(plugin().htmlPlugins(), [])
  const { js, css: styles } = plugin().externalResources()
  assert.deepEqual(js, [{ script, loadTime: "afterDOMReady", contentType: "inline" }])
  assert.deepEqual(styles, [{ content: css, inline: true }])
})
