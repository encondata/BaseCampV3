"""The /wiki API: spaces, the node tree, pages, files, and search. Each
area lives in its own module (`spaces.py`, `nodes.py`, `pages.py`, and
more as later tasks add them) and is assembled here under one
router/prefix. `internal.py` is the live-editing server's API: same
prefix, but service-token auth instead of the wiki:view gate."""
from fastapi import APIRouter

from serversherpa.api.routes.wiki import internal, nodes, pages, spaces

router = APIRouter(prefix="/wiki", tags=["wiki"])
router.include_router(spaces.router)
router.include_router(nodes.router)
router.include_router(pages.router)
router.include_router(internal.router)
