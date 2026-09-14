from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware

from . import __version__, auth
from .settings import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="Hafezi members gateway", version=__version__)
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret,
        session_cookie="hafezi_members_session",
        max_age=settings.session_max_age,
        same_site="lax",
        https_only=settings.base_url.startswith("https"),
    )
    app.state.settings = settings
    app.state.oauth = auth.setup_oauth(settings) if settings.auth == "github" else None

    @app.middleware("http")
    async def private_response_headers(request: Request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/auth/") and request.url.path != "/api/health":
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
            response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/api/health")
    def health():
        return {"ok": True, "version": __version__}

    @app.get("/auth/login")
    async def login(request: Request):
        if settings.auth == "dev":
            return RedirectResponse(auth.safe_next(request.session.pop("next", "/")))
        redirect_uri = settings.base_url.rstrip("/") + "/auth/callback"
        return await app.state.oauth.github.authorize_redirect(request, redirect_uri)

    @app.get("/auth/callback")
    async def callback(request: Request):
        token = await app.state.oauth.github.authorize_access_token(request)
        user, role = await auth.authorize_github_user(token["access_token"], settings)
        request.session["user"] = {"login": user["login"], "name": user.get("name"), "role": role}
        return RedirectResponse(auth.safe_next(request.session.pop("next", "/")))

    @app.get("/auth/logout")
    def logout(request: Request):
        request.session.clear()
        return RedirectResponse(settings.public_site_url)

    @app.get("/instruments")
    def instruments():
        return RedirectResponse(settings.c2_url)

    site = Path(settings.site_path)
    if site.is_dir():
        app.mount("/", AuthenticatedStaticFiles(directory=site, html=True, settings=settings), name="private-site")
    else:

        @app.get("/")
        def missing_site():
            return JSONResponse({"detail": f"private site build is missing at {site}"}, status_code=503)

    return app


class AuthenticatedStaticFiles(StaticFiles):
    def __init__(self, *, settings: Settings, **kwargs):
        super().__init__(**kwargs)
        self.settings = settings

    async def __call__(self, scope, receive, send):
        request = Request(scope, receive=receive)
        if self.settings.auth == "github" and not request.session.get("user"):
            accepts_html = "text/html" in request.headers.get("accept", "")
            suffix = Path(request.url.path).suffix
            response = (
                auth.login_redirect(request)
                if accepts_html or suffix in {"", ".html"}
                else JSONResponse({"detail": "login required"}, status_code=401)
            )
            await response(scope, receive, send)
            return
        await super().__call__(scope, receive, send)

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
