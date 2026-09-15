import { DateTime } from "luxon"
import { type Event, wall } from "./model"

// The wall-clock reading of an instant in a zone, as a UTC DateTime for arithmetic.
export const wallOf = (instant: DateTime, zone: string) => {
  const local = instant.setZone(zone)
  return DateTime.utc(local.year, local.month, local.day, local.hour, local.minute, local.second)
}

// Occurrence starts (wall clock) inside [first, last], inclusive, like dateutil's
// rrule.between(inc=True). Weekly steps keep the wall time; monthly keeps the day of month
// and skips months that lack it.
export function starts(event: Event, first: DateTime, last: DateTime): DateTime[] {
  const lo = wallOf(first, event.timezone)
  const hi = wallOf(last, event.timezone)
  const start = wall(event.start)
  if (event.repeat === "none") return lo <= start && start <= hi ? [start] : []
  const untilEnd = event.until ? wall(event.until).endOf("day") : null
  const end = untilEnd && untilEnd < hi ? untilEnd : hi
  const found: DateTime[] = []
  if (event.repeat === "monthly") {
    let n = Math.max(0, (lo.year - start.year) * 12 + lo.month - start.month - 1)
    for (; ; n++) {
      const candidate = start.plus({ months: n })
      if (candidate > end) break
      if (candidate.day !== start.day) continue
      if (candidate >= lo) found.push(candidate)
    }
  } else {
    const step = event.repeat === "biweekly" ? 14 : 7
    let n = Math.max(0, Math.floor(lo.diff(start, "days").days / step) - 1)
    for (; ; n++) {
      const candidate = start.plus({ days: step * n })
      if (candidate > end) break
      if (candidate >= lo) found.push(candidate)
    }
  }
  return found
}
