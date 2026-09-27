import assert from "node:assert/strict"
import test from "node:test"
import { initialState, reduce } from "../store.js"
import { activityModel } from "./activity.js"
import { buildSpec, familyForDriver } from "./builder.js"
import { deviceModel } from "./device.js"
import { experimentsModel } from "./experiments.js"
import { instrumentsModel } from "./instruments.js"
import { fleetSummary, instrumentsLine, overviewModel } from "./overview.js"

const fleet = (now = 0) =>
  reduce(initialState(now), {
    type: "devicesLoaded",
    at: now,
    devices: [
      {
        code_name: "zeta",
        enrolled: true,
        last_seen_age_ms: 1_000,
        instrument_count: 4,
        instruments_online: 3,
        hostname: "LAB-1",
        platform: "windows-x64",
        agent_version: "1.4.2",
      },
      {
        code_name: "alpha",
        enrolled: true,
        last_seen_age_ms: 100_000,
        instrument_count: 2,
        instruments_online: 2,
      },
      {
        code_name: "beta",
        enrolled: false,
        last_seen_age_ms: null,
        instrument_count: 0,
        instruments_online: 0,
      },
      {
        code_name: "gamma",
        enrolled: true,
        last_seen_age_ms: 1_000_000,
        instrument_count: 1,
        instruments_online: 1,
      },
      {
        code_name: "delta",
        enrolled: true,
        last_seen_age_ms: 2_000,
        instrument_count: 1,
        instruments_online: 1,
      },
    ],
  })

test("overview sorts online → stale → offline → pending, then by name, and summarises", () => {
  const m = overviewModel(fleet(), { tab: "overview", layout: "grid" })
  assert.deepEqual(
    m.cards.map((c) => c.code),
    ["delta", "zeta", "alpha", "gamma", "beta"],
  )
  assert.equal(m.summary.text, "2 online · 1 stale · 1 offline · 1 pending")
  const zeta = m.cards.find((c) => c.code === "zeta")
  assert.equal(zeta.meta, "LAB-1 · windows-x64 · v1.4.2")
  assert.equal(zeta.ageLabel, "1 s ago")
  assert.equal(zeta.href, "/devices?tab=device&code=zeta")
  assert.equal(instrumentsLine(zeta), "4 instruments · 3 online")
  // A stale device never claims online instruments.
  const alpha = m.cards.find((c) => c.code === "alpha")
  assert.equal(alpha.onlineCount, 0)
  assert.equal(instrumentsLine(alpha), "2 instruments")
  assert.equal(m.cards.find((c) => c.code === "beta").ageLabel, "never seen")
})

test("focus layout picks the routed device or the first card", () => {
  assert.equal(overviewModel(fleet(), { layout: "focus", code: "gamma" }).focusCode, "gamma")
  assert.equal(overviewModel(fleet(), { layout: "focus", code: "nope" }).focusCode, "delta")
  assert.equal(overviewModel(fleet(), { layout: "grid" }).focusCode, null)
  assert.equal(fleetSummary([]).text, "No devices yet")
})

test("device model forces instruments offline under a stale PC and merges live metrics", () => {
  let s = fleet()
  s = reduce(s, {
    type: "instrumentsLoaded",
    code: "alpha",
    instruments: [
      {
        local_id: "sim",
        title: "Sim",
        driver: "simulated",
        status: "online",
        ports: [1, 2],
        latest: { v: { value: 1.5, ts_ns: "1" } },
      },
    ],
  })
  s = reduce(s, {
    type: "readings",
    code: "alpha",
    readings: [{ local_id: "sim", metric: "i", value: 2, ts_ns: "5", units: "A" }],
  })
  const m = deviceModel(s, { tab: "device", code: "alpha" })
  assert.equal(m.liveness, "stale")
  assert.equal(m.instruments[0].status, "offline")
  assert.deepEqual(
    m.instruments[0].metrics.map((x) => x.text),
    ["2 A", "1.5"],
  )
  assert.equal(m.stream, "offline")
  assert.equal(deviceModel(s, { code: "missing" }).missing, true)
})

