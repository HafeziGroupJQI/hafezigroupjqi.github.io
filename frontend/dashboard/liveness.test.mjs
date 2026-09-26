import assert from "node:assert/strict"
import test from "node:test"
import { THRESHOLDS, ageLabel, ageMs, deviceLiveness, instrumentLiveness } from "./liveness.js"

const at = (ageSeconds, enrolled = true) => ({
  enrolled,
  last_seen_age_ms: ageSeconds * 1000,
  fetched_at: 1_000,
})

test("pins the Worker's thresholds", () => {
  assert.equal(THRESHOLDS.ONLINE_MS, 45_000)
  assert.equal(THRESHOLDS.STALE_MS, 300_000)
})

test("classifies by heartbeat age", () => {
  assert.equal(deviceLiveness(at(44.9), 1_000), "online")
  assert.equal(deviceLiveness(at(45), 1_000), "online")
  assert.equal(deviceLiveness(at(45.1), 1_000), "stale")
  assert.equal(deviceLiveness(at(300), 1_000), "stale")
  assert.equal(deviceLiveness(at(300.1), 1_000), "offline")
})

test("a never-enrolled or never-seen device is pending", () => {
  assert.equal(deviceLiveness(at(1, false), 1_000), "pending")
  assert.equal(deviceLiveness({ enrolled: true, last_seen_age_ms: null }, 1_000), "pending")
})

test("ticks the age forward from the fetch time", () => {
  const d = at(40)
  assert.equal(ageMs(d, 1_000), 40_000)
  assert.equal(ageMs(d, 6_000), 45_000)
  assert.equal(deviceLiveness(d, 6_000), "online")
  assert.equal(deviceLiveness(d, 6_001), "stale")
})

test("an instrument under a non-online device is offline", () => {
  assert.equal(instrumentLiveness({ status: "online" }, "online"), "online")
  assert.equal(instrumentLiveness({ status: "online" }, "stale"), "offline")
  assert.equal(instrumentLiveness({ status: "unpolled" }, "pending"), "offline")
  assert.equal(instrumentLiveness({}, "online"), "unpolled")
})

test("labels ages", () => {
  assert.equal(ageLabel(null), "never")
  assert.equal(ageLabel(12_400), "12 s ago")
  assert.equal(ageLabel(125_000), "2 min ago")
  assert.equal(ageLabel(7_200_000), "2 h ago")
  assert.equal(ageLabel(2 * 86_400_000), "2 d ago")
})
