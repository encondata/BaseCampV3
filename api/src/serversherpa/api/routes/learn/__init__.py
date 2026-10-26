"""The /learn API: the worker side of the learning portal (sign-in now,
training and signing as later tasks add them). Callers are workers with a
learn session or a signed-in account (`serversherpa.learning.sessions
.LearnActor`), never managers acting on others. Each area lives in its own
module and is assembled here under one router/prefix."""
from fastapi import APIRouter

from serversherpa.api.routes.learn import auth

router = APIRouter(prefix="/learn", tags=["learn"])
router.include_router(auth.router)
