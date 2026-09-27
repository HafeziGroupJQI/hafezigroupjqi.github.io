import test from "node:test"
import assert from "node:assert/strict"
import { MAX_CONTEXT, fenceLang, gptContext, insertMessage } from "./gpt.js"

const kernel = { name: "hafezi-gds", display_name: "IPython · GDS", language: "python" }

test("a notebook cell with a traceback becomes a labelled, fenced context", () => {
  const ctx = gptContext({
    file: "projects/rings/analysis.ipynb",
    kernel,
    cell: { type: "code", index: 2, source: "np.arange(0, 1, 0.1" },
    selection: "",
    outputs: ["SyntaxError: '(' was never closed"],
    neighbors: [{ position: "before", type: "markdown", source: "## Sweep" }],
  })
  assert.equal(ctx.label, "analysis.ipynb · cell 3 (IPython · GDS)")
  assert.match(
    ctx.text,
    /^File: `projects\/rings\/analysis\.ipynb` · kernel: IPython · GDS \(python\)/,
  )
  assert.match(ctx.text, /Cell 3:\n```python\nnp\.arange\(0, 1, 0\.1\n```/)
  assert.match(ctx.text, /Its outputs \(latest last\):\n```\nSyntaxError/)
  assert.match(ctx.text, /Nearby cells:\nBefore \(markdown\):\n```\n## Sweep\n```/)
})

test("code containing backticks gets a longer fence; Wolfram kernels fence as wolfram", () => {
  const ctx = gptContext({
    kernel: { name: "wolfram", display_name: "Wolfram", language: "Wolfram Language" },
    cell: { type: "code", index: 0, source: 's = "```"' },
  })
  assert.match(ctx.text, /````wolfram\ns = "```"\n````/)
  assert.equal(ctx.label, "Scratchpad · cell 1 (Wolfram)")
  assert.equal(fenceLang({ language: "mathematica" }), "wolfram")
  assert.equal(fenceLang({ language: "bad lang!" }), "")
})

test("a selection alone is enough; empty or junk context sends nothing", () => {
  assert.match(
    gptContext({ selection: " plt.show() ", kernel }).text,
    /Selected text:\n```python\nplt\.show\(\)\n```/,
  )
  assert.equal(gptContext({ cell: { type: "code", source: "  " }, outputs: [] }), null)
  assert.equal(gptContext(null), null)
  assert.equal(gptContext("x"), null)
})

test("context stays under the Worker's limit", () => {
  const ctx = gptContext({ kernel, cell: { type: "code", index: 0, source: "x".repeat(60_000) } })
  assert.ok(ctx.text.length < 40_000)
  assert.ok(ctx.text.length > MAX_CONTEXT)
  assert.match(ctx.text, /characters truncated\]$/)
})

test("insert messages match what the lab's gpt-bridge accepts", () => {
  assert.deepEqual(insertMessage("replace", "x = 1"), {
    type: "hafezi-gpt:insert",
    mode: "replace",
    code: "x = 1",
  })
  assert.equal(insertMessage("anything", "y").mode, "below")
})
