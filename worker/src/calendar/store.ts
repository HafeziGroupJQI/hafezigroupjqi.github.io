import { DateTime } from "luxon"
import { HttpError } from "../http"
import { type Event, WALL, exists, serialize, wall } from "./model"
import { starts } from "./recurrence"

export interface Row {
  id: string
  data: string
  exceptions: string
  version: number
  updated_by: string
}

export interface Occurrence {
  id: string
  title: string
  start: string
  end: string
  extendedProps: { eventId: string; occurrence: string; version: number; location: string }
}

type Exceptions = Record<string, Event | null>

const iso = (value: DateTime) => value.toISO({ suppressMilliseconds: true }) as string

export class CalendarStore {
  constructor(private db: D1Database) {}

  async get(id: string): Promise<Row> {
    const row = await this.db.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<Row>()
    if (!row) throw new HttpError(404, "event not found")
    return row
  }

  public(row: Row) {
    return { ...(JSON.parse(row.data) as Event), id: row.id, version: row.version }
  }

  async create(event: Event, user: string) {
    const id = crypto.randomUUID()
    await this.db
      .prepare("INSERT INTO events (id, data, version, updated_by) VALUES (?, ?, 1, ?)")
      .bind(id, serialize(event), user)
      .run()
    return this.public(await this.get(id))
  }

  // FullCalendar-shaped occurrences overlapping [first, last); exceptions remove or replace
  // single occurrences of a series.
  async occurrences(first: DateTime, last: DateTime): Promise<Occurrence[]> {
    const { results } = await this.db.prepare("SELECT * FROM events").all<Row>()
    const found: Occurrence[] = []
    for (const row of results) {
      const event = JSON.parse(row.data) as Event
      const exceptions = JSON.parse(row.exceptions) as Exceptions
      const zone = event.timezone
      const duration = wall(event.end).diff(wall(event.start))
      const append = (startWall: DateTime, endWall: DateTime, details: Event, key: string) => {
        const start = DateTime.fromISO(startWall.toFormat(WALL), { zone })
        const end = DateTime.fromISO(endWall.toFormat(WALL), { zone })
        if (start < last && end > first)
          found.push({
            id: `${row.id}@${key}`,
            title: details.title,
            start: iso(start),
            end: iso(end),
            extendedProps: {
              eventId: row.id,
              occurrence: key,
              version: row.version,
              location: details.location,
            },
          })
      }
      for (const start of starts(event, first.minus(duration), last)) {
        const key = start.toFormat(WALL)
        if (!(key in exceptions) && exists(key, zone)) append(start, start.plus(duration), event, key)
      }
      for (const [key, override] of Object.entries(exceptions))
        if (override) append(wall(override.start), wall(override.end), override, key)
    }
    return found.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  }

  // Update or delete a series, or one occurrence of it. `version` must match the stored
  // row or the caller gets a 409 and must reload.
  async change(
    id: string,
    event: Event | null,
    version: number,
    user: string,
    occurrence?: string | null,
  ) {
    const row = await this.get(id)
    let exceptions = JSON.parse(row.exceptions) as Exceptions
    let data = row.data
    if (occurrence) {
      const original = JSON.parse(row.data) as Event
      const point = wall(occurrence)
      if (/(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(occurrence) || !point.isValid)
        throw new HttpError(422, "invalid occurrence")
      const aware = DateTime.fromISO(point.toFormat(WALL), { zone: original.timezone })
      if (original.repeat === "none" || starts(original, aware, aware).length === 0)
        throw new HttpError(422, "occurrence is not part of this series")
      if (event && event.timezone !== original.timezone)
        throw new HttpError(422, "an occurrence must retain the series timezone")
      exceptions[point.toFormat(WALL)] = event
    } else if (event) {
      const original = JSON.parse(row.data) as Event
      const schedule: (keyof Event)[] = ["start", "end", "repeat", "until", "timezone"]
      if (schedule.some((key) => (original[key] ?? null) !== (event[key] ?? null))) exceptions = {}
      data = serialize(event)
    }
    const result =
      event === null && !occurrence
        ? await this.db.prepare("DELETE FROM events WHERE id = ? AND version = ?").bind(id, version).run()
        : await this.db
            .prepare(
              "UPDATE events SET data = ?, exceptions = ?, version = version + 1, updated_by = ? WHERE id = ? AND version = ?",
            )
            .bind(data, JSON.stringify(exceptions), user, id, version)
            .run()
    if (result.meta.changes !== 1) throw new HttpError(409, "event changed; reload before saving")
    return event !== null || occurrence ? this.public(await this.get(id)) : { deleted: true }
  }
}