test("instruments model selects the routed instrument and collects its series", () => {
  let s = fleet()
  s = reduce(s, {
    type: "instrumentsLoaded",
    code: "zeta",
    instruments: [
      { local_id: "a", status: "online" },
      { local_id: "b", status: "unpolled" },
    ],
  })
  s = reduce(s, {
    type: "readings",
    code: "zeta",
    readings: [{ local_id: "b", metric: "v", value: 1, ts_ns: "1000000" }],
  })
  const m = instrumentsModel(s, { code: "zeta", id: "b" })
  assert.equal(m.selected.id, "b")
  assert.equal(m.selected.status, "unpolled")
  assert.equal(m.selected.series.length, 1)
  assert.deepEqual(
    m.chips.map((c) => c.selected),
    [false, true],
  )
  assert.equal(instrumentsModel(s, { code: "zeta" }).selected.id, "a")
})

test("experiments are grouped by status, paged, and the focused one is always shown", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: `e${i}`,
    status: i === 24 ? "running" : "stopped",
    created_ns: String(i),
  }))
  const s = reduce(fleet(), { type: "experimentsLoaded", code: "zeta", experiments: rows })
  const m = experimentsModel(s, { code: "zeta" })
  assert.deepEqual(
    m.groups.map((g) => g.status),
    ["running", "stopped"],
  )
  assert.equal(m.groups[1].items.length, 19)
  assert.equal(m.more, 5)
  assert.equal(m.active, true)
  const focused = experimentsModel(s, { code: "zeta", focus: "e0" })
  assert.ok(focused.groups.flatMap((g) => g.items).find((i) => i.id === "e0").open)
  assert.equal(experimentsModel(s, { code: null }).loaded, false)
})

test("activity shows the command timeline, capped", () => {
  const commands = Array.from({ length: 40 }, (_, i) => ({
    id: `c${i}`,
    kind: "poll",
    args: { local_id: "sim" },
    status: i === 0 ? "sent" : "done",
    requested_by: "anish",
    created_ns: "1000000000",
    delivered_ns: "2000000000",
    completed_ns: i === 0 ? null : "3000000000",
  }))
  const s = reduce(fleet(), { type: "commandsLoaded", code: "zeta", commands })
  const m = activityModel(s, { code: "zeta" })
  assert.equal(m.items.length, 30)
  assert.equal(m.more, 10)
  assert.equal(m.items[0].args, "local_id=sim")
  assert.deepEqual(
    m.items[0].steps.map((x) => x.reached),
    [true, true, false],
  )
  assert.deepEqual(
    m.items[1].steps.map((x) => x.reached),
    [true, true, true],
  )
})

test("builder turns the form into a Setup.json spec", () => {
  const catalog = [{ family: "Keithley2450" }, { family: "RigolDG4202" }]
  assert.equal(familyForDriver(catalog, "keithley_2450"), "Keithley2450")
  assert.equal(familyForDriver(catalog, "rigol_dg4202"), "RigolDG4202")
  const spec = buildSpec(
    {
      device: "zeta",
      instruments: [{ local_id: "sim", driver: "keithley_2450" }],
      label: " iv ",
      dut: "a, b",
      netlist: "sim.force_hi -> dut1.a\nbad line",
      points: "11",
      prompt: "",
    },
    catalog,
  )
  assert.equal(spec.experiment_label, "iv")
  assert.equal(spec.selected_instruments[0].family, "Keithley2450")
  assert.deepEqual(spec.duts, [{ name: "dut1", ports: ["a", "b"] }])
  assert.deepEqual(spec.netlist, [{ from: "sim.force_hi", to: "dut1.a" }])
  assert.equal(spec.points, 11)
  assert.throws(
    () =>
      buildSpec(
        { device: "z", instruments: [], label: "", dut: "", netlist: "", points: "", prompt: "" },
        [],
      ),
    /at least one/,
  )
})
