import { DateTime } from "luxon"
import { requireMutation } from "../auth"
import type { Env } from "../env"
import { HttpError, json, readJson } from "../http"
import type { Session } from "../session"
import { parseEvent } from "./model"
import { CalendarStore } from "./store"

const AWARE = /(?:Z|[+-]\d\d:?\d\d)$/i

function range(url: URL): [DateTime, DateTime] {
  const raw = [url.searchParams.get("start"), url.searchParams.get("end")]
  const [start, end] = raw.map((value) =>
    value && AWARE.test(value) ? DateTime.fromISO(value, { setZone: true }) : DateTime.invalid("naive"),
  )
  if (!start.isValid || !end.isValid || end <= start || end.diff(start, "days").days > 370)
    throw new HttpError(422, "request an aware date range of at most 370 days")
  return [start, end]
}

export async function calendarRoutes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/calendar\/events(?:\/([^/]+))?$/)
  if (!match) return null
  const id = match[1] ? decodeURIComponent(match[1]) : null
  const store = new CalendarStore(env.DB)
  const occurrence = url.searchParams.get("occurrence") || null
  if (request.method === "GET") {
    if (!id) {
      const [start, end] = range(url)
      return json(await store.occurrences(start, end))
    }
    const row = await store.get(id)
    return json({ ...store.public(row), exceptions: JSON.parse(row.exceptions) })
  }
  requireMutation(request, url, session)
  if (request.method === "POST" && !id) {
    const { event } = parseEvent(await readJson(request))
    return json(await store.create(event, session.login), 201)
  }
  if (request.method === "PUT" && id) {
    const { event, version } = parseEvent(await readJson(request))
    return json(await store.change(id, event, version, session.login, occurrence))
  }
  if (request.method === "DELETE" && id) {
    const version = Number(url.searchParams.get("version"))
    if (!Number.isInteger(version) || version < 1) throw new HttpError(422, "version must be at least 1")
    return json(await store.change(id, null, version, session.login, occurrence))
  }
  throw new HttpError(405, "method not allowed")
}
