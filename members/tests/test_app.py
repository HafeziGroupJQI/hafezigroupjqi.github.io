from fastapi.testclient import TestClient


def test_public_home_and_index_without_login(app):
    with TestClient(app) as client:
        assert "Public homepage" in client.get("/").text
        assert client.get("/static/contentIndex.json").json() == "public"
        assert "x-robots-tag" not in client.get("/").headers
        assert client.get("/api/session").json()["user"] is None


def test_private_files_require_login(app):
    with TestClient(app, follow_redirects=False) as client:
        for path in ("/resources/notes", "/calendar", "/instruments"):
            assert client.get(path).status_code == 302
        assert client.get("/resources/assets/figure.svg").status_code == 401
        assert client.get("/api/c2/status").status_code == 401
        assert client.get("/api/calendar/events").status_code == 401


def test_member_pages_and_logout(client):
    for path in ("/", "/resources/notes", "/resources/notes.html", "/resources/assets/figure.svg", "/instruments"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert "Cookie" in response.headers["vary"]
        assert response.headers["x-robots-tag"] == "noindex, nofollow, noarchive"
    assert client.get("/static/contentIndex.json").json() == "secret"
    assert "Public homepage" in client.get("/auth/logout").text
    assert client.get("/static/contentIndex.json").json() == "public"
    assert client.get("/api/c2/status").status_code == 401


def test_login_returns_to_original_page(app):
    with TestClient(app, follow_redirects=False) as client:
        client.get("/resources/notes")
        assert client.get("/auth/login").headers["location"] == "/resources/notes"
        assert client.get("/auth/login?next=//evil.example").headers["location"] == "/"


def test_c2_not_configured_and_proxy_allowlist(client):
    assert client.get("/api/c2/status").json()["state"] == "not_configured"
    assert client.get("/api/c2/instruments").status_code == 503
    assert client.get("/api/c2/auth/login").status_code == 404
    assert client.post("/api/c2/setups").status_code == 404
