import assert from "node:assert/strict"
import test from "node:test"
import { toHtml } from "hast-util-to-html"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import { remarkEmDashes } from "./index.js"

const render = (markdown) => {
  const processor = unified().use(remarkParse).use(remarkEmDashes).use(remarkRehype)
  return toHtml(processor.runSync(processor.parse(markdown)))
}

test("--- in text is an em dash, in headings too", () => {
  assert.equal(render("# FDTD --- the workhorse"), "<h1>FDTD — the workhorse</h1>")
  assert.equal(
    render("trivial --- just\nevaluate ---then"),
    "<p>trivial \u2014 just\nevaluate \u2014then</p>",
  )
})

test("code, names, rules and longer runs keep their hyphens", () => {
  assert.equal(render("`a --- b`"), "<p><code>a --- b</code></p>")
  assert.equal(render("```\nx --- y\n```"), "<pre><code>x --- y\n</code></pre>")
  assert.equal(
    render("Directional-coupler-simulations---Lumerical-FDTD"),
    "<p>Directional-coupler-simulations---Lumerical-FDTD</p>",
  )
  assert.equal(render("a ---- b"), "<p>a ---- b</p>")
  assert.equal(render("Text\n\n---\n\nMore"), "<p>Text</p>\n<hr>\n<p>More</p>")
})
