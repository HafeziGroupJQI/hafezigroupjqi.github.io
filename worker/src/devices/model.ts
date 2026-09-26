import { HttpError } from "../http"

// Validators for the agent and member payloads. Small and hand-rolled, matching the calendar
// feature's style. Each throws HttpError(422) on bad input.

const bad = (detail: string): never => {
  throw new HttpError(422, detail)
}

const asObject = (value: unknown, what: string): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : bad(`${what} must be an object`)

const asArray = (value: unknown, what: string): unknown[] =>
  Array.isArray(value) ? value : bad(`${what} must be an array`)

const str = (value: unknown, what: string, max = 512): string =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : bad(`${what} must be a non-empty string up to ${max} chars`)

const optStr = (value: unknown, what: string, max = 512): string | null =>
  value == null ? null : str(value, what, max)

// A local instrument id: same character set as vault equipment ids.
const LOCAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const localId = (value: unknown): string => {
  const s = str(value, "local_id", 64)
  return LOCAL_ID.test(s) ? s : bad("local_id must be lowercase letters, digits, and hyphens")
}

const DIRECTIONS = new Set(["source", "measure", "bidirectional"])

export interface Port {
  id: string
  label: string
  direction: string
}

export interface InstrumentDecl {
  local_id: string
  title: string | null
  model: string | null
  driver: string | null
  address_kind: string | null
  capabilities: string[]
  metrics: string[]
  ports: Port[]
}

const port = (value: unknown): Port => {
  const p = asObject(value, "port")
  const direction = str(p.direction, "port.direction", 16)
  if (!DIRECTIONS.has(direction)) bad("port.direction must be source, measure, or bidirectional")
  return {
    id: str(p.id, "port.id", 64),
    label: optStr(p.label, "port.label", 128) ?? "",
    direction,
  }
}

const names = (value: unknown, what: string): string[] =>
  asArray(value, what).map((v) => str(v, `${what} item`, 128))

export function parseInstrumentDecl(value: unknown): InstrumentDecl {
  const o = asObject(value, "instrument")
  return {
    local_id: localId(o.local_id),
    title: optStr(o.title, "title", 256),
    model: optStr(o.model, "model", 128),
    driver: optStr(o.driver, "driver", 128),
    address_kind: optStr(o.address_kind, "address_kind", 64),
    capabilities: o.capabilities == null ? [] : names(o.capabilities, "capabilities"),
    metrics: o.metrics == null ? [] : names(o.metrics, "metrics"),
    ports: o.ports == null ? [] : asArray(o.ports, "ports").map(port),
  }
}

export function parseInstrumentSet(value: unknown): InstrumentDecl[] {
  const list = asArray(value, "instruments").map(parseInstrumentDecl)
  const seen = new Set<string>()
  for (const inst of list) {
    if (seen.has(inst.local_id)) bad(`duplicate local_id ${inst.local_id}`)
    seen.add(inst.local_id)
  }
  if (list.length > 256) bad("too many instruments")
  return list
}

export interface EnrollRequest {
  enrollment_token: string
  hostname: string | null
  platform: string | null
  agent_version: string | null
}

export function parseEnroll(value: unknown): EnrollRequest {
  const o = asObject(value, "enroll request")
  return {
    enrollment_token: str(o.enrollment_token, "enrollment_token", 256),
    hostname: optStr(o.hostname, "hostname", 256),
    platform: optStr(o.platform, "platform", 64),
    agent_version: optStr(o.agent_version, "agent_version", 64),
  }
}

// A ns timestamp is carried as a decimal string to preserve 64-bit precision (a JS number cannot
// hold nanoseconds-since-epoch). Accept a string of digits, or a safe integer as a convenience.
const NS = /^\d{1,19}$/
export function tsNs(value: unknown, what = "ts_ns"): string {
  if (typeof value === "string" && NS.test(value)) return value
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value)
  return bad(`${what} must be a nanosecond timestamp (string of digits)`)
}

// A scalar reading from an instrument, the live firehose the DeviceHub fans out and coalesces.
// value carries a finite number; non-finite readings ("NaN"/"Inf"/"-Inf", the bus record string
// encoding) are preserved as value_text so the browser can render them without losing the point.
const NONFINITE = new Set(["NaN", "Inf", "-Inf"])

export interface ReadingIn {
  local_id: string
  metric: string
  value: number | null
  value_text: string | null
  ts_ns: string
  seq: number | null
  units: string | null
}

