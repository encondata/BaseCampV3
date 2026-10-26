"""The /learning API: the management side of the learning portal (library,
and more as later tasks add them), for learning managers only
(`serversherpa.learning.access.require_manager`). Each area lives in its
own module and is assembled here under one router/prefix."""
from fastapi import APIRouter

from serversherpa.api.routes.learning import library

router = APIRouter(prefix="/learning", tags=["learning"])
router.include_router(library.router)
