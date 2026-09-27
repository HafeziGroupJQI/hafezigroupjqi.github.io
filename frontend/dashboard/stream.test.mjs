import assert from "node:assert/strict"
import test from "node:test"
import { openDeviceStream } from "./stream.js"

// A controllable SSE response: push() frames, end() the body.
function fakeStream() {
  let push, end
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      push = (text) => controller.enqueue(enc.encode(text))
      end = () => controller.close()
    },
  })
  return { response: new Response(body, { status: 200 }), push: (t) => push(t), end: () => end() }
}
const tick = () => new Promise((r) => setImmediate(r))

function harness(responses, extra = {}) {
  const actions = []
  const timers = []
  const urls = []
  let t = 0
  const s = openDeviceStream("bench-1", (a) => actions.push(a), {
    connect: async (code, signal) => {
      urls.push({ code, signal })
      const next = responses.shift()
      if (next instanceof Error) throw next
      return next ?? new Response(null, { status: 503 })
    },
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
    now: () => (t += 1000),
    random: () => 0.5,
    ...extra,
  })
  return { s, actions, timers, urls }
}
const kinds = (actions) => actions.map((a) => (a.type === "streamStatus" ? a.status : a.type))

test("dispatches hello/readings/logs/command_result frames from the fetch stream", async () => {
  const live = fakeStream()
  const { actions, urls } = harness([live.response])
  await tick()
  assert.equal(urls[0].code, "bench-1")
  live.push('event: hello\ndata: {"readings":[{"local_id":"a"}],"logs":[]}\n\n')
  live.push('event: readings\ndata: [{"local_id":"a"}]\n\n')
  live.push('event: command_result\ndata: {"command_id":"c","status":"ok"}\n\n')
  live.push("event: readings\ndata: {not json\n\n")
  await tick()
  assert.deepEqual(kinds(actions), ["connecting", "open", "hello", "readings", "commandResult"])
})

test("retries quickly after a drop, then backs off after five failures in a minute", async () => {
  const { timers, actions } = harness([
    new Error("x"),
    new Error("x"),
    new Error("x"),
    new Error("x"),
    new Error("x"),
  ])
  await tick()
  assert.equal(timers[0].ms, 1000)
  for (let i = 0; i < 4; i++) {
    timers.at(-1).fn()
    await tick()
  }
  assert.equal(timers.at(-1).ms, 5000)
  assert.equal(actions.at(-1).status, "reconnecting")
})

test("a 401 from the Worker is a logout", async () => {
  let loggedOut = false
  harness([new Response(null, { status: 401 })], { onLoggedOut: () => (loggedOut = true) })
  await tick()
  assert.equal(loggedOut, true)
})

test("pause aborts the connection and resume reconnects", async () => {
  const live = fakeStream()
  const { s, actions, urls } = harness([live.response, fakeStream().response])
  await tick()
  s.pause()
  assert.equal(urls[0].signal.aborted, true)
  assert.equal(actions.at(-1).status, "paused")
  s.resume()
  await tick()
  assert.equal(urls.length, 2)
  s.close()
  assert.equal(actions.at(-1).status, "closed")
})
