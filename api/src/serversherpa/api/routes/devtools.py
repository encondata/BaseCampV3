"""God mode — reveals the developer nav section.

This is a VISIBILITY toggle, not a permission. The server enforces the
`devtools` permission on every request regardless of god-mode state, so
guessing a word grants nothing: a non-developer who types the correct word
gets the same 404 as someone typing gibberish. That property is why this
needs no rate limiting — there is nothing behind the door to force.

The words live in SS_GOD_MODE_WORDS (server-side). A VITE_* equivalent
would be inlined into the portal bundle and readable from devtools.
"""

import secrets

from fastapi import APIRouter, HTTPException

from serversherpa.api.deps import CurrentUser, DbSession
from serversherpa.api.schemas import GodModeIn
from serversherpa.config import get_settings
from serversherpa.services.audit import audit

router = APIRouter(prefix="/devtools", tags=["devtools"])

# One refusal for every reason — wrong word, right word from a non-developer,
# feature unconfigured. Any variance between them is the leak this avoids.
_REFUSED = HTTPException(status_code=404, detail={"code": "not_found"})


def _word_matches(candidate: str) -> bool:
    raw = get_settings().god_mode_words.get_secret_value()
    words = [w.strip() for w in raw.split(",") if w.strip()]
    # Matching is case-insensitive: these are typed by hand into the palette,
    # and case carries no defensive value here (guessing grants nothing — see
    # the module docstring).
    #
    # Compare BYTES, not str: secrets.compare_digest raises TypeError on
    # non-ASCII str, so a palette query like "café" would 500 — which both
    # errors and breaks the identical-refusal property a 500 is distinguishable
    # from a 404. Encoding sidesteps it for any input.
    probe = candidate.casefold().encode("utf-8")
    # `any()` short-circuits, but the timing tells an attacker nothing usable.
    return any(secrets.compare_digest(probe, w.casefold().encode("utf-8"))
               for w in words)


@router.post("/unlock", include_in_schema=False)
async def unlock(body: GodModeIn, user: CurrentUser, db: DbSession) -> dict:
    # Order is deliberate: Python short-circuits `or`, so a wrong word never
    # even reaches the permission check. That's safe to skip because
    # `user.access.can(...)` is a pre-resolved in-memory dict lookup, not a
    # DB call or anything else with a measurable cost — there's no timing
    # signal for an attacker to learn from which branch short-circuited.
    if not _word_matches(body.word) or not user.access.can("devtools", "view"):
        raise _REFUSED
    audit(db, actor_id=user.person.id, entity_type="auth",
          entity_id=str(user.person.id), action="godmode.enable")
    await db.commit()
    return {"nav_color": get_settings().god_mode_nav_color}
