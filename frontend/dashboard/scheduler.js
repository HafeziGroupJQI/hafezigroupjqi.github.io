// Visibility-aware polling with injected timers, so it is testable without a browser. Visible:
// every `ms`; hidden: every `hiddenMs` (default 6×, e.g. 10 s → 60 s). Becoming visible again
// fires immediately. Calls never overlap: the next one is scheduled after the previous settles.

export function createPoller(fn, ms, options = {}) {
  const {
    setTimeout: set = globalThis.setTimeout,
    clearTimeout: clear = globalThis.clearTimeout,
    isHidden = () => false,
    hiddenMs = ms * 6,
  } = options
  let timer = null
  let running = false
  let inFlight = false

  const schedule = () => {
    if (!running) return
    clear(timer)
    timer = set(run, isHidden() ? hiddenMs : ms)
  }
  async function run() {
    if (!running || inFlight) return
    inFlight = true
    try {
      await fn()
    } catch {
      /* the callee reports its own errors; keep polling */
    } finally {
      inFlight = false
      schedule()
    }
  }
  return {
    start({ immediate = true } = {}) {
      if (running) return
      running = true
      if (immediate) run()
      else schedule()
    },
    stop() {
      running = false
      clear(timer)
      timer = null
    },
    /** Poll now (e.g. after a mutation) and restart the interval. */
    now() {
      if (!running) return
      clear(timer)
      run()
    },
    /** Call from a visibilitychange listener. */
    visibilityChanged() {
      if (!running) return
      if (isHidden()) schedule()
      else this.now()
    },
    get running() {
      return running
    },
  }
}
