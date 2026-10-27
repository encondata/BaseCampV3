"""The /learning API: the management side of the learning portal (library,
packets, assignment rules, assignments, the dashboard and compliance grid, and
more as later tasks add them), for learning managers only
(`serversherpa.learning.access.require_manager`); a person's history also
opens to `workers:view` holders over that worker.
Each area lives in its own module and is assembled here under one
router/prefix."""
from fastapi import APIRouter

from serversherpa.api.routes.learning import (
    content,
    initiatives,
    library,
    packets,
    rules,
    stats,
)

router = APIRouter(prefix="/learning", tags=["learning"])
router.include_router(library.router)
router.include_router(content.router)
router.include_router(packets.router)
router.include_router(rules.router)
router.include_router(initiatives.router)
router.include_router(stats.router)
