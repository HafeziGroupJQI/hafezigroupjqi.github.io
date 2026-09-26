import assert from "node:assert/strict"
import test from "node:test"
import { openDeviceStream } from "./stream.js"

class FakeES {
  static last = null
  constructor(url) {
    this.url = url
    this.handlers = {}
    this.closed = false
    FakeES.last = this
  }
  addEventListener(e, fn) {
    ;(this.handlers[e] ??= []).push(fn)
  }
  emit(e, data) {
    for (const fn of this.handlers[e] ?? []) fn(data === undefined ? {} : { data: JSON.stringify(data) })
  }
  close() {
    this.closed = true
  }
}

const harness = (extra = {}) => {
  const actions = []
  const timers = []
  let t = 0
  const s = openDeviceStream("bench-1", (a) => actions.push(a), {
    EventSource: FakeES,
    fetchSession: async () => ({ user: { login: "x" } }),
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
    now: () => (t += 1000),
    random: () => 0.5,
    ...extra,
  })
  return { s, actions, timers }
}

test("dispatches hello/readings/logs/command_result frames", () => {
  const { actions } = harness()
  const es = FakeES.last
  assert.equal(es.url, "/api/devices/bench-1/stream")
  es.emit("open")
  es.emit("hello", { readings: [{ local_id: "a" }], logs: [] })
  es.emit("readings", [{ local_id: "a" }])
  es.emit("command_result", { command_id: "c", status: "ok" })
  es.handlers.readings[0]({ data: "{not json" })
  assert.deepEqual(
    actions.map((a) => a.type === "streamStatus" ? a.status : a.type),
    ["connecting", "open", "hello", "readings", "commandResult"],
  )
})

test("backs off after five errors in a minute", () => {
  const { timers } = harness()
  const es = FakeES.last
  for (let i = 0; i < 5; i++) es.emit("error")
  assert.equal(es.closed, true)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 5000)
  timers[0].fn()
  assert.notEqual(FakeES.last, es)
})

test("a logged-out session stops the stream", async () => {
  let loggedOut = false
  harness({ fetchSession: async () => ({ user: null }), onLoggedOut: () => (loggedOut = true) })
  const es = FakeES.last
  es.emit("error")
  await new Promise((r) => setImmediate(r))
  assert.equal(loggedOut, true)
  assert.equal(es.closed, true)
})

test("pause closes and resume reopens", () => {
  const { s, actions } = harness()
  const first = FakeES.last
  s.pause()
  assert.equal(first.closed, true)
  assert.equal(actions.at(-1).status, "paused")
  s.resume()
  assert.notEqual(FakeES.last, first)
  s.close()
  assert.equal(actions.at(-1).status, "closed")
})
