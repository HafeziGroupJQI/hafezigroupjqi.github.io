import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { assetRefs, problems, renderDirsIn, renderIpynb, stage1 } from "./render-notebooks.mjs"

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "render-notebooks-"))
const hex = (c) => c.repeat(64)

test("assetRefs finds every asset a render cites, in objects and in HTML tokens", () => {
  const refs = assetRefs({
    blocks: [
      { t: "output", out: { kind: "image", asset: { sha: hex("a"), ext: "svg", width: 1 } } },
      { t: "p", html: `x <img src="{{asset:${hex("b")}.png}}">` },
      { t: "output", out: { kind: "manipulate", frames: [{ sha: hex("c"), ext: "png" }] } },
      { t: "input", code: "{sha: 1}", sha: "not-a-sha" },
    ],
  })
  assert.deepEqual([...refs].sort(), [`${hex("a")}.svg`, `${hex("b")}.png`, `${hex("c")}.png`])
})

test("renderDirsIn accepts one stage-1 dir or a directory of them", () => {
  const dir = temp()
  for (const name of ["0", "1", "junk"]) fs.mkdirSync(path.join(dir, name))
  fs.writeFileSync(path.join(dir, "0", "render.json"), "{}")
  fs.writeFileSync(path.join(dir, "1", "render.json"), "{}")
  assert.deepEqual(
    renderDirsIn(dir)
      .map((d) => path.basename(d))
      .sort(),
    ["0", "1"],
  )
  assert.deepEqual(renderDirsIn(path.join(dir, "0")), [path.join(dir, "0")])
})

test("stage1 drops the renders an earlier run left in its output dir", () => {
  const dir = temp()
  const out = path.join(dir, "out")
  // Last run rendered the notebook at its old path; this run's stand-in renders only the new one.
  fs.mkdirSync(path.join(out, "notebooks", "old"), { recursive: true })
  fs.writeFileSync(
    path.join(out, "notebooks", "old", "a.nb.json"),
    JSON.stringify({ source_sha: hex("a") }),
  )
  const fake = path.join(dir, "wolframscript")
  fs.writeFileSync(
    fake,
    `#!/bin/sh
while [ "$1" != --out ]; do shift; done
mkdir -p "$2/notebooks/new" && echo '{"source_sha":"${hex("a")}"}' > "$2/notebooks/new/a.nb.json"
echo '{"failed":[]}' > "$2/render.json"
`,
    { mode: 0o755 },
  )
  const saved = process.env.WOLFRAMSCRIPT
  process.env.WOLFRAMSCRIPT = fake
  try {
    stage1({ root: dir, out, cache: path.join(dir, "cache") })
  } finally {
    if (saved === undefined) delete process.env.WOLFRAMSCRIPT
    else process.env.WOLFRAMSCRIPT = saved
  }
  assert.ok(!fs.existsSync(path.join(out, "notebooks", "old")), "the stale render is gone")
  assert.ok(fs.existsSync(path.join(out, "notebooks", "new", "a.nb.json")))
})

test("problems fails the build on a missing render, a conflict, failed cells or a Quarto error", () => {
  const report = {
    wolfram: {
      missing: [{ source: "a.nb", source_sha: "f" }],
      conflicts: [{ source: "b.nb", page: "b.md" }],
      failed_notebooks: ["c.nb"],
    },
    jupyter: { conflicts: [], errors: [{ source: "d.ipynb", error: "boom" }] },
  }
  assert.deepEqual(problems(report), [
    "no render of a.nb (sha256 f) in this deploy",
    "b.nb: a page b.md already exists",
    "c.nb: cells failed to render",
    "d.ipynb: boom",
  ])
})

const quarto = spawnSync("sh", ["-c", "command -v quarto"], { encoding: "utf8" }).stdout.trim()

