// Dashboard state. `reduce` is pure and returns a new top-level object whenever something changed
// (slices are copied on write), so views can compare by reference. The SSE stream has no
// Last-Event-ID, and every reconnect replays the hub's 200-item rings in a `hello` frame, so
// readings and logs are de-duplicated here and every ring is capped.

import { deviceLiveness } from "./liveness.js"
import { nsToMs } from "./format.js"

export const LIMITS = Object.freeze({ LOGS: 500, POINTS: 400 })

export const seriesKey = (code, localId, metric) => `${code}|${localId}|${metric}`

export function initialState(now = 0) {
  return {
    now,
    devices: new Map(), // code -> list row + fetched_at + derived liveness
    devicesLoaded: false,
    details: new Map(), // code -> GET /api/devices/:code + fetched_at
    instruments: new Map(), // code -> Map<local_id, instrument>
    latest: new Map(), // seriesKey -> { value, ts_ns, seq, units }
    series: new Map(), // seriesKey -> [{ x, y }]  (x = ms)
    lastTs: new Map(), // seriesKey -> BigInt ts of the newest accepted point
    logs: new Map(), // code -> [{ ts_ns, level, local_id, message }]
    commands: new Map(), // code -> command rows, newest first
    experiments: new Map(), // code | "*" -> experiment rows, newest first
    streams: new Map(), // code -> connecting | open | reconnecting | paused | closed
    errors: new Map(), // scope -> message
  }
}

const big = (ts) => {
  try {
    return BigInt(String(ts).split(".")[0])
  } catch {
    return -1n
  }
}

const withLiveness = (row, now) => ({ ...row, liveness: deviceLiveness(row, now) })

function acceptReadings(state, code, readings) {
  if (!readings?.length) return state
  let latest = null
  let series = null
  let lastTs = null
  for (const r of readings) {
    if (!r || r.local_id == null || r.metric == null) continue
    const key = seriesKey(code, r.local_id, r.metric)
    const ts = big(r.ts_ns)
    const prev = (lastTs ?? state.lastTs).get(key)
    if (prev != null && ts <= prev) continue // replayed or out-of-order duplicate
    latest ??= new Map(state.latest)
    series ??= new Map(state.series)
    lastTs ??= new Map(state.lastTs)
    lastTs.set(key, ts)
    const value = r.value_text ?? r.value
    latest.set(key, { value, ts_ns: String(r.ts_ns), seq: r.seq ?? null, units: r.units ?? null })
    if (typeof r.value === "number" && Number.isFinite(r.value)) {
      const points = (series.get(key) ?? []).concat({ x: nsToMs(r.ts_ns), y: r.value })
      series.set(key, points.length > LIMITS.POINTS ? points.slice(-LIMITS.POINTS) : points)
    }
  }
  if (!latest) return state
  return { ...state, latest, series, lastTs }
}

function acceptLogs(state, code, logs) {
  if (!logs?.length) return state
  const ring = state.logs.get(code) ?? []
  const seen = new Set(ring.map((l) => `${l.ts_ns}|${l.message}`))
  const fresh = []
  for (const l of logs) {
    const key = `${l.ts_ns}|${l.message}`
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push({ ts_ns: String(l.ts_ns), level: l.level ?? "info", local_id: l.local_id ?? null, message: l.message ?? "" })
  }
  if (!fresh.length) return state
  const next = ring.concat(fresh).sort((a, b) => (big(a.ts_ns) < big(b.ts_ns) ? -1 : 1))
  const logsMap = new Map(state.logs)
  logsMap.set(code, next.length > LIMITS.LOGS ? next.slice(-LIMITS.LOGS) : next)
  return { ...state, logs: logsMap }
}

