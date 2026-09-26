import assert from "node:assert/strict"
import test from "node:test"
import { createPoller } from "./scheduler.js"

function fakeTimers() {
  const timers = []
  return {
    timers,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimeout: (t) => t && (t.cleared = true),
    last: () => timers.filter((t) => !t.cleared).at(-1),
  }
}
const flush = () => new Promise((r) => setImmediate(r))

test("polls immediately, then at the visible interval", async () => {
  const clock = fakeTimers()
  let calls = 0
  const p = createPoller(() => calls++, 10_000, clock)
  p.start()
  await flush()
  assert.equal(calls, 1)
  assert.equal(clock.last().ms, 10_000)
  p.stop()
})

test("slows down while hidden and fires at once when visible again", async () => {
  const clock = fakeTimers()
  let hidden = true
  let calls = 0
  const p = createPoller(() => calls++, 10_000, { ...clock, isHidden: () => hidden })
  p.start()
  await flush()
  assert.equal(clock.last().ms, 60_000)
  hidden = false
  p.visibilityChanged()
  await flush()
  assert.equal(calls, 2)
  assert.equal(clock.last().ms, 10_000)
  p.stop()
  assert.equal(clock.last(), undefined)
})

test("a failing poll keeps the schedule", async () => {
  const clock = fakeTimers()
  const p = createPoller(() => Promise.reject(new Error("boom")), 1_000, clock)
  p.start()
  await flush()
  assert.equal(clock.last().ms, 1_000)
  p.stop()
})