test(
  "renderIpynb makes a page from the saved outputs without running the notebook",
  { skip: !quarto && "quarto not installed" },
  () => {
    const dir = temp()
    const content = path.join(dir, "content")
    fs.mkdirSync(path.join(content, "code"), { recursive: true })
    // A 1x1 red PNG as a saved output, and a cell that would fail if it were executed.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
      cells: [
        {
          cell_type: "markdown",
          id: "a",
          metadata: {},
          source: [
            "# Ring sweep\n",
            "Notes on \\(t^2 + \\kappa^2 = 1\\).\n",
            "\n",
            "\\begin{align}\n",
            "T &= |H|^2\n",
            "\\end{align}\n",
          ],
        },
        {
          cell_type: "code",
          id: "b",
          metadata: {},
          execution_count: 1,
          source: ["raise SystemExit('this notebook must not be executed')"],
          outputs: [
            { output_type: "stream", name: "stdout", text: ["saved output\n"] },
            {
              output_type: "display_data",
              metadata: {},
              data: { "image/png": png, "text/plain": ["<Figure>"] },
            },
          ],
        },
      ],
    }
    const file = path.join(content, "code", "sweep.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const result = renderIpynb(file, content, { quarto })
    assert.equal(result.error, undefined, result.error)
    assert.equal(result.page, "code/sweep.md")
    assert.equal(result.kernel, "python3")
    const page = fs.readFileSync(path.join(content, "code", "sweep.md"), "utf8")
    assert.match(
      page,
      /^---\ntitle: Ring sweep\ntags:\n {2}- internal\n {2}- notebook\n {2}- notebook\/jupyter\n/,
    )
    assert.match(page, /rendered_from: code\/sweep.ipynb/)
    // Math as Jupyter writes it: \(…\) and LaTeX environments are kept as math.
    assert.match(page, /\$t\^2 \+ \\kappa\^2 = 1\$/)
    assert.match(page, /\$\$\\begin\{align\}\nT &= \|H\|\^2\n\\end\{align\}\$\$/)
    assert.match(page, /saved output/)
    assert.match(
      page,
      /Rendered from <a class="internal" href="\/code\/sweep.ipynb">sweep.ipynb<\/a>/,
    )
    assert.ok(result.figures >= 1, "the saved figure is written next to the page")
    // A second render refuses to overwrite the page it made (or a hand-written one).
    assert.deepEqual(renderIpynb(file, content, { quarto }), {
      source: "code/sweep.ipynb",
      conflict: "code/sweep.md",
    })

    // The page cache: a second deploy of the same notebook doesn't run Quarto at all (this stand-in
    // reports the same version but fails if asked to render); a changed notebook renders again.
    const version = spawnSync(quarto, ["--version"], { encoding: "utf8" }).stdout.trim()
    const noRender = path.join(dir, "quarto-that-must-not-render")
    fs.writeFileSync(
      noRender,
      `#!/bin/sh\n[ "$1" = --version ] && echo ${version} && exit 0\nexit 1\n`,
      { mode: 0o755 },
    )
    const cache = path.join(dir, "cache")
    const clear = () => {
      fs.rmSync(path.join(content, "code", "sweep.md"), { force: true })
      fs.rmSync(path.join(content, "code", "sweep_files"), { recursive: true, force: true })
    }
    clear()
    assert.equal(renderIpynb(file, content, { quarto, cache }).cache, "miss")
    const made = fs.readFileSync(path.join(content, "code", "sweep.md"))
    clear()
    const again = renderIpynb(file, content, { quarto: noRender, cache })
    assert.equal(again.cache, "hit")
    assert.deepEqual(fs.readFileSync(path.join(content, "code", "sweep.md")), made)
    assert.ok(again.figures >= 1)
    clear()
    notebook.cells[0].source = ["# Ring sweep, revised\n"]
    fs.writeFileSync(file, JSON.stringify(notebook))
    assert.match(renderIpynb(file, content, { quarto: noRender, cache }).error ?? "", /./)
  },
)
