import uvicorn

from .app import create_app
from .settings import Settings


def main() -> None:
    settings = Settings()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)