function parseReading(value: unknown): ReadingIn {
  const o = asObject(value, "reading")
  const raw = o.value
  let numeric: number | null = null
  let text: string | null = null
  if (typeof raw === "number" && Number.isFinite(raw)) numeric = raw
  else if (typeof raw === "string" && NONFINITE.has(raw)) text = raw
  else if (raw == null) numeric = null
  else bad('reading.value must be a finite number, null, or one of "NaN"/"Inf"/"-Inf"')
  return {
    local_id: localId(o.local_id),
    metric: str(o.metric, "reading.metric", 128),
    value: numeric,
    value_text: text,
    ts_ns: tsNs(o.ts_ns, "reading.ts_ns"),
    seq: typeof o.seq === "number" && Number.isSafeInteger(o.seq) ? o.seq : null,
    units: optStr(o.units, "reading.units", 64),
  }
}

// Readings arrive as { readings: [...] } or a bare array, batched by the agent.
export function parseReadings(value: unknown): ReadingIn[] {
  const arr = Array.isArray(value)
    ? value
    : asArray(asObject(value, "readings body").readings, "readings")
  if (arr.length > 1000) bad("too many readings in one batch")
  return arr.map(parseReading)
}

const LEVELS = new Set(["debug", "info", "warn", "error"])

export interface LogIn {
  local_id: string | null
  level: string
  message: string
  ts_ns: string
}

function parseLog(value: unknown): LogIn {
  const o = asObject(value, "log")
  const level = o.level == null ? "info" : str(o.level, "log.level", 16)
  if (!LEVELS.has(level)) bad("log.level must be debug, info, warn, or error")
  return {
    local_id: o.local_id == null ? null : localId(o.local_id),
    level,
    message: str(o.message, "log.message", 4096),
    ts_ns: tsNs(o.ts_ns, "log.ts_ns"),
  }
}

export function parseLogs(value: unknown): LogIn[] {
  const arr = Array.isArray(value) ? value : asArray(asObject(value, "logs body").logs, "logs")
  if (arr.length > 1000) bad("too many logs in one batch")
  return arr.map(parseLog)
}

const STATUSES = new Set(["online", "offline", "unpolled"])

// ---- experiment spec (the Setup.json shape, adapted from the Scripts reference) ----

export interface SelectedInstrument {
  device: string | null
  local_id: string
  family: string | null
  ports: string[]
}

export interface ExperimentSpec {
  experiment_label: string
  experiment_prompt: string
  selected_instruments: SelectedInstrument[]
  duts: Array<{ name: string; ports: string[] }>
  netlist: Array<{ from: string; to: string }>
  available_endpoints: string[]
  data_output_format: Record<string, unknown>
  plot_formats: unknown[]
  points: number
}

const endpoint = (v: unknown, what: string) => str(v, what, 128)

export function parseExperimentSpec(value: unknown): ExperimentSpec {
  const o = asObject(value, "experiment spec")
  const selected = asArray(o.selected_instruments ?? [], "selected_instruments").map((v) => {
    const s = asObject(v, "selected_instrument")
    return {
      device: optStr(s.device, "selected_instrument.device", 64),
      local_id: localId(s.local_id),
      family: optStr(s.family, "selected_instrument.family", 128),
      ports: s.ports == null ? [] : names(s.ports, "selected_instrument.ports"),
    }
  })
  if (selected.length === 0) bad("select at least one instrument")
  const duts = asArray(o.duts ?? [], "duts").map((v) => {
    const d = asObject(v, "dut")
    return {
      name: str(d.name, "dut.name", 128),
      ports: d.ports == null ? [] : names(d.ports, "dut.ports"),
    }
  })
  const netlist = asArray(o.netlist ?? [], "netlist").map((v) => {
    const n = asObject(v, "netlist edge")
    return { from: endpoint(n.from, "netlist.from"), to: endpoint(n.to, "netlist.to") }
  })
  const pts = o.points
  const points =
    typeof pts === "number" && Number.isInteger(pts) && pts > 0 && pts <= 100000 ? pts : 101
  return {
    experiment_label: str(o.experiment_label ?? "experiment", "experiment_label", 128),
    experiment_prompt: str(o.experiment_prompt ?? "measure", "experiment_prompt", 8192),
    selected_instruments: selected,
    duts,
    netlist,
    available_endpoints:
      o.available_endpoints == null ? [] : names(o.available_endpoints, "available_endpoints"),
    data_output_format:
      o.data_output_format == null ? {} : asObject(o.data_output_format, "data_output_format"),
    plot_formats: o.plot_formats == null ? [] : asArray(o.plot_formats, "plot_formats"),
    points,
  }
}

export interface Heartbeat {
  ts_ns: string
  statuses: Array<{ local_id: string; status: string }>
}

export function parseHeartbeat(value: unknown): Heartbeat {
  const o = asObject(value, "heartbeat")
  const statusesObj = asObject(o.statuses ?? {}, "statuses")
  const statuses = Object.entries(statusesObj).map(([local_id, status]) => {
    const s = str(status, `status for ${local_id}`, 16)
    if (!STATUSES.has(s)) bad("status must be online, offline, or unpolled")
    return { local_id: localId(local_id), status: s }
  })
  return { ts_ns: tsNs(o.ts_ns), statuses }
}
