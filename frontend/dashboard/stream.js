// One live stream per tab, following the focused device. The members service worker cannot hold
// a long-lived stream reliably, so this reads the DeviceHub's Server-Sent Events straight from the
// Worker with fetch() and the member's bearer token (EventSource cannot send one). It reconnects
// on its own, backs off after a burst of failures (5 in 60 s → retry after 5 → 10 → 30 → 60 s,
// jittered), treats a 401 as a logout, and can pause/resume for hidden tabs (the `hello` frame of
// a new connection backfills what was missed).

import { createSseParser } from "../members/sse-parse.js"

const BACKOFF_S = [5, 10, 30, 60]
const QUICK_RETRY_MS = 1000

async function defaultConnect(code, signal) {
  const { API_ORIGIN, readAuth } = await import("../members/auth.js")
  const auth = await readAuth()
  if (!auth) return new Response(null, { status: 401 })
  return fetch(`${API_ORIGIN}/api/devices/${encodeURIComponent(code)}/stream`, {
    headers: { authorization: `Bearer ${auth.token}`, accept: "text/event-stream" },
    cache: "no-store",
    signal,
  })
}

export function openDeviceStream(code, dispatch, deps = {}) {
  const {
    connect = defaultConnect,
    onLoggedOut = () =>
      location.assign("/auth/login?next=" + encodeURIComponent(location.pathname + location.search)),
    setTimeout: set = globalThis.setTimeout,
    clearTimeout: clear = globalThis.clearTimeout,
    now = () => Date.now(),
    random = Math.random,
  } = deps
  let controller = null
  let retryTimer = null
  let errors = []
  let backoffStep = 0
  let closed = false
  let paused = false

  const status = (s) => dispatch({ type: "streamStatus", code, status: s })
  const handlers = {
    hello: (d) => dispatch({ type: "hello", code, readings: d.readings ?? [], logs: d.logs ?? [] }),
    readings: (d) => dispatch({ type: "readings", code, readings: d }),
    logs: (d) => dispatch({ type: "logs", code, logs: d }),
    command_result: (d) =>
      dispatch({ type: "commandResult", code, command_id: d.command_id, status: d.status, result: d.result }),
  }
  const onEvent = (name, text) => {
    const handler = handlers[name]
    if (!handler) return
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return // a malformed frame never breaks the stream
    }
    handler(data)
  }

  async function open() {
    if (closed || paused) return
    clear(retryTimer)
    status("connecting")
    const mine = new AbortController()
    controller = mine
    let response
    try {
      response = await connect(code, mine.signal)
    } catch {
      return failed(mine)
    }
    if (mine !== controller) return
    if (response.status === 401) {
      stop()
      onLoggedOut()
      return
    }
    if (!response.ok || !response.body) return failed(mine)
    backoffStep = 0
    status("open")
    const parser = createSseParser(onEvent)
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        parser.feed(decoder.decode(value, { stream: true }))
      }
    } catch {
      /* aborted or dropped */
    }
    if (mine === controller) failed(mine)
  }

  function failed(mine) {
    if (closed || paused || mine !== controller) return
    status("reconnecting")
    const t = now()
    errors = errors.filter((e) => t - e < 60_000).concat(t)
    let delay = QUICK_RETRY_MS
    if (errors.length >= 5) {
      errors = []
      delay = BACKOFF_S[Math.min(backoffStep, BACKOFF_S.length - 1)] * 1000 * (0.8 + 0.4 * random())
      backoffStep++
    }
    retryTimer = set(open, delay)
  }

  function stop() {
    controller?.abort()
    controller = null
    clear(retryTimer)
  }

  open()
  return {
    code,
    pause() {
      if (closed) return
      paused = true
      stop()
      status("paused")
    },
    resume() {
      if (closed || !paused) return
      paused = false
      open()
    },
    close() {
      closed = true
      stop()
      status("closed")
    },
  }
}
