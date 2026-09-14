from fastapi.testclient import TestClient


def test_private_site_serves_clean_urls(app):
    with TestClient(app) as client:
        for path in ("/", "/notes", "/notes.html", "/drawing.excalidraw", "/assets/figure.svg"):
            response = client.get(path)
            assert response.status_code == 200
            assert response.headers["cache-control"] == "private, no-store"
            assert response.headers["x-robots-tag"] == "noindex, nofollow, noarchive"
            assert response.headers["referrer-policy"] == "no-referrer"


def test_instruments_redirect_to_c2(app):
    with TestClient(app, follow_redirects=False) as client:
        response = client.get("/instruments")
        assert response.status_code == 307
        assert response.headers["location"] == "http://127.0.0.1:8000"


def test_private_files_require_login(app):
    app.state.settings.auth = "github"
    with TestClient(app, follow_redirects=False) as client:
        page = client.get("/notes", headers={"Accept": "text/html"})
        assert page.status_code == 302
        assert page.headers["location"] == "/auth/login"
        assert client.get("/assets/figure.svg").status_code == 401
