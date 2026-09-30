import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  cellText,
  clearOutputs,
  jsonString,
  newCell,
  notebookLayout,
  notebookMarkdown,
  parseJson,
  serializeJson,
  setCellText,
} from "./notebook.js"

const here = path.dirname(fileURLToPath(import.meta.url))
// One notebook per layout the vault's notebooks come in, each written by Python's json.dumps:
// nbformat's (indent 1, sorted keys, final newline), Colab's (minified, non-ASCII escaped) and
// indent 2 unsorted with no final newline.
const FIXTURES = ["nbformat", "colab", "indent2"]
const fixture = (name) => fs.readFileSync(path.join(here, "fixtures", `${name}.ipynb`), "utf8")

test("each layout writes its notebook back byte for byte", () => {
  const layouts = Object.fromEntries(FIXTURES.map((name) => [name, notebookLayout(fixture(name))]))
  assert.deepEqual(layouts.nbformat, {
    indent: 1,
    item: ",",
    key: ": ",
    ascii: false,
    sortKeys: true,
    newline: true,
  })
  assert.deepEqual(layouts.colab, {
    indent: null,
    item: ",",
    key: ":",
    ascii: true,
    sortKeys: false,
    newline: false,
  })
  assert.deepEqual(layouts.indent2, {
    indent: 2,
    item: ",",
    key: ": ",
    ascii: false,
    sortKeys: false,
    newline: false,
  })
  for (const name of FIXTURES) {
    const raw = fixture(name)
    assert.equal(serializeJson(parseJson(raw), layouts[name]), raw, name)
  }
})

test("numbers, key order and odd keys stay as written", () => {
  const raw = '{"b":1e-05,"a":[1.50,-0,2E10],"0":{"z":true,"y":null}}'
  const layout = notebookLayout(raw)
  assert.ok(layout)
  assert.equal(serializeJson(parseJson(raw), layout), raw)
  // Python's escapes: control characters as \u00xx, ensure_ascii for all but printable ASCII.
  assert.equal(jsonString('a"\\\n\t\u001b\u007f é 😀', false), '"a\\"\\\\\\n\\t\\u001b\u007f é 😀"')
  assert.equal(jsonString("\u007f é 😀", true), '"\\u007f \\u00e9 \\ud83d\\ude00"')
  // A layout that doesn't write the file back is none.
  assert.equal(notebookLayout('{"a": 1,\n  "b": 2}'), null)
  assert.throws(() => parseJson('{"a": 1,}'), SyntaxError)
})

test("editing one cell changes only that cell's source in the file", () => {
  for (const name of FIXTURES) {
    const raw = fixture(name)
    const layout = notebookLayout(raw)
    const notebook = parseJson(raw)
    const cell = notebook.get("cells")[1]
    const before = cellText(cell)
    setCellText(cell, before.replace(/\n?$/, "\n# edited ✓"))
    const edited = serializeJson(notebook, layout)
    assert.notEqual(edited, raw, name)
    // What changed is that cell's source, and nothing else.
    const again = parseJson(edited)
    assert.equal(cellText(again.get("cells")[1]), before.replace(/\n?$/, "\n# edited ✓"))
    setCellText(again.get("cells")[1], before)
    assert.equal(serializeJson(again, layout), raw, name)
    if (layout.indent !== null) {
      // Between the lines both share at the start and at the end, only the cell's last lines.
      const a = raw.split("\n")
      const b = edited.split("\n")
      let start = 0
      while (a[start] === b[start]) start++
      let end = 0
      while (a.at(-1 - end) === b.at(-1 - end)) end++
      const changed = b.slice(start, b.length - end)
      assert.ok(changed.length <= 2, `${name}: ${changed.join(" | ")}`)
      assert.ok(
        changed.every((line) => /edited|kappa|Floating|print|0\.1/.test(line)),
        name,
      )
    }
  }
})

test("a cell keeps the form its source had: lines, or one string", () => {
  const notebook = parseJson(fixture("nbformat"))
  const [markdown, code, string, raw] = notebook.get("cells")
  setCellText(markdown, "# One\n\nTwo")
  assert.deepEqual(markdown.get("source"), ["# One\n", "\n", "Two"])
  setCellText(string, "x = 2\n")
  assert.equal(string.get("source"), "x = 2\n")
  setCellText(raw, "")
  assert.deepEqual(raw.get("source"), [])
  clearOutputs(code)
  assert.deepEqual(code.get("outputs"), [])
  assert.equal(code.get("execution_count"), null)
})

test("a new cell has the keys the notebook's cells have, sorted where the file sorts them", () => {
  const nbformat = parseJson(fixture("nbformat"))
  const layout = notebookLayout(fixture("nbformat"))
  const code = newCell(nbformat, "code", layout)
  assert.deepEqual(code.keys(), [
    "cell_type",
    "execution_count",
    "id",
    "metadata",
    "outputs",
    "source",
  ])
  assert.match(code.get("id"), /^[0-9a-f]{8}$/)
  const colab = parseJson(fixture("colab"))
  assert.deepEqual(newCell(colab, "markdown", notebookLayout(fixture("colab"))).keys(), [
    "cell_type",
    "source",
    "metadata",
  ])
  nbformat.get("cells").splice(1, 0, code)
  setCellText(code, "print(1)")
  assert.match(serializeJson(nbformat, layout), /"source": \[\n {4}"print\(1\)"\n {3}\]/)
})

test("the preview reads a notebook as Markdown with its code and text outputs", () => {
  const markdown = notebookMarkdown(parseJson(fixture("nbformat")))
  assert.match(markdown, /^# Ring résonator 🔬\n/)
  assert.match(
    markdown,
    /```python\nimport numpy as np\n[\s\S]*```\n\n```text\nkappa = 1e-05\ndone\n```/,
  )
  assert.match(markdown, /```text\n<Figure size 640x480 with 1 Axes>\n```/)
})

// Every notebook of the private vault, when a checkout of it sits beside the website (as on the
// lab's machines): each one's own layout writes it back unchanged.
const vault = path.resolve(here, "../../../vault-private")
test(
  "every notebook in the private vault keeps its bytes",
  { skip: !fs.existsSync(path.join(vault, ".git")) },
  () => {
    const files = execFileSync("git", ["-C", vault, "ls-files", "-z", "*.ipynb"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
    assert.ok(files.length > 0)
    for (const file of files) {
      const raw = fs.readFileSync(path.join(vault, file), "utf8")
      const layout = notebookLayout(raw)
      assert.ok(layout, `${file}: no layout writes it back`)
      assert.equal(serializeJson(parseJson(raw), layout), raw, file)
    }
  },
)
