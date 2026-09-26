// One EventSource per tab, following the focused device. EventSource retries on its own; this
// adds what it cannot do: back off after a burst of errors (5 in 60 s → close, retry after
// 5 → 10 → 30 → 60 s, jittered), notice a logout (a 401 is invisible to EventSource, so the first
// error asks /api/session), and pause/resume for hidden tabs (a resume's `hello` backfills).

const BACKOFF_S = [5, 10, 30, 60]

export function openDeviceStream(code, dispatch, deps = {}) {
  const {
    EventSource: ES = globalThis.EventSource,
    fetchSession = () => fetch("/api/session", { cache: "no-store" }).then((r) => r.json()),
    onLoggedOut = () => location.assign("/auth/login?next=" + encodeURIComponent(location.pathname + location.search)),
    setTimeout: set = globalThis.setTimeout,
    clearTimeout: clear = globalThis.clearTimeout,
    now = () => Date.now(),
    random = Math.random,
  } = deps
  let source = null
  let retryTimer = null
  let errors = []
  let backoffStep = 0
  let closed = false
  let checkedSession = false

  const status = (s) => dispatch({ type: "streamStatus", code, status: s })
  const on = (event, fn) =>
    source.addEventListener(event, (message) => {
      let data
      try {
        data = JSON.parse(message.data)
      } catch {
        return // a malformed frame never breaks the stream
      }
      fn(data)
    })

  function open() {
    if (closed) return
    clear(retryTimer)
    status("connecting")
    source = new ES(`/api/devices/${encodeURIComponent(code)}/stream`)
    source.addEventListener("open", () => {
      backoffStep = 0
      checkedSession = false
      status("open")
    })
    on("hello", (d) => dispatch({ type: "hello", code, readings: d.readings ?? [], logs: d.logs ?? [] }))
    on("readings", (d) => dispatch({ type: "readings", code, readings: d }))
    on("logs", (d) => dispatch({ type: "logs", code, logs: d }))
    on("command_result", (d) =>
      dispatch({ type: "commandResult", code, command_id: d.command_id, status: d.status, result: d.result }),
    )
    source.addEventListener("error", onError)
  }

  function onError() {
    if (closed) return
    status("reconnecting")
    const t = now()
    errors = errors.filter((e) => t - e < 60_000).concat(t)
    if (!checkedSession) {
      checkedSession = true
      Promise.resolve(fetchSession())
        .then((s) => {
          if (!s?.user) {
            stop()
            onLoggedOut()
          }
        })
        .catch(() => {})
    }
    if (errors.length >= 5) {
      source?.close()
      source = null
      errors = []
      const base = BACKOFF_S[Math.min(backoffStep, BACKOFF_S.length - 1)] * 1000
      backoffStep++
      retryTimer = set(open, base * (0.8 + 0.4 * random()))
    }
  }

  function stop() {
    source?.close()
    source = null
    clear(retryTimer)
  }

  open()
  return {
    code,
    pause() {
      if (closed) return
      stop()
      status("paused")
    },
    resume() {
      if (closed || source) return
      open()
    },
    close() {
      closed = true
      stop()
      status("closed")
    },
  }
}
