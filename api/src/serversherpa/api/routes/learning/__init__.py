"""The /learning API: the management side of the learning portal (library,
packets, assignment rules, and more as later tasks add them), for
learning managers only (`serversherpa.learning.access.require_manager`).
Each area lives in its own module and is assembled here under one
router/prefix."""
from fastapi import APIRouter

from serversherpa.api.routes.learning import library, packets, rules

router = APIRouter(prefix="/learning", tags=["learning"])
router.include_router(library.router)
router.include_router(packets.router)
router.include_router(rules.router)
