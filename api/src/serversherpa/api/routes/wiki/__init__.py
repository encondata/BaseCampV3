"""The /wiki API: spaces, the node tree, pages, files, and search. Each
area lives in its own module (`spaces.py`, `nodes.py`, and more as later
tasks add them) and is assembled here under one router/prefix."""
from fastapi import APIRouter

from serversherpa.api.routes.wiki import nodes, spaces

router = APIRouter(prefix="/wiki", tags=["wiki"])
router.include_router(spaces.router)
router.include_router(nodes.router)
