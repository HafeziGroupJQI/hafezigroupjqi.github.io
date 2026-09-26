// Device/instrument liveness, mirroring worker/src/devices/liveness.ts. The Worker computes
// `liveness` and `last_seen_age_ms` from its own clock; the browser only advances that age by the
// time since the fetch, so a pill turns stale at exactly 45 s without waiting for the next poll —
// and never invents its own threshold.

export const THRESHOLDS = Object.freeze({ ONLINE_MS: 45_000, STALE_MS: 300_000 })

/** Current heartbeat age: the server's age at fetch time plus the time since. */
export function ageMs(device, now) {
  if (device?.last_seen_age_ms == null) return null
  return device.last_seen_age_ms + Math.max(0, now - (device.fetched_at ?? now))
}

export function deviceLiveness(device, now) {
  const age = ageMs(device, now)
  if (!device?.enrolled || age == null) return "pending"
  if (age <= THRESHOLDS.ONLINE_MS) return "online"
  if (age <= THRESHOLDS.STALE_MS) return "stale"
  return "offline"
}

/** An instrument is only as alive as its PC; `unpolled` only means something on a live PC. */
export function instrumentLiveness(instrument, deviceState) {
  if (deviceState !== "online") return "offline"
  return instrument?.status ?? "unpolled"
}

export function ageLabel(ms) {
  if (ms == null) return "never"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export const LIVENESS_ORDER = ["online", "stale", "offline", "pending"]
