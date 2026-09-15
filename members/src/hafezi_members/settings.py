from urllib.parse import urlsplit

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _is_secure_web_url(value: str) -> bool:
    parsed = urlsplit(value)
    return parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"})


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MEMBERS_", env_file="members/.env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8100
    auth: str = "github"
    session_secret: str = "dev-only-secret"
    session_max_age: int = 28800
    github_client_id: str = ""
    github_client_secret: str = ""
    github_org: str = "HafeziGroupJQI"
    github_team: str = "lab-members"
    base_url: str = "http://127.0.0.1:8100"
    public_site_url: str = "https://hafezigroupjqi.github.io"
    c2_url: str = ""
    c2_gateway_secret: str = ""
    public_site_path: str = "public"
    calendar_db: str = "members/data/calendar.sqlite"
    site_path: str = ".cache/private-site"

    @model_validator(mode="after")
    def validate_security(self):
        if self.auth not in {"github", "dev"}:
            raise ValueError("auth must be github or dev")
        if self.session_max_age < 300:
            raise ValueError("session_max_age must be at least 300 seconds")
        for name in ("base_url", "public_site_url", "c2_url"):
            if name == "c2_url" and not self.c2_url:
                continue
            if not _is_secure_web_url(getattr(self, name)):
                raise ValueError(f"{name} must use HTTPS outside localhost")
        if self.c2_gateway_secret and len(self.c2_gateway_secret) < 32:
            raise ValueError("C2 requires a gateway secret of at least 32 characters")
        if self.auth == "dev" and urlsplit(self.base_url).hostname not in {"localhost", "127.0.0.1"}:
            raise ValueError("dev authentication is restricted to localhost")
        if self.auth == "github":
            missing = [
                name
                for name, value in {
                    "github_client_id": self.github_client_id,
                    "github_client_secret": self.github_client_secret,
                }.items()
                if not value
            ]
            if missing:
                raise ValueError(f"GitHub authentication requires {', '.join(missing)}")
            if self.session_secret == "dev-only-secret" or len(self.session_secret) < 32:
                raise ValueError("GitHub authentication requires a session secret of at least 32 characters")
        return self
