from __future__ import annotations

import secrets
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import URLSafeTimedSerializer
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware

from . import __version__, auth
from .calendar import CalendarStore
from .calendar import router as calendar_router
from .settings import Settings


class SiteFiles(StaticFiles):
    async def get_response(self, path, scope):
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as error:
            if error.status_code != 404:
                raise
            response = None
        if (response is None or response.status_code == 404) and not path.endswith("/"):
            return await super().get_response(f"{path}.html", scope)
        if response is None:
            raise StarletteHTTPException(status_code=404)
        return response


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="Hafezi Group", version=__version__)
    app.state.settings = settings
    app.state.oauth = auth.setup_oauth(settings) if settings.auth == "github" else None
    app.state.calendar = CalendarStore(settings.calendar_db)
    app.include_router(calendar_router)
    public = SiteFiles(directory=settings.public_site_path, html=True, check_dir=False)
    members = SiteFiles(directory=settings.site_path, html=True, check_dir=False)

    @app.middleware("http")
    async def response_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Vary"] = "Cookie"
        # Every URL can change edition when a session changes. Never reuse an old edition.
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        if request.session.get("user") or request.url.path.startswith(("/api/", "/auth/", "/resources/")):
            response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
            response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": __version__}

    @app.get("/api/session")
    def session(request: Request):
        user = request.session.get("user")
        if user and not request.session.get("csrf"):
            request.session["csrf"] = secrets.token_urlsafe(32)
        return {"user": user, "csrf": request.session.get("csrf") if user else None}

    @app.get("/auth/login")
    async def login(request: Request, next: str | None = None):
        if next is not None:
            request.session["next"] = auth.safe_next(next)
        if settings.auth == "dev":
            request.session["user"] = {"login": "dev", "name": "Local member", "role": "owner"}
            request.session["csrf"] = secrets.token_urlsafe(32)
            return RedirectResponse(auth.safe_next(request.session.pop("next", "/")))
        redirect_uri = settings.base_url.rstrip("/") + "/auth/callback"
        return await app.state.oauth.github.authorize_redirect(request, redirect_uri)

    @app.get("/auth/callback")
    async def callback(request: Request):
        if settings.auth != "github":
            raise HTTPException(404)
        token = await app.state.oauth.github.authorize_access_token(request)
        user, role = await auth.authorize_github_user(token["access_token"], settings)
        target = auth.safe_next(request.session.pop("next", "/"))
        request.session.clear()
        request.session["user"] = {"login": user["login"], "name": user.get("name"), "role": role}
        request.session["csrf"] = secrets.token_urlsafe(32)
        return RedirectResponse(target)

    @app.get("/auth/logout")
    def logout(request: Request):
        request.session.clear()
        response = RedirectResponse("/")
        response.headers["Clear-Site-Data"] = '"cache", "storage"'
        return response

    @app.get("/api/c2/status", dependencies=[Depends(auth.current_user)])
    async def c2_status(request: Request):
        if not settings.c2_url or not settings.c2_gateway_secret:
            return {"state": "not_configured", "message": "Not configured"}
        try:
            await forward_c2(request, "instruments")
            return {"state": "connected", "message": "Connected"}
        except HTTPException:
            return {"state": "unavailable", "message": "Instrument service unavailable"}

    async def forward_c2(request: Request, target: str):
        user = auth.current_user(request)
        if not settings.c2_url or not settings.c2_gateway_secret:
            raise HTTPException(503, "Instrument service is not configured")
        assertion = URLSafeTimedSerializer(settings.c2_gateway_secret, salt="hafezi-c2-gateway").dumps(
            {
                "login": user["login"],
                "role": user["role"],
                "aud": "c2",
                "path": "/api/" + target,
                "method": request.method,
            }
        )
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                result = await client.request(
                    request.method,
                    settings.c2_url.rstrip("/") + "/api/" + target,
                    params=request.query_params,
                    headers={"X-Hafezi-Assertion": assertion},
                )
        except httpx.HTTPError as error:
            raise HTTPException(503, "Instrument service unavailable") from error
        if result.status_code >= 400:
            raise HTTPException(502, "Instrument service rejected the request")
        try:
            return result.json()
        except ValueError as error:
            raise HTTPException(502, "Invalid instrument service response") from error

    @app.api_route("/api/c2/{target:path}", methods=["GET", "POST"], dependencies=[Depends(auth.current_user)])
    async def c2_proxy(request: Request, target: str):
        import re

        readable = target in {"instruments", "setups", "events"} or re.fullmatch(
            r"instruments/[A-Za-z0-9_-]+/(status|history)", target
        )
        writable = re.fullmatch(r"instruments/[A-Za-z0-9_-]+/poll", target)
        if request.method == "POST":
            auth.require_mutation(request)
            if not writable:
                raise HTTPException(404)
        elif not readable:
            raise HTTPException(404)
        return await forward_c2(request, target)

    @app.get("/vault")
    @app.get("/vault/")
    def old_vault():
        return RedirectResponse("/resources/", status_code=308)

    @app.get("/{path:path}")
    async def site(request: Request, path: str):
        authenticated = bool(request.session.get("user"))
        edition = members if authenticated else public
        root = Path(settings.site_path if authenticated else settings.public_site_path)
        if not root.is_dir():
            raise HTTPException(503, "Website build unavailable")
        try:
            response = await edition.get_response(path, request.scope)
        except StarletteHTTPException as error:
            if error.status_code != 404:
                raise
            response = None
        if not authenticated and (response is None or response.status_code == 404):
            private_root = Path(settings.site_path).resolve()
            candidate = (private_root / path).resolve()
            known_private = candidate.is_relative_to(private_root) and (
                candidate.is_file()
                or candidate.with_suffix(candidate.suffix + ".html").is_file()
                or (candidate / "index.html").is_file()
            )
            if known_private or path.split("/")[0] in {"resources", "calendar", "instruments"}:
                if "text/html" in request.headers.get("accept", "") or not Path(path).suffix:
                    return auth.login_redirect(request)
                raise HTTPException(401, "login required")
        if response is None:
            raise HTTPException(404)
        return response

    # SessionMiddleware must wrap response_headers so request.session is available there.
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret,
        session_cookie="hafezi_members_session",
        max_age=settings.session_max_age,
        same_site="lax",
        https_only=settings.base_url.startswith("https"),
    )
    return app
