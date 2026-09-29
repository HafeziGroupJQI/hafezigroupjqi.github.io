import assert from "node:assert/strict"
import test from "node:test"
import {
  convertNotebook,
  downloadFormats,
  inlineFigures,
  notebookToMarkdown,
  notebookToQmd,
  stripAnsi,
} from "./exporting.js"

// Adapted from compute's labextensions/test/exporting.test.mts, with notebooks as an .ipynb file
// stores them (multiline strings as arrays of lines).
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=="

const notebook = () => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
    language_info: { name: "python", version: "3.12" },
  },
  cells: [
    { cell_type: "markdown", id: "m", metadata: {}, source: ["# Ring sweep\n", "Notes."] },
    {
      cell_type: "code",
      id: "a",
      metadata: {},
      execution_count: 1,
      source: ["x = 1\n", "print(x)"],
      outputs: [{ output_type: "stream", name: "stdout", text: ["1\n"] }],
    },
    {
      cell_type: "code",
      id: "b",
      metadata: {},
      execution_count: 2,
      source: "plot()",
      outputs: [
        {
          output_type: "display_data",
          data: { "image/png": PNG + "\n", "text/plain": "<Figure size 640x480 with 1 Axes>" },
          metadata: {},
        },
        {
          output_type: "execute_result",
          data: { "text/plain": ["42"] },
          metadata: {},
          execution_count: 2,
        },
      ],
    },
    {
      cell_type: "code",
      id: "c",
      metadata: {},
      execution_count: 3,
      source: "1/0",
      outputs: [
        {
          output_type: "error",
          ename: "ZeroDivisionError",
          evalue: "division by zero",
          traceback: ["\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"],
        },
      ],
    },
  ],
})

test("markdown export writes figures/ and keeps text and errors", () => {
  const { markdown, files } = notebookToMarkdown(notebook(), {
    baseName: "My Sweep.ipynb",
    title: "My Sweep",
  })
  assert.equal(files.length, 1)
  assert.deepEqual(files[0], { path: "figures/my-sweep-1.png", content: PNG, format: "base64" })
  assert.match(markdown, /^# My Sweep\n\n# Ring sweep\nNotes\.\n/)
  assert.match(markdown, /```python\nx = 1\nprint\(x\)\n```/)
  assert.match(markdown, /```text\n1\n```/)
  assert.match(markdown, /!\[Figure 1\]\(figures\/my-sweep-1\.png\)/)
  assert.match(markdown, /```text\n42\n```/)
  assert.match(markdown, /ZeroDivisionError: division by zero/)
  assert.doesNotMatch(markdown, /\u001b/)
})

test("markdown export: svg as text, latex and markdown outputs inline", () => {
  const nb = {
    metadata: { kernelspec: { name: "wolfram", language: "Wolfram Language" } },
    cells: [
      {
        cell_type: "code",
        source: "Plot[Sin[x], {x, 0, 1}]",
        outputs: [
          {
            output_type: "execute_result",
            data: { "image/svg+xml": ["<svg>", "</svg>"], "text/plain": "Graphics" },
          },
          { output_type: "display_data", data: { "text/latex": "x^2" } },
          { output_type: "display_data", data: { "text/markdown": "**bold**" } },
        ],
      },
    ],
  }
  const { markdown, files } = notebookToMarkdown(nb, { baseName: "wl" })
  assert.deepEqual(files, [{ path: "figures/wl-1.svg", content: "<svg></svg>", format: "text" }])
  assert.match(markdown, /```wolfram\n/)
  assert.match(markdown, /!\[Graphics\]\(figures\/wl-1\.svg\)/)
  assert.match(markdown, /\$\$\nx\^2\n\$\$/)
  assert.match(markdown, /\*\*bold\*\*/)
})

test("code containing fences gets a longer fence", () => {
  const nb = { metadata: {}, cells: [{ cell_type: "code", source: 's = """```"""', outputs: [] }] }
  assert.match(notebookToMarkdown(nb, { baseName: "x" }).markdown, /^````python\n/)
})

test("qmd has jupyter front matter and chunks, and no outputs", () => {
  const q = notebookToQmd(notebook(), "Session")
  assert.match(q, /^---\ntitle: "Session"\njupyter:\n {2}kernelspec:\n {4}name: python3\n/)
  assert.match(q, /```\{python\}\nx = 1\nprint\(x\)\n```/)
  assert.doesNotMatch(q, /42/, "outputs are not part of qmd")
  assert.equal(stripAnsi("\u001b[1;31mred\u001b[0m"), "red")
})

test("figures are inlined as data: URLs, since a download is one file", () => {
  const svg = '<svg viewBox="0 0 1 1"><path transform="translate(1 2)" d="M0 0"/></svg>'
  const markdown = inlineFigures("![a](figures/x-1.png)\n\n![b](figures/x-2.svg)\n", [
    { path: "figures/x-1.png", content: PNG, format: "base64" },
    { path: "figures/x-2.svg", content: svg, format: "text" },
  ])
  assert.ok(markdown.startsWith(`![a](data:image/png;base64,${PNG})\n\n![b](data:image/svg+xml,`))
  const url = markdown.match(/!\[b\]\((data:image\/svg\+xml,[^)\s]+)\)/)[1]
  assert.equal(decodeURIComponent(url.slice("data:image/svg+xml,".length)), svg)
})

test("a notebook page downloads as its raw file, Quarto or Markdown; other pages have no choice", () => {
  assert.deepEqual(
    downloadFormats("01_ring.ipynb").map((option) => option.format),
    ["ipynb", "qmd", "md"],
  )
  for (const name of ["bend-optimization.qmd", "EIWL3-01.nb", ""])
    assert.deepEqual(downloadFormats(name), [])

  const text = JSON.stringify(notebook())
  const qmd = convertNotebook(text, "qmd", "01_ring.ipynb")
  assert.equal(qmd.name, "01_ring.qmd")
  assert.equal(qmd.type, "text/markdown;charset=utf-8")
  assert.match(qmd.text, /^---\ntitle: "01_ring"\n/)
  const md = convertNotebook(text, "md", "01_ring.ipynb")
  assert.equal(md.name, "01_ring.md")
  assert.match(md.text, /^# 01_ring\n/)
  assert.match(md.text, /!\[Figure 1\]\(data:image\/png;base64,iVBOR/)
  assert.doesNotMatch(md.text, /figures\//)

  assert.throws(() => convertNotebook("{}", "md", "x.ipynb"), /not a Jupyter notebook/)
  assert.throws(() => convertNotebook("<html>", "md", "x.ipynb"), SyntaxError)
  assert.throws(() => convertNotebook(text, "nb", "x.ipynb"), /no conversion to \.nb/)
})
