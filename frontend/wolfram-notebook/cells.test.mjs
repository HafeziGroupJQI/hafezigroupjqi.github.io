import assert from "node:assert/strict"
import test from "node:test"
import {
  failureMessage,
  frameIndex,
  messageParts,
  matchSymbols,
  normalizeSymbols,
  parseControls,
  preludeCodes,
  preludeIds,
  runPayload,
  spriteStyle,
  valueLabel,
} from "./cells.js"

test("prelude ids and codes follow data-prelude and skip missing cells", () => {
  assert.deepEqual(preludeIds(" c3  c5 "), ["c3", "c5"])
  assert.deepEqual(preludeIds(undefined), [])
  const codes = { c3: "f[x_] := x^2", c5: "  ", c7: "a = 1" }
  assert.deepEqual(
    preludeCodes("c3 c5 c7 c9", (id) => codes[id] ?? null),
    ["f[x_] := x^2", "a = 1"],
  )
  assert.deepEqual(
    runPayload({ page: "resources/guide/nine", cell: "c12", code: "f[2]", prelude: ["x"] }),
    {
      page: "resources/guide/nine",
      cell: "c12",
      code: "f[2]",
      prelude: ["x"],
    },
  )
})

test("failures read as member-facing text", () => {
  assert.match(failureMessage(503, {}), /Compute host offline/)
  assert.equal(failureMessage(429, { detail: "slow down" }), "slow down")
  assert.equal(failureMessage(400, { detail: "bad code" }), "bad code")
  assert.match(failureMessage(500, null), /\(500\)/)
})

test("sprite frames index controls row-major and place the grid in percentages", () => {
  const controls = parseControls(
    JSON.stringify([
      { name: "n", values: [1, 2, 3] },
      { name: "c", label: "color", values: ["Red", "Blue"], initial: 5 },
      { name: "empty", values: [] },
    ]),
  )
  assert.equal(controls.length, 2)
  assert.equal(controls[1].label, "color")
  assert.equal(controls[0].initial, 0)
  assert.equal(controls[1].initial, 1)
  assert.equal(frameIndex(controls, [0, 0]), 0)
  assert.equal(frameIndex(controls, [1, 1]), 3)
  assert.equal(frameIndex(controls, [2, 1]), 5)
  assert.equal(frameIndex(controls, [9, -1]), 4)
  assert.deepEqual(parseControls("not json"), [])
  assert.deepEqual(spriteStyle(0, 8, 8), { size: "800% 800%", position: "0% 0%" })
  assert.deepEqual(spriteStyle(9, 8, 2), { size: "800% 200%", position: `${(1 / 7) * 100}% 100%` })
  assert.deepEqual(spriteStyle(0, 1, 1).position, "0% 0%")
  assert.equal(valueLabel(0.1 + 0.2), "0.3")
  assert.equal(valueLabel(3), "3")
  assert.equal(valueLabel("Red"), "Red")
})

test("symbols normalize from either shape and match by prefix", () => {
  const symbols = normalizeSymbols([
    { n: "Table", u: "Table[expr, n]" },
    "TableForm",
    { n: "table" },
    {},
  ])
  assert.deepEqual(
    symbols.map((symbol) => symbol.name),
    ["Table", "TableForm", "table"],
  )
  assert.deepEqual(normalizeSymbols({ symbols: ["Plot"] }), [{ name: "Plot", usage: "" }])
  assert.deepEqual(
    matchSymbols(symbols, "Tab").map((symbol) => symbol.name),
    ["Table", "TableForm", "table"],
  )
  assert.deepEqual(matchSymbols(symbols, ""), [])
  assert.equal(matchSymbols(symbols, "T", 1).length, 1)
})

test("a missing-licence message links to Settings", () => {
  const message =
    "Wolfram code runs on your own Wolfram Engine licence. Add it in Settings (/settings): it's free."
  assert.deepEqual(messageParts(message), [
    "Wolfram code runs on your own Wolfram Engine licence. Add it in ",
    { href: "/settings", text: "Settings" },
    ": it's free.",
  ])
  assert.deepEqual(messageParts("Compute host offline."), ["Compute host offline."])
})