export function reduce(state, action) {
  switch (action.type) {
    case "devicesLoaded": {
      const devices = new Map()
      for (const d of action.devices)
        devices.set(d.code_name, withLiveness({ ...d, fetched_at: action.at }, action.at))
      const errors = new Map(state.errors)
      errors.delete("devices")
      return { ...state, devices, devicesLoaded: true, errors, now: Math.max(state.now, action.at) }
    }
    case "deviceLoaded": {
      const details = new Map(state.details)
      details.set(action.code, withLiveness({ ...action.device, fetched_at: action.at }, action.at))
      return { ...state, details }
    }
    case "instrumentsLoaded": {
      const instruments = new Map(state.instruments)
      instruments.set(action.code, new Map(action.instruments.map((i) => [i.local_id, i])))
      // The at-rest latest values seed the live map (the stream then only moves forward).
      const seed = []
      for (const i of action.instruments)
        for (const [metric, r] of Object.entries(i.latest ?? {}))
          seed.push({ local_id: i.local_id, metric, value: r.value, ts_ns: r.ts_ns, units: r.units })
      return acceptReadings({ ...state, instruments }, action.code, seed)
    }
    case "instrumentLoaded": {
      const { code, detail } = action
      const instruments = new Map(state.instruments)
      const map = new Map(instruments.get(code) ?? [])
      map.set(detail.local_id, { ...map.get(detail.local_id), ...detail })
      instruments.set(code, map)
      const history = (detail.history ?? [])
        .map((p) => ({ local_id: detail.local_id, metric: p.metric, value: p.value, ts_ns: p.ts_ns }))
        .sort((a, b) => (big(a.ts_ns) < big(b.ts_ns) ? -1 : 1))
      return acceptReadings({ ...state, instruments }, code, history)
    }
    case "hello":
      return acceptLogs(acceptReadings(state, action.code, action.readings), action.code, action.logs)
    case "readings":
      return acceptReadings(state, action.code, action.readings)
    case "logs":
      return acceptLogs(state, action.code, action.logs)
    case "clearLogs": {
      const logs = new Map(state.logs)
      logs.set(action.code, [])
      return { ...state, logs }
    }
    case "commandsLoaded": {
      const commands = new Map(state.commands)
      commands.set(action.code, action.commands)
      return { ...state, commands }
    }
    case "commandResult": {
      const rows = state.commands.get(action.code)
      if (!rows) return state
      const commands = new Map(state.commands)
      commands.set(
        action.code,
        rows.map((c) =>
          c.id === action.command_id
            ? { ...c, status: action.status === "ok" ? "done" : "failed", result: action.result ?? c.result }
            : c,
        ),
      )
      return { ...state, commands }
    }
    case "experimentsLoaded": {
      const experiments = new Map(state.experiments)
      experiments.set(action.code ?? "*", action.experiments)
      return { ...state, experiments }
    }
    case "streamStatus": {
      if (state.streams.get(action.code) === action.status) return state
      const streams = new Map(state.streams)
      streams.set(action.code, action.status)
      return { ...state, streams }
    }
    case "tick": {
      let changed = false
      const devices = new Map()
      for (const [code, d] of state.devices) {
        const liveness = deviceLiveness(d, action.now)
        if (liveness !== d.liveness) changed = true
        devices.set(code, liveness === d.liveness ? d : { ...d, liveness })
      }
      let details = state.details
      for (const [code, d] of state.details) {
        const liveness = deviceLiveness(d, action.now)
        if (liveness !== d.liveness) {
          if (details === state.details) details = new Map(state.details)
          details.set(code, { ...d, liveness })
        }
      }
      return { ...state, now: action.now, devices: changed ? devices : state.devices, details }
    }
    case "error": {
      const errors = new Map(state.errors)
      if (action.message) errors.set(action.scope, action.message)
      else errors.delete(action.scope)
      return { ...state, errors }
    }
    default:
      return state
  }
}

export function createStore(initial = initialState()) {
  let state = initial
  const listeners = new Set()
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action)
      if (next === state) return
      const prev = state
      state = next
      for (const fn of listeners) fn(state, prev, action)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
