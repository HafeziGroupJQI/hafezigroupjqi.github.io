from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hafezi_members.app import create_app
from hafezi_members.settings import Settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    public = tmp_path / "public"
    members = tmp_path / "members"
    for root, title in ((public, "Public homepage"), (members, "Member homepage")):
        (root / "static").mkdir(parents=True)
        (root / "index.html").write_text(f"<h1>{title}</h1>")
        (root / "static/contentIndex.json").write_text('"public"' if root == public else '"secret"')
    (members / "resources/assets").mkdir(parents=True)
    (members / "resources/notes.html").write_text("<h1>Private notes</h1>")
    (members / "calendar.html").write_text("<h1>Calendar</h1>")
    (members / "instruments.html").write_text("<h1>Instruments</h1>")
    (members / "resources/assets/figure.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
    return Settings(
        _env_file=None,
        auth="dev",
        public_site_path=str(public),
        site_path=str(members),
        calendar_db=str(tmp_path / "calendar.sqlite"),
    )


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
def client(app):
    with TestClient(app, base_url="http://127.0.0.1:8100") as client:
        client.get("/auth/login")
        csrf = client.get("/api/session").json()["csrf"]
        client.headers.update({"Origin": "http://127.0.0.1:8100", "X-CSRF-Token": csrf})
        yield client
