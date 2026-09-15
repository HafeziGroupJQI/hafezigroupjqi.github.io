import { DateTime, IANAZone } from "luxon"
import { HttpError } from "../http"

export type Repeat = "none" | "weekly" | "biweekly" | "monthly"

// Times are stored as wall-clock strings in the event's zone, as the Python gateway did.
export interface Event {
  title: string
  start: string
  end: string
  timezone: string
  location: string
  description: string
  repeat: Repeat
  until: string | null
}

export const WALL = "yyyy-MM-dd'T'HH:mm:ss"
export const DEFAULT_ZONE = "America/New_York"
const REPEATS = new Set<Repeat>(["none", "weekly", "biweekly", "monthly"])
const OFFSET = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i

export const invalid = (detail: string) => new HttpError(422, detail)

// Pure wall-clock arithmetic: interpret a wall string in UTC so DST never shifts it.
export const wall = (value: string) => DateTime.fromISO(value, { zone: "utc" })

// Does this wall time exist in the zone? Luxon shifts a nonexistent local time forward.
export const exists = (wallTime: string, zone: string) =>
  DateTime.fromISO(wallTime, { zone }).toFormat(WALL) === wallTime

function toWall(raw: unknown, zone: string, field: string): string {
  if (typeof raw !== "string" || !raw) throw invalid(`${field} is required`)
  const parsed = DateTime.fromISO(raw, { zone })
  if (!parsed.isValid) throw invalid(`${field} is not a valid date and time`)
  const wallTime = parsed.toFormat(WALL)
  if (!OFFSET.test(raw) && wall(raw).toFormat(WALL) !== wallTime)
    throw invalid("time does not exist during the daylight-saving transition")
  return wallTime
}

const text = (value: unknown, field: string, max: number): string => {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") throw invalid(`${field} must be text`)
  if (value.length > max) throw invalid(`${field} must be at most ${max} characters`)
  return value
}

export function parseEvent(input: unknown): { event: Event; version: number } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalid("event must be an object")
  const body = input as Record<string, unknown>
  const title = text(body.title, "title", 200).trim()
  if (!title) throw invalid("title is required")
  const timezone = body.timezone === undefined || body.timezone === null ? DEFAULT_ZONE : body.timezone
  if (typeof timezone !== "string" || !IANAZone.isValidZone(timezone)) throw invalid("unknown timezone")
  const start = toWall(body.start, timezone, "start")
  const end = toWall(body.end, timezone, "end")
  const span = wall(end).diff(wall(start), "days").days
  if (span <= 0 || span > 31) throw invalid("end must follow start, within 31 days")
  const repeat = body.repeat === undefined || body.repeat === null ? "none" : body.repeat
  if (typeof repeat !== "string" || !REPEATS.has(repeat as Repeat)) throw invalid("unknown repeat")
  let until: string | null = null
  if (body.until !== undefined && body.until !== null && body.until !== "") {
    if (typeof body.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.until) || !wall(body.until).isValid)
      throw invalid("recurrence end must be a date")
    until = body.until
    if (until < start.slice(0, 10)) throw invalid("recurrence end must not precede start")
  }
  let version = 0
  if (body.version !== undefined && body.version !== null) {
    if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 0)
      throw invalid("version must be a non-negative integer")
    version = body.version
  }
  return {
    event: {
      title,
      start,
      end,
      timezone,
      location: text(body.location, "location", 500),
      description: text(body.description, "description", 10000),
      repeat: repeat as Repeat,
      until,
    },
    version,
  }
}

// Stored JSON keeps the Python field order so seeded and edited rows look alike.
export const serialize = (event: Event) =>
  JSON.stringify({
    title: event.title,
    start: event.start,
    end: event.end,
    timezone: event.timezone,
    location: event.location,
    description: event.description,
    repeat: event.repeat,
    until: event.until,
  })
