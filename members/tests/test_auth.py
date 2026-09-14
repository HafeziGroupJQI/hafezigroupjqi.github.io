import pytest
from pydantic import ValidationError

from hafezi_members.auth import decide, safe_next
from hafezi_members.settings import Settings


def test_team_authorization():
    assert decide({"state": "active", "role": "admin"}, None) == (True, "owner")
    assert decide(None, {"state": "active"}) == (True, "member")
    assert decide({"state": "active", "role": "member"}, {"state": "pending"})[0] is False


def test_redirect_target_stays_local():
    assert safe_next("/journal-club/?page=2") == "/journal-club/?page=2"
    for unsafe in ("https://attacker.example", "//attacker.example", "/\\attacker.example", ""):
        assert safe_next(unsafe) == "/"


def test_github_auth_requires_credentials():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, auth="github")


def test_remote_services_require_https():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, auth="dev", c2_url="http://instruments.example.edu")
