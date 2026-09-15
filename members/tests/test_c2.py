import httpx
from itsdangerous import URLSafeTimedSerializer


def test_gateway_forwards_identity_and_handles_outage(client, app, monkeypatch):
    app.state.settings.c2_url = "http://127.0.0.1:8000"
    app.state.settings.c2_gateway_secret = "a-shared-gateway-secret-32-characters"
    calls = []
    original = httpx.AsyncClient

    def handler(request):
        user = URLSafeTimedSerializer(app.state.settings.c2_gateway_secret, salt="hafezi-c2-gateway").loads(
            request.headers["x-hafezi-assertion"], max_age=30
        )
        assert user["login"] == "dev"
        assert user["path"] == request.url.path
        assert user["method"] == request.method
        calls.append(request.url.path)
        return httpx.Response(200, json=[])

    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs)
    )
    assert client.get("/api/c2/status").json()["state"] == "connected"
    assert client.get("/api/c2/instruments").json() == []
    assert client.post("/api/c2/instruments/device/poll").status_code == 200
    assert calls[-1] == "/api/instruments/device/poll"
    assert client.post("/api/c2/instruments/device/poll", headers={"X-CSRF-Token": "wrong"}).status_code == 403

    def outage(request):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(outage), **kwargs)
    )
    assert client.get("/api/c2/status").json()["state"] == "unavailable"
    assert client.get("/api/c2/instruments").status_code == 503
