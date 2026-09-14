from pathlib import Path

import pytest

from hafezi_members.app import create_app
from hafezi_members.settings import Settings


@pytest.fixture
def site(tmp_path: Path) -> Path:
    root = tmp_path / "site"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<h1>Members vault</h1>")
    (root / "notes.html").write_text("<h1>Private notes</h1>")
    (root / "drawing.excalidraw.html").write_text("<h1>Interactive drawing</h1>")
    (root / "assets" / "figure.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
    return root


@pytest.fixture
def settings(site: Path) -> Settings:
    return Settings(_env_file=None, auth="dev", site_path=str(site))


@pytest.fixture
def app(settings: Settings):
    return create_app(settings)
