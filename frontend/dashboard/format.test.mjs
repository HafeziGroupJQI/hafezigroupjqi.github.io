import assert from "node:assert/strict"
import test from "node:test"
import { argsSummary, fmtInt, fmtValue, nsToMs, relTime } from "./format.js"

test("formats values and the wire's special strings", () => {
  assert.equal(fmtValue(19.8612345, "V"), "19.8612 V")
  assert.equal(fmtValue(0), "0")
  assert.equal(fmtValue(1.5e-6, "A"), "1.5000e-6 A")
  assert.equal(fmtValue(null, "V"), "—")
  assert.equal(fmtValue("NaN"), "NaN")
  assert.equal(fmtValue("Inf", "V"), "+∞ V")
  assert.equal(fmtValue("-Inf"), "−∞")
})

test("integers and timestamps", () => {
  assert.equal(fmtInt(12345.4), "12,345")
  assert.equal(fmtInt(NaN), "—")
  assert.equal(nsToMs("1758000000123456789"), 1758000000123)
  assert.equal(nsToMs(null), null)
  assert.equal(relTime("5000000000", 17_000), "12 s ago")
  assert.equal(relTime(null, 0), "—")
})

test("summarises command args", () => {
  assert.equal(argsSummary({ local_id: "sim-smu" }), "local_id=sim-smu")
  assert.equal(argsSummary({ a: { b: 1 } }), 'a={"b":1}')
  assert.equal(argsSummary(null), "")
})
