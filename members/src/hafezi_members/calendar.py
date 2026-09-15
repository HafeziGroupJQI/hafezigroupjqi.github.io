"""Persistent member calendar. Recurrences are expanded in the event's local timezone."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dateutil import rrule, tz
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, model_validator

from .auth import current_user, require_mutation


class Event(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    start: datetime
    end: datetime
    timezone: str = "America/New_York"
    location: str = Field(default="", max_length=500)
    description: str = Field(default="", max_length=10000)
    repeat: Literal["none", "weekly", "biweekly", "monthly"] = "none"
    until: date | None = None
    version: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def valid_schedule(self):
        self.title = self.title.strip()
        if not self.title:
            raise ValueError("title is required")
        try:
            zone = ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError("unknown timezone") from error
        for name in ("start", "end"):
            value = getattr(self, name)
            if value.tzinfo is not None:
                value = value.astimezone(zone).replace(tzinfo=None)
                setattr(self, name, value)
            if not tz.datetime_exists(value, tz.gettz(self.timezone)):
                raise ValueError("time does not exist during the daylight-saving transition")
        if self.end <= self.start or self.end - self.start > timedelta(days=31):
            raise ValueError("end must follow start, within 31 days")
        if self.until and self.until < self.start.date():
            raise ValueError("recurrence end must not precede start")
        return self


def starts(event: Event, first: datetime, last: datetime):
    zone = ZoneInfo(event.timezone)
    first = first.astimezone(zone).replace(tzinfo=None)
    last = last.astimezone(zone).replace(tzinfo=None)
    if event.repeat == "none":
        return [event.start] if first <= event.start <= last else []
    until = datetime.combine(event.until, datetime.max.time()) if event.until else None
    rule = rrule.rrule(
        rrule.MONTHLY if event.repeat == "monthly" else rrule.WEEKLY,
        interval=2 if event.repeat == "biweekly" else 1,
        dtstart=event.start,
        until=until,
    )
    return rule.between(first, last, inc=True)


class CalendarStore:
    def __init__(self, filename: str):
        self.filename = filename
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, data TEXT NOT NULL, "
                "exceptions TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL, updated_by TEXT NOT NULL)"
            )
            db.execute("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY)")
            if not db.execute("SELECT 1 FROM migrations WHERE id='initial-calendar'").fetchone():
                for identifier, event in (
                    (
                        "group-meeting-2026",
                        Event(
                            title="Group Meeting",
                            start="2026-09-16T12:00:00",
                            end="2026-09-16T13:00:00",
                            repeat="weekly",
                        ),
                    ),
                    (
                        "laser-safety-2026",
                        Event(title="Laser Safety Training", start="2026-09-17T09:00:00", end="2026-09-17T10:00:00"),
                    ),
                ):
                    db.execute(
                        "INSERT OR IGNORE INTO events(id,data,version,updated_by) VALUES(?,?,1,'seed')",
                        (identifier, event.model_dump_json(exclude={"version"})),
                    )
                db.execute("INSERT INTO migrations VALUES('initial-calendar')")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.filename, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, identifier: str):
        with self.connect() as db:
            row = db.execute("SELECT * FROM events WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise HTTPException(404, "event not found")
        return dict(row)

    @staticmethod
    def public(row):
        return {**json.loads(row["data"]), "id": row["id"], "version": row["version"]}

    def occurrences(self, first: datetime, last: datetime):
        result = []
        with self.connect() as db:
            rows = db.execute("SELECT * FROM events").fetchall()
        for row in rows:
            event = Event.model_validate_json(row["data"])
            exceptions = json.loads(row["exceptions"])
            duration = event.end - event.start
            zone = ZoneInfo(event.timezone)

            def append(start, end, details, key, zone=zone, row=row):
                start, end = start.replace(tzinfo=zone), end.replace(tzinfo=zone)
                if start < last and end > first:
                    result.append(
                        {
                            "id": f"{row['id']}@{key}",
                            "title": details.title,
                            "start": start.isoformat(),
                            "end": end.isoformat(),
                            "extendedProps": {
                                "eventId": row["id"],
                                "occurrence": key,
                                "version": row["version"],
                                "location": details.location,
                            },
                        }
                    )

            for start in starts(event, first - duration, last):
                key = start.isoformat()
                if key not in exceptions and tz.datetime_exists(start, tz.gettz(event.timezone)):
                    append(start, start + duration, event, key)
            for key, override in exceptions.items():
                if override is not None:
                    changed = Event.model_validate(override)
                    append(changed.start, changed.end, changed, key)
        return sorted(result, key=lambda item: item["start"])

    def change(self, identifier, event, version, user, occurrence=None):
        row = self.get(identifier)
        exceptions = json.loads(row["exceptions"])
        if occurrence:
            original = Event.model_validate_json(row["data"])
            try:
                point = datetime.fromisoformat(occurrence)
                if point.tzinfo is not None:
                    raise ValueError()
                aware = point.replace(tzinfo=ZoneInfo(original.timezone))
            except ValueError as error:
                raise HTTPException(422, "invalid occurrence") from error
            if original.repeat == "none" or not starts(original, aware, aware):
                raise HTTPException(422, "occurrence is not part of this series")
            if event and event.timezone != original.timezone:
                raise HTTPException(422, "an occurrence must retain the series timezone")
            exceptions[point.isoformat()] = event.model_dump(mode="json", exclude={"version"}) if event else None
            data = row["data"]
        elif event:
            original = Event.model_validate_json(row["data"])
            if any(
                getattr(original, key) != getattr(event, key) for key in ("start", "end", "repeat", "until", "timezone")
            ):
                exceptions = {}
            data = event.model_dump_json(exclude={"version"})
        with self.connect() as db:
            if event is None and occurrence is None:
                changed = db.execute("DELETE FROM events WHERE id=? AND version=?", (identifier, version))
            else:
                changed = db.execute(
                    "UPDATE events SET data=?,exceptions=?,version=version+1,updated_by=? WHERE id=? AND version=?",
                    (data, json.dumps(exceptions), user, identifier, version),
                )
            if changed.rowcount != 1:
                raise HTTPException(409, "event changed; reload before saving")
        return self.public(self.get(identifier)) if event is not None or occurrence else {"deleted": True}


router = APIRouter(prefix="/api/calendar/events", dependencies=[Depends(current_user)])


def store(request: Request):
    return request.app.state.calendar


StoreDependency = Annotated[CalendarStore, Depends(store)]
UserDependency = Annotated[dict, Depends(current_user)]


@router.get("")
def list_events(start: datetime, end: datetime, calendar: StoreDependency):
    if start.tzinfo is None or end.tzinfo is None or end <= start or end - start > timedelta(days=370):
        raise HTTPException(422, "request an aware date range of at most 370 days")
    return calendar.occurrences(start, end)


@router.get("/{identifier}")
def get_event(identifier: str, calendar: StoreDependency):
    row = calendar.get(identifier)
    return {**calendar.public(row), "exceptions": json.loads(row["exceptions"])}


@router.post("", status_code=201, dependencies=[Depends(require_mutation)])
def create_event(event: Event, user: UserDependency, calendar: StoreDependency):
    identifier = str(uuid4())
    with calendar.connect() as db:
        db.execute(
            "INSERT INTO events(id,data,version,updated_by) VALUES(?,?,1,?)",
            (identifier, event.model_dump_json(exclude={"version"}), user["login"]),
        )
    return calendar.public(calendar.get(identifier))


@router.put("/{identifier}", dependencies=[Depends(require_mutation)])
def update_event(
    identifier: str, event: Event, user: UserDependency, calendar: StoreDependency, occurrence: str | None = None
):
    return calendar.change(identifier, event, event.version, user["login"], occurrence)


@router.delete("/{identifier}", dependencies=[Depends(require_mutation)])
def delete_event(
    identifier: str,
    version: Annotated[int, Query(ge=1)],
    user: UserDependency,
    calendar: StoreDependency,
    occurrence: str | None = None,
):
    return calendar.change(identifier, None, version, user["login"], occurrence)
