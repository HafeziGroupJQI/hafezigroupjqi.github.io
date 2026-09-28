import assert from "node:assert/strict"
import test from "node:test"
import { Latex } from "@quartz-community/latex"
import { toHtml } from "hast-util-to-html"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import { fenceDisplayMath, remarkDisplayMath } from "./index.js"

// The site's own math pipeline: remark-math and KaTeX as @quartz-community/latex configures them.
const latex = Latex({ renderEngine: "katex" })
const render = (markdown) => {
  const text = fenceDisplayMath(markdown)
  const processor = unified()
    .use(remarkParse)
    .use(latex.markdownPlugins())
    .use(remarkDisplayMath)
    .use(remarkRehype)
    .use(latex.htmlPlugins())
  return toHtml(processor.runSync(processor.parse(text), { value: text }))
}
const count = (html, pattern) => html.match(pattern)?.length ?? 0

test("$$…$$ inside a paragraph is display math; $…$ stays inline", () => {
  const html = render("The through-port field:\n$$H = \\frac{t - a}{1 - ta}$$\nand $T = |H|^2$.")
  assert.equal(count(html, /class="katex-display"/g), 1)
  assert.equal(count(html, /class="katex"/g), 2)
})

test("an equation across lines is one display equation, and the page after it survives", () => {
  // How Quarto writes a notebook's equation, and how Pandoc Markdown writes one.
  const html = render(
    "Maxwell in 1D:\n$$\\partial_t E_z = \\partial_x H_y, \\qquad\n  \\partial_t H_y = \\partial_x E_z$$\n\n## Next\n\n```python\nx = 1\n```\n",
  )
  assert.equal(count(html, /class="katex-display"/g), 1)
  assert.equal(count(html, /katex-error/g), 0)
  assert.match(html, /<h2>Next<\/h2>/)
  assert.match(html, /<code class="language-python">x = 1/)
  // Text after the closing $$, and a LaTeX environment written the same way.
  const env = render("$$\\begin{align}\nE &= mc^2 \\\\\nF &= ma\n\\end{align}$$ and after.\n")
  assert.equal(count(env, /class="katex-display"/g), 1)
  assert.equal(count(env, /katex-error/g), 0)
  assert.match(env, /<p>and after\.<\/p>/)
  const quoted = render("> Q is\n> $$Q = \\frac{\\lambda}{\n> \\Delta\\lambda}$$\n")
  assert.match(quoted, /<blockquote>[\s\S]*katex-display[\s\S]*<\/blockquote>/)
})

test("fenced $$ blocks, code, output, frontmatter and HTML are left as written", () => {
  for (const text of [
    "Text.\n\n$$\nQ = \\frac{\\lambda}{\\Delta\\lambda}\n$$\n",
    "---\ntitle: $$a\nx: b$$\n---\nBody",
    "```sh\necho $$ is the\nshell pid $$\n```",
    "Output:\n\n    cost $$ in\n    total $$\n",
    '<pre class="wl-out">In[1]:= $$a\n$$b</pre>',
    "Inline `$$` code and\na price of \\$$5 and $$6.",
    "An unclosed $$ stays\nas it is.",
  ])
    assert.equal(fenceDisplayMath(text), text)
  assert.equal(count(render("Text.\n\n$$\nQ = 1\n$$\n"), /class="katex-display"/g), 1)
})
