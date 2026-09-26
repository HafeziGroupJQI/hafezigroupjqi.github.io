import assert from "node:assert/strict"
import test from "node:test"
import { LIMITS, createStore, initialState, reduce, seriesKey } from "./store.js"

const reading = (ts, value, seq = ts) => ({ local_id: "sim", metric: "v", value, ts_ns: String(ts * 1e6), seq, units: "V" })

test("devicesLoaded derives liveness from the server age", () => {
  const s = reduce(initialState(), {
    type: "devicesLoaded",
    at: 10_000,
    devices: [
      { code_name: "a", enrolled: true, last_seen_age_ms: 5_000 },
      { code_name: "b", enrolled: true, last_seen_age_ms: 100_000 },
      { code_name: "c", enrolled: false, last_seen_age_ms: null },
    ],
  })
  assert.deepEqual([...s.devices.values()].map((d) => d.liveness), ["online", "stale", "pending"])
})

test("tick flips online → stale at exactly the threshold, and is a no-op otherwise", () => {
  let s = reduce(initialState(), {
    type: "devicesLoaded",
    at: 0,
    devices: [{ code_name: "a", enrolled: true, last_seen_age_ms: 40_000 }],
  })
  const same = reduce(s, { type: "tick", now: 5_000 })
  assert.equal(same.devices, s.devices)
  s = reduce(s, { type: "tick", now: 5_001 })
  assert.equal(s.devices.get("a").liveness, "stale")
})

test("readings are de-duplicated, so a hello replay is idempotent", () => {
  const batch = [reading(1, 1), reading(2, 2), reading(3, 3)]
  let s = reduce(initialState(), { type: "hello", code: "d", readings: batch, logs: [] })
  const key = seriesKey("d", "sim", "v")
  assert.equal(s.series.get(key).length, 3)
  const again = reduce(s, { type: "hello", code: "d", readings: batch, logs: [] })
  assert.equal(again, s)
  s = reduce(s, { type: "readings", code: "d", readings: [reading(2, 9), reading(4, 4)] })
  assert.deepEqual(s.series.get(key).map((p) => p.y), [1, 2, 3, 4])
  assert.equal(s.latest.get(key).value, 4)
  assert.equal(s.latest.get(key).units, "V")
})

test("special values update latest but not the plotted series", () => {
  const s = reduce(initialState(), {
    type: "readings",
    code: "d",
    readings: [{ local_id: "sim", metric: "v", value: null, value_text: "NaN", ts_ns: "5" }],
  })
  assert.equal(s.latest.get(seriesKey("d", "sim", "v")).value, "NaN")
  assert.equal(s.series.get(seriesKey("d", "sim", "v")), undefined)
})

test("rings are capped", () => {
  let s = initialState()
  const many = Array.from({ length: LIMITS.POINTS + 50 }, (_, i) => reading(i + 1, i))
  s = reduce(s, { type: "readings", code: "d", readings: many })
  assert.equal(s.series.get(seriesKey("d", "sim", "v")).length, LIMITS.POINTS)
  const logs = Array.from({ length: LIMITS.LOGS + 20 }, (_, i) => ({ ts_ns: String(i + 1), level: "info", message: `m${i}` }))
  s = reduce(s, { type: "logs", code: "d", logs })
  assert.equal(s.logs.get("d").length, LIMITS.LOGS)
  const replay = reduce(s, { type: "logs", code: "d", logs: logs.slice(-10) })
  assert.equal(replay, s)
})

test("at-rest instrument values never overwrite newer live ones", () => {
  let s = reduce(initialState(), { type: "readings", code: "d", readings: [reading(10, 10)] })
  s = reduce(s, {
    type: "instrumentsLoaded",
    code: "d",
    instruments: [{ local_id: "sim", status: "online", latest: { v: { value: 1, ts_ns: String(5e6) } } }],
  })
  assert.equal(s.latest.get(seriesKey("d", "sim", "v")).value, 10)
  assert.equal(s.instruments.get("d").get("sim").status, "online")
})

test("command results update the audit rows", () => {
  let s = reduce(initialState(), {
    type: "commandsLoaded",
    code: "d",
    commands: [{ id: "c1", kind: "poll", status: "sent" }],
  })
  s = reduce(s, { type: "commandResult", code: "d", command_id: "c1", status: "ok" })
  assert.equal(s.commands.get("d")[0].status, "done")
})

test("createStore notifies only on change", () => {
  const store = createStore()
  let calls = 0
  store.subscribe(() => calls++)
  store.dispatch({ type: "streamStatus", code: "d", status: "open" })
  store.dispatch({ type: "streamStatus", code: "d", status: "open" })
  store.dispatch({ type: "unknown" })
  assert.equal(calls, 1)
})
