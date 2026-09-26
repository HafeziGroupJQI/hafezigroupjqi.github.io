// One liveness derivation for the whole site. The Worker computes it from the server-stamped
// last_seen_ns; the dashboard only re-ticks the age between polls (frontend/dashboard/liveness.js
// pins the same thresholds). instrument_status rows never expire, so every view that shows an
// instrument status must go through effectiveStatus().

export const ONLINE_MS = 45_000 // three missed 15 s heartbeats
export const STALE_MS = 300_000

export type Liveness = "online" | "stale" | "offline" | "pending"

/** Milliseconds since last_seen, or null when the device has never been seen. */
export function ageMs(lastSeenNs: number | string | null, nowMs: number): number | null {
  if (lastSeenNs == null) return null
  const seenMs = Number(lastSeenNs) / 1e6
  if (!Number.isFinite(seenMs)) return null
  return Math.max(0, Math.round(nowMs - seenMs))
}

export function liveness(
  lastSeenNs: number | string | null,
  enrolled: boolean,
  nowMs: number,
): Liveness {
  const age = ageMs(lastSeenNs, nowMs)
  if (!enrolled || age == null) return "pending"
  if (age <= ONLINE_MS) return "online"
  if (age <= STALE_MS) return "stale"
  return "offline"
}

/** An instrument can only be as alive as the PC reporting it. */
export function effectiveStatus(status: string, device: Liveness): string {
  return device === "online" ? status : "offline"
}
