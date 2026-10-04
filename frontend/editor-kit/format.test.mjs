import assert from "node:assert/strict"
import test from "node:test"
import { COMMANDS, apply, mapPos, selectedLines } from "./format.js"

// "|" marks the selection's ends in these cases: one | is a cursor, two a selection.
function run(name, marked) {
  const from = marked.indexOf("|")
  const to = marked.lastIndexOf("|") === from ? from : marked.lastIndexOf("|") - 1
  const text = marked.replace(/\|/g, "")
  const result = COMMANDS[name](text, from, to)
  const out = apply(text, result)
  const [a, b] = [result.anchor, result.head].sort((x, y) => x - y)
  return a === b
    ? out.slice(0, a) + "|" + out.slice(a)
    : out.slice(0, a) + "|" + out.slice(a, b) + "|" + out.slice(b)
}

test("bold, italic, code and math wrap a selection and unwrap it again", () => {
  assert.equal(run("bold", "a |word| b"), "a **|word|** b")
  assert.equal(run("bold", "a **|word|** b"), "a |word| b")
  assert.equal(run("bold", "a |**word**| b"), "a |word| b")
  assert.equal(run("italic", "a |word| b"), "a _|word|_ b")
  assert.equal(run("italic", "a _|word|_ b"), "a |word| b")
  assert.equal(run("code", "call |f(x)| now"), "call `|f(x)|` now")
  assert.equal(run("math", "so |x^2| is"), "so $|x^2|$ is")
  // Spaces a double-click took stay outside.
  assert.equal(run("bold", "a |word |b"), "a **|word|** b")
  // A cursor gets the pair.
  assert.equal(run("bold", "a |"), "a **|**")
  assert.equal(run("math", "|"), "$|$")
})

test("lists, quotes and headings start each selected line, and come off again", () => {
  assert.equal(run("bullet", "|one\ntwo|"), "- |one\n- two|")
  assert.equal(run("bullet", "|- one\n- two|"), "|one\ntwo|")
  assert.equal(run("number", "|one\ntwo\nthree|"), "1. |one\n2. two\n3. three|")
  assert.equal(run("number", "|- one\n- two|"), "1. |one\n2. two|")
  assert.equal(run("bullet", "|1. one\n2. two|"), "- |one\n- two|")
  assert.equal(run("quote", "a\n|said\nthis|\nb"), "a\n> |said\n> this|\nb")
  assert.equal(run("quote", "> |said|"), "|said|")
  assert.equal(run("heading", "Title|"), "## Title|")
  assert.equal(run("heading", "### Ti|tle"), "Ti|tle")
  // Blank lines inside a selection stay blank.
  assert.equal(run("bullet", "|a\n\nb|"), "- |a\n\n- b|")
  // A selection ending at a line's start leaves that line be.
  assert.equal(run("quote", "|a\n|b"), "> |a\n|b")
})

test("code and math blocks fence the lines, and the fences come off again", () => {
  assert.equal(
    run("codeblock", "x\n|print(1)\nprint(2)|\ny"),
    "x\n```\n|print(1)\nprint(2)|\n```\ny",
  )
  assert.equal(run("codeblock", "x\n```\n|print(1)|\n```\ny"), "x\n|print(1)|\ny")
  assert.equal(run("codeblock", "|```\nprint(1)\n```|"), "|print(1)|")
  assert.equal(run("codeblock", "|```\n```|"), "|")
  assert.equal(run("codeblock", "|"), "```\n|\n```")
  assert.equal(run("code", "|a\nb|"), "```\n|a\nb|\n```")
  assert.equal(run("math", "|a = b\nc = d|"), "$$\n|a = b\nc = d|\n$$")
  assert.equal(run("math", "$$\n|a = b|\n$$"), "|a = b|")
})

test("a link takes the selection as its text and selects the address to type", () => {
  assert.equal(run("link", "see |the docs| here"), "see [the docs](|url|) here")
  assert.equal(run("link", "|"), "[](|url|)")
  assert.equal(run("link", "|https://jqi.umd.edu|"), "[|](https://jqi.umd.edu)")
  assert.equal(run("link", "|/people/|"), "[|](/people/)")
})

test("maps positions past changes, and finds the selected lines", () => {
  const changes = [
    { from: 0, to: 0, insert: "> " },
    { from: 4, to: 6, insert: "" },
  ]
  assert.equal(mapPos(changes, 0), 2)
  assert.equal(mapPos(changes, 5), 6)
  assert.equal(mapPos(changes, 8), 8)
  assert.deepEqual(selectedLines("ab\ncd\nef", 1, 4), [
    { from: 0, to: 2 },
    { from: 3, to: 5 },
  ])
  assert.deepEqual(selectedLines("ab\ncd", 0, 3), [{ from: 0, to: 2 }])
  assert.deepEqual(selectedLines("", 0, 0), [{ from: 0, to: 0 }])
})
