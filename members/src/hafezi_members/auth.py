from __future__ import annotations

from urllib.parse import urlsplit

import httpx
from authlib.integrations.starlette_client import OAuth
from fastapi import HTTPException, Request
from starlette.responses import RedirectResponse

from .settings import Settings

GITHUB_API = "https://api.github.com"


def decide(org_membership: dict | None, team_membership: dict | None) -> tuple[bool, str]:
    if org_membership and org_membership.get("state") == "active" and org_membership.get("role") == "admin":
        return True, "owner"
    if team_membership and team_membership.get("state") == "active":
        return True, "member"
    return False, "not a member of the lab team"


async def authorize_github_user(token: str, settings: Settings) -> tuple[dict, str]:
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    async with httpx.AsyncClient(base_url=GITHUB_API, headers=headers, timeout=15) as client:
        user_response = await client.get("/user")
        user_response.raise_for_status()
        user = user_response.json()
        org = await client.get(f"/user/memberships/orgs/{settings.github_org}")
        team = await client.get(f"/orgs/{settings.github_org}/teams/{settings.github_team}/memberships/{user['login']}")
    allowed, role = decide(
        org.json() if org.status_code == 200 else None,
        team.json() if team.status_code == 200 else None,
    )
    if not allowed:
        raise HTTPException(403, f"{user.get('login')}: {role}")
    return user, role


def setup_oauth(settings: Settings) -> OAuth:
    oauth = OAuth()
    oauth.register(
        name="github",
        client_id=settings.github_client_id,
        client_secret=settings.github_client_secret,
        access_token_url="https://github.com/login/oauth/access_token",
        authorize_url="https://github.com/login/oauth/authorize",
        api_base_url=GITHUB_API + "/",
        client_kwargs={"scope": "read:org read:user"},
    )
    return oauth


def safe_next(value: str | None, default: str = "/") -> str:
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return default
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or any(ord(char) < 32 for char in value):
        return default
    return value


def login_redirect(request: Request) -> RedirectResponse:
    target = request.url.path
    if request.url.query:
        target += "?" + request.url.query
    if not target.startswith("/auth/"):
        request.session["next"] = safe_next(target)
    return RedirectResponse("/auth/login", status_code=302)


def current_user(request: Request) -> dict:
    user = request.session.get("user")
    if not user:
        raise HTTPException(401, "login required")
    return user


def require_mutation(request: Request):
    """Cookie authentication requires both a same-origin request and a session CSRF token."""
    import secrets

    current_user(request)
    expected = request.session.get("csrf", "")
    supplied = request.headers.get("x-csrf-token", "")
    origin = request.headers.get("origin")
    if origin != request.app.state.settings.base_url.rstrip("/"):
        raise HTTPException(403, "same-origin request required")
    if not expected or not secrets.compare_digest(expected, supplied):
        raise HTTPException(403, "invalid CSRF token")
