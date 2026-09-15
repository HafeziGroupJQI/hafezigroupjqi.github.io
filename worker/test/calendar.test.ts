import { applyD1Migrations, env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { member, occurrences } from "./helpers"

const EVENT = "/api/calendar/events/group-meeting-2026"

describe("calendar", () => {
  it("expands the seeded series in New York time across the DST change", async () => {
    const client = await member()
    const events = await occurrences(client)
    const meetings = events.filter((event) => event.title === "Group Meeting")
    expect(meetings.map((event) => event.start)).toEqual(
      [16, 23, 30].map((day) => `2026-09-${day}T12:00:00-04:00`),
    )
    expect(meetings[0].id).toBe("group-meeting-2026@2026-09-16T12:00:00")
    expect(meetings[0].extendedProps).toEqual({
      eventId: "group-meeting-2026",
      occurrence: "2026-09-16T12:00:00",
      version: 1,
      location: "",
    })
    const training = events.find((event) => event.title === "Laser Safety Training")
    expect(training.start).toBe("2026-09-17T09:00:00-04:00")
    expect(training.end).toBe("2026-09-17T10:00:00-04:00")
    const winter = await occurrences(
      client,
      "2026-11-01T00:00:00-04:00",
      "2026-11-12T00:00:00-05:00",
    )
    expect(winter.length).toBeGreaterThan(0)
    for (const event of winter) expect(event.start.endsWith("12:00:00-05:00")).toBe(true)
  })

  it("moves and deletes single occurrences", async () => {
    const client = await member()
    const created = await client.json("/api/calendar/events", {
      method: "POST",
      body: JSON.stringify({
        title: "Series",
        start: "2026-09-16T12:00:00",
        end: "2026-09-16T13:00:00",
        repeat: "weekly",
      }),
    })
    expect(created.status).toBe(201)
    const EVENT = `/api/calendar/events/${created.body.id}`
    const event = (await client.json(EVENT)).body
    const override = {
      ...event,
      title: "Moved meeting",
      start: "2026-10-02T12:00:00",
      end: "2026-10-02T13:00:00",
      repeat: "none",
    }
    const moved = await client.json(`${EVENT}?occurrence=2026-09-16T12:00:00`, {
      method: "PUT",
      body: JSON.stringify(override),
    })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect((await occurrences(client)).filter((item) => item.title === "Series")).toHaveLength(2)
    const october = await occurrences(
      client,
      "2026-10-01T00:00:00-04:00",
      "2026-10-03T00:00:00-04:00",
    )
    expect(october.map((item) => item.title)).toEqual(["Moved meeting"])
    const removed = await client.json(`${EVENT}?version=2&occurrence=2026-09-23T12:00:00`, {
      method: "DELETE",
    })
    expect(removed.status).toBe(200)
    expect((await occurrences(client)).filter((item) => item.title === "Series")).toHaveLength(1)
    const wrongZone = await client.json(`${EVENT}?occurrence=2026-09-30T12:00:00`, {
      method: "PUT",
      body: JSON.stringify({ ...override, timezone: "Europe/Paris", version: 3 }),
    })
    expect(wrongZone.status).toBe(422)
    const notInSeries = await client.json(`${EVENT}?occurrence=2026-09-18T12:00:00`, {
      method: "PUT",
      body: JSON.stringify({ ...override, version: 3 }),
    })
    expect(notInSeries.status).toBe(422)
    const rescheduled = await client.json(EVENT, {
      method: "PUT",
      body: JSON.stringify({
        ...event,
        start: "2026-09-16T14:00:00",
        end: "2026-09-16T15:00:00",
        version: 3,
      }),
    })
    expect(rescheduled.status).toBe(200)
    expect((await client.json(EVENT)).body.exceptions).toEqual({})
  })

  it("validates schedules and enforces origin and CSRF checks", async () => {
    const client = await member()
    const event = { title: "Test", start: "2026-09-20T10:00:00", end: "2026-09-20T11:00:00" }
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      client.json("/api/calendar/events", { method: "POST", body: JSON.stringify(body), headers })
    expect((await post(event, { origin: "https://evil.example" })).status).toBe(403)
    expect((await post(event, { "x-csrf-token": "wrong" })).status).toBe(403)
    expect((await post({ ...event, end: event.start })).status).toBe(422)
    expect((await post({ ...event, timezone: "invalid" })).status).toBe(422)
    const gap = { ...event, start: "2027-03-14T02:30:00", end: "2027-03-14T03:30:00" }
    expect((await post(gap)).status).toBe(422)
    expect((await post({ ...event, until: "2026-09-01" })).status).toBe(422)
    expect((await post({ ...event, title: "   " })).status).toBe(422)
    const created = await post(event)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      ...event,
      timezone: "America/New_York",
      repeat: "none",
      until: null,
      version: 1,
    })
    const naive = await client.fetch(
      "/api/calendar/events?start=2026-09-01T00:00:00&end=2026-10-01T00:00:00",
    )
    expect(naive.status).toBe(422)
  })

  it("honours biweekly and monthly repeats with an end date", async () => {
    const client = await member()
    for (const [repeat, expected] of [
      ["biweekly", 3],
      ["monthly", 2],
    ] as const) {
      const created = await client.json("/api/calendar/events", {
        method: "POST",
        body: JSON.stringify({
          title: repeat,
          start: "2026-10-01T10:00:00",
          end: "2026-10-01T11:00:00",
          repeat,
          until: "2026-11-01",
        }),
      })
      expect(created.status).toBe(201)
      const events = await occurrences(
        client,
        "2026-10-01T00:00:00-04:00",
        "2026-12-01T00:00:00-05:00",
      )
      expect(events.filter((event) => event.title === repeat)).toHaveLength(expected)
    }
  })

  it("skips months without the series day and DST-nonexistent occurrences", async () => {
    const client = await member()
    const monthly = await client.json("/api/calendar/events", {
      method: "POST",
      body: JSON.stringify({
        title: "month-end",
        start: "2027-01-31T02:30:00",
        end: "2027-01-31T03:00:00",
        repeat: "monthly",
      }),
    })
    expect(monthly.status).toBe(201)
    const events = await occurrences(
      client,
      "2027-01-01T00:00:00-05:00",
      "2027-06-01T00:00:00-04:00",
    )
    expect(
      events.filter((event) => event.title === "month-end").map((event) => event.start),
    ).toEqual([
      "2027-01-31T02:30:00-05:00",
      "2027-03-31T02:30:00-04:00",
      "2027-05-31T02:30:00-04:00",
    ])
    const weekly = await client.json("/api/calendar/events", {
      method: "POST",
      body: JSON.stringify({
        title: "spring",
        start: "2027-03-07T02:30:00",
        end: "2027-03-07T03:00:00",
        repeat: "weekly",
        until: "2027-03-21",
      }),
    })
    expect(weekly.status).toBe(201)
    const spring = await occurrences(
      client,
      "2027-03-01T00:00:00-05:00",
      "2027-04-01T00:00:00-04:00",
    )
    expect(spring.filter((event) => event.title === "spring").map((event) => event.start)).toEqual([
      "2027-03-07T02:30:00-05:00",
      "2027-03-21T02:30:00-04:00",
    ])
  })

  it("detects stale versions and keeps edits and deletions across a redeploy", async () => {
    const client = await member()
    const original = (await client.json(EVENT)).body
    expect(original.exceptions).toEqual({})
    const updated = { ...original, title: "Weekly Group Meeting" }
    const put = (body: unknown) => client.json(EVENT, { method: "PUT", body: JSON.stringify(body) })
    expect((await put(updated)).status).toBe(200)
    expect((await put(updated)).status).toBe(409)
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    expect((await client.json(EVENT)).body.title).toBe("Weekly Group Meeting")
    const remove = await client.json("/api/calendar/events/laser-safety-2026?version=1", {
      method: "DELETE",
    })
    expect(remove.status).toBe(200)
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    expect((await client.json("/api/calendar/events/laser-safety-2026")).status).toBe(404)
  })
})
