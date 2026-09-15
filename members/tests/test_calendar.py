from hafezi_members.calendar import CalendarStore


def occurrences(client, start="2026-09-01T00:00:00-04:00", end="2026-10-01T00:00:00-04:00"):
    response = client.get("/api/calendar/events", params={"start": start, "end": end})
    assert response.status_code == 200, response.text
    return response.json()


def test_seed_dates_and_dst(client):
    events = occurrences(client)
    meetings = [event for event in events if event["title"] == "Group Meeting"]
    assert [event["start"] for event in meetings] == [f"2026-09-{day}T12:00:00-04:00" for day in (16, 23, 30)]
    training = next(event for event in events if event["title"] == "Laser Safety Training")
    assert training["start"] == "2026-09-17T09:00:00-04:00"
    assert training["end"] == "2026-09-17T10:00:00-04:00"
    winter = occurrences(client, "2026-11-01T00:00:00-04:00", "2026-11-12T00:00:00-05:00")
    assert all(event["start"].endswith("12:00:00-05:00") for event in winter)


def test_crud_conflicts_and_seed_persistence(client, settings):
    original = client.get("/api/calendar/events/group-meeting-2026").json()
    updated = {**original, "title": "Weekly Group Meeting"}
    assert client.put("/api/calendar/events/group-meeting-2026", json=updated).status_code == 200
    assert client.put("/api/calendar/events/group-meeting-2026", json=updated).status_code == 409
    CalendarStore(settings.calendar_db)
    assert client.get("/api/calendar/events/group-meeting-2026").json()["title"] == "Weekly Group Meeting"
    assert client.delete("/api/calendar/events/laser-safety-2026?version=1").status_code == 200
    CalendarStore(settings.calendar_db)
    assert client.get("/api/calendar/events/laser-safety-2026").status_code == 404


def test_occurrence_edit_delete_and_moved_range(client):
    event = client.get("/api/calendar/events/group-meeting-2026").json()
    override = {
        **event,
        "title": "Moved meeting",
        "start": "2026-10-02T12:00:00",
        "end": "2026-10-02T13:00:00",
        "repeat": "none",
    }
    response = client.put(
        "/api/calendar/events/group-meeting-2026", params={"occurrence": "2026-09-16T12:00:00"}, json=override
    )
    assert response.status_code == 200, response.text
    assert len([event for event in occurrences(client) if event["title"] == "Group Meeting"]) == 2
    october = occurrences(client, "2026-10-01T00:00:00-04:00", "2026-10-03T00:00:00-04:00")
    assert october[0]["title"] == "Moved meeting"
    assert (
        client.delete(
            "/api/calendar/events/group-meeting-2026", params={"version": 2, "occurrence": "2026-09-23T12:00:00"}
        ).status_code
        == 200
    )
    assert len(occurrences(client)) == 2  # remaining meeting and training


def test_validation_and_csrf(client):
    event = {"title": "Test", "start": "2026-09-20T10:00:00", "end": "2026-09-20T11:00:00"}
    assert (
        client.post("/api/calendar/events", json=event, headers={"Origin": "https://evil.example"}).status_code == 403
    )
    assert client.post("/api/calendar/events", json=event, headers={"X-CSRF-Token": "wrong"}).status_code == 403
    assert client.post("/api/calendar/events", json={**event, "end": event["start"]}).status_code == 422
    assert client.post("/api/calendar/events", json={**event, "timezone": "invalid"}).status_code == 422
    assert (
        client.post(
            "/api/calendar/events", json={**event, "start": "2027-03-14T02:30:00", "end": "2027-03-14T03:30:00"}
        ).status_code
        == 422
    )
    assert client.post("/api/calendar/events", json=event).status_code == 201


def test_monthly_and_biweekly_with_end(client):
    for repeat, expected in (("biweekly", 3), ("monthly", 2)):
        response = client.post(
            "/api/calendar/events",
            json={
                "title": repeat,
                "start": "2026-10-01T10:00:00",
                "end": "2026-10-01T11:00:00",
                "repeat": repeat,
                "until": "2026-11-01",
            },
        )
        assert response.status_code == 201
        events = occurrences(client, "2026-10-01T00:00:00-04:00", "2026-12-01T00:00:00-05:00")
        assert len([event for event in events if event["title"] == repeat]) == expected
