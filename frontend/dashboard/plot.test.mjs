import assert from "node:assert/strict"
import test from "node:test"
import { planPlot } from "./plot.js"

const s = (name, units, xs = [1, 2]) => ({ name, units, points: xs.map((x) => ({ x, y: x })) })

test("≤ 8 series share one chart, colours follow the series order, units shared when common", () => {
  const plan = planPlot([s("a", "V"), s("b", "V")], { now: 3 })
  assert.equal(plan.panels.length, 1)
  assert.equal(plan.panels[0].units, "V")
  assert.deepEqual(
    plan.legend.map((l) => l.color),
    [1, 2],
  )
  assert.equal(plan.directLabels, true)
})

test("> 8 series become small multiples grouped by units, each keeping its colour", () => {
  const list = Array.from({ length: 10 }, (_, i) => s(`m${i}`, i < 5 ? "V" : "A"))
  const plan = planPlot(list, { now: 3 })
  assert.deepEqual(
    plan.panels.map((p) => p.title),
    ["V", "A"],
  )
  assert.equal(plan.panels[1].series[0].color, 6)
  assert.equal(plan.directLabels, false)
})

test("caps at 16 series with an overflow count", () => {
  const plan = planPlot(
    Array.from({ length: 20 }, (_, i) => s(`m${i}`, "V")),
    { now: 3 },
  )
  assert.equal(plan.legend.length, 16)
  assert.equal(plan.overflow, 4)
})

test("hidden series and the time window filter what is drawn", () => {
  const plan = planPlot([s("a", "V", [0, 100_000]), s("b", "V")], {
    now: 100_000,
    window: "1m",
    hidden: new Set(["b"]),
  })
  assert.deepEqual(
    plan.panels[0].series.map((x) => x.name),
    ["a"],
  )
  assert.equal(plan.panels[0].series[0].points.length, 1)
  assert.equal(plan.legend[1].hidden, true)
})

test("mixed units never share an axis", () => {
  const plan = planPlot([s("i", "mA"), s("v", "V")], { now: 3 })
  assert.deepEqual(
    plan.panels.map((p) => p.units),
    ["mA", "V"],
  )
  assert.equal(plan.directLabels, true)
})
