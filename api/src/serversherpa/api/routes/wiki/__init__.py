"""The /wiki API: spaces, the node tree, node permission overrides,
pages, files, search, the trash, watches, comments, templates,
reviews, public share links, help links, and analytics. Each area lives
in its own module (`spaces.py`, `nodes.py`, `permissions.py`,
`pages.py`, `files.py`, `search.py`, `trash.py`, `watches.py`,
`comments.py`, `templates.py`, `reviews.py`, `share_links.py`,
`help_links.py`, `analytics.py`, `exports.py`, and more as later tasks add them) and
is assembled here under one router/prefix. `internal.py` is the live-editing server's API: same
prefix, but service-token auth instead of the wiki:view gate. `public.py`
(`/wiki/public/*`) has no auth at all: a share link's token is its only
credential."""
from fastapi import APIRouter

from serversherpa.api.routes.wiki import (
    analytics,
    comments,
    exports,
    files,
    help_links,
    internal,
    nodes,
    pages,
    permissions,
    public,
    reviews,
    search,
    share_links,
    spaces,
    templates,
    trash,
    watches,
)

router = APIRouter(prefix="/wiki", tags=["wiki"])
router.include_router(spaces.router)
router.include_router(nodes.router)
router.include_router(permissions.router)
router.include_router(pages.router)
router.include_router(files.router)
router.include_router(search.router)
router.include_router(trash.router)
router.include_router(watches.router)
router.include_router(comments.router)
router.include_router(templates.router)
router.include_router(reviews.router)
router.include_router(share_links.router)
router.include_router(help_links.router)
router.include_router(analytics.router)
router.include_router(exports.router)
router.include_router(public.router)
router.include_router(internal.router)
