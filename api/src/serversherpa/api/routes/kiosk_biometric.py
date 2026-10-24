"""Kiosk biometric sign-in: a person signs in on their own phone with a
fingerprint or face instead of their password, for 30 days after each
password sign-in there.

- `POST /enroll-challenge` and `POST /enroll` (kiosk session): only a
  password session (auth_sessions.login_method, never anything the app
  reports) started in the last 10 minutes, on its own serial, on a device
  that is personal to that person. Frozen by read-only mode like any write.
- `POST /challenge` and `POST /sign-in` (no auth): the card the sign-in
  screen shows and the signed answer to it. Never frozen, like /kiosk/pair*.
  /challenge has its own per-IP cap; sign-in failures count against
  move-login's per-IP failure cap. The new session is bound to the phone.
- A shared station (Label, RFID or Time Clock station, or any kiosk with a
  station key) is never personal: no enroll, no card, no sign-in.
- `DELETE ?serial=` (kiosk session): forget the caller's own key on that
  phone. Exempt from the freeze, like forgetting a remembered browser.

Design: docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md
§Rules. Tokens, keys and revocation: services/biometric.py."""

import base64
import binascii
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from serversherpa.access.resolver import resolve_access
from serversherpa.api.deps import (
    AuthContext,
    DbSession,
    client_ip,
    rate_limit_ip,
    require_permission,
    session_started_at,
)
from serversherpa.api.routes.auth import session_response, totp_status_out
from serversherpa.api.routes.kiosk import (
    _bind_kiosk_session,
    _inet_or_none,
    _move_login_failed,
    move_login_bucket,
    move_login_capped,
)
from serversherpa.api.schemas import (
    BiometricChallengeOut,
    BiometricEnrollChallengeOut,
    BiometricEnrollIn,
    BiometricEnrollOut,
    BiometricSerialIn,
    BiometricSignInIn,
    SessionOut,
)
from serversherpa.db.models import BiometricKey, Device, Person, UserAccount
from serversherpa.security.tokens import TokenError
from serversherpa.services import auth as auth_service
from serversherpa.services import biometric
from serversherpa.services.audit import audit
from serversherpa.services.biometric import BiometricError
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from serversherpa.services.password_policy import change_reason, load_policy
from serversherpa.services.storage import presign_get
from serversherpa.wiki.share_links import IpRateLimiter

router = APIRouter(prefix="/kiosk/biometric", tags=["kiosk"])

# Per-process, per-IP (rate_limit_ip, /64 for IPv6) cap on /challenge: the
# card is fetched when the sign-in screen opens and after a failed attempt,
# and phones at one site often share an address, so the cap is generous.
CHALLENGE_IP_LIMIT = 120
CHALLENGE_WINDOW_SECONDS = 300
challenge_limiter = IpRateLimiter(limit=CHALLENGE_IP_LIMIT,
                                  window_seconds=CHALLENGE_WINDOW_SECONDS)


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _kiosk_device(db: AsyncSession, serial: str, *, lock: bool = False) -> Device | None:
    stmt = select(Device).where(Device.serial == serial, Device.device_type == "kiosk")
    return await db.scalar(stmt.with_for_update() if lock else stmt)


def _shared_station(device: Device) -> bool:
    """A shared station is never anyone's personal phone (biometric.shared_station)."""
    return biometric.shared_station(device)


async def _enrollable_device(db: AsyncSession, actor: AuthContext, serial: str, *,
                             lock: bool = False) -> Device:
    """The device `serial` when the caller may enroll a key on it now:
    a kiosk password session started in the last ENROLL_WINDOW, not locked
    to a move, on this serial (or not bound yet), on a device personal to
    the caller. Refuses with enroll_window_closed or not_personal_device."""
    session = actor.session
    started = session_started_at(session)
    if (session.client != "kiosk" or session.login_method != "password"
            or session.initiative_id is not None
            or datetime.now(UTC) - started > biometric.ENROLL_WINDOW
            or session.kiosk_serial not in (None, serial)):
        raise _err(403, "enroll_window_closed")
    device = await _kiosk_device(db, serial, lock=lock)
    if (device is None or device.personal_person_id != actor.person.id
            or _shared_station(device) or actor.person.source == KIOSK_MOVE_SOURCE):
        raise _err(403, "not_personal_device")
    return device


@router.post("/enroll-challenge", response_model=BiometricEnrollChallengeOut)
async def enroll_challenge(
    body: BiometricSerialIn, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> BiometricEnrollChallengeOut:
    await _enrollable_device(db, actor, body.serial)
    return BiometricEnrollChallengeOut(nonce=biometric.make_enroll_nonce(
        actor.person.id, actor.session.family_id, body.serial))


def _decode_chain(chain: list[str]) -> list[bytes]:
    try:
        return [base64.b64decode(c, validate=True) for c in chain]
    except (binascii.Error, ValueError):
        raise _err(422, "attestation_failed", reason="parse") from None


@router.post("/enroll", response_model=BiometricEnrollOut)
async def enroll(
    body: BiometricEnrollIn, request: Request, db: DbSession,
    actor: AuthContext = require_permission("kiosk", "view"),
) -> BiometricEnrollOut:
    # the device row, locked: two enrolls on one phone run one at a time
    device = await _enrollable_device(db, actor, body.serial, lock=True)
    try:
        nonce = biometric.decode_enroll_nonce(body.nonce)
    except TokenError:
        raise _err(401, "bad_challenge") from None
    if (nonce.person_id != actor.person.id or nonce.family_id != actor.session.family_id
            or nonce.serial != body.serial or await biometric.nonce_spent(db, nonce, device.id)):
        raise _err(401, "bad_challenge")
    chain = _decode_chain(body.chain)
    # binds an unbound session here; refused when another serial won the bind
    if not await _bind_kiosk_session(db, actor, device):
        raise _err(403, "enroll_window_closed")
    try:
        key = await biometric.enroll(
            db, person_id=actor.person.id, device=device, nonce=body.nonce,
            chain_der=chain, password_sign_in_at=session_started_at(actor.session),
            ip=client_ip(request))
    except BiometricError as exc:
        await db.rollback()
        extra = {"reason": exc.reason} if exc.reason else {}
        raise _err(exc.status, exc.code, **extra) from None
    await db.commit()
    return BiometricEnrollOut(key_id=key.id, security_level=key.security_level,
                              renews_at=biometric.renews_at(key))


@router.post("/challenge", response_model=BiometricChallengeOut)
async def challenge(
    body: BiometricSerialIn, request: Request, db: DbSession,
) -> BiometricChallengeOut:
    """The sign-in card for this phone: its personal person's live key, a
    challenge for it, their name and photo,
    and whether the 30 days have run out. Never their email. 404
    no_biometric when the phone has no such key, or is a shared station.
    An outstanding challenge is returned again, never replaced (see
    biometric.challenge_for); per-IP capped."""
    if not challenge_limiter.hit(rate_limit_ip(request)):
        raise _err(429, "biometric_rate_limited")
    device = await _kiosk_device(db, body.serial)
    if device is None or device.personal_person_id is None or _shared_station(device):
        raise _err(404, "no_biometric")
    person = await db.get(Person, device.personal_person_id)
    key = await biometric.live_key(db, device.personal_person_id, device.id)
    if key is None or person is None or person.source == KIOSK_MOVE_SOURCE:
        raise _err(404, "no_biometric")
    token = biometric.challenge_for(key)
    out = BiometricChallengeOut(
        key_id=key.id, challenge=token, display_name=person.display_name,
        photo_url=presign_get(person.avatar_key), expired=biometric.is_expired(key))
    await db.commit()
    return out


@router.post("/sign-in", response_model=SessionOut)
async def sign_in(
    body: BiometricSignInIn, request: Request, response: Response, db: DbSession,
) -> SessionOut:
    """Verify a signed challenge and mint a kiosk session, answered exactly
    as /auth/login answers a kiosk (body and ss_refresh cookie). Each
    attempt spends its challenge. Account-specific refusals come only
    after the signature proves the key."""
    raw_ip = rate_limit_ip(request)
    ip = _inet_or_none(raw_ip)
    bucket = move_login_bucket(raw_ip)
    if await move_login_capped(db, bucket):
        raise _err(429, "biometric_rate_limited")

    async def fail(code: str, status: int) -> HTTPException:
        return await _move_login_failed(db, ip, bucket, code, status=status,
                                        method="biometric", key_id=str(body.key_id))

    try:
        key_id, nonce_id = biometric.decode_sign_in_challenge(body.challenge)
    except TokenError:
        raise await fail("bad_challenge", 401) from None
    if key_id != body.key_id:
        raise await fail("bad_challenge", 401)
    key = await db.scalar(select(BiometricKey).where(BiometricKey.id == key_id)
                          .with_for_update())
    if key is None or key.revoked_at is not None:
        raise await fail("no_biometric", 404)
    if key.last_nonce is None or key.last_nonce != nonce_id:
        raise await fail("bad_challenge", 401)
    key.last_nonce = None                    # spent, whatever happens next
    try:
        signature = base64.b64decode(body.signature, validate=True)
    except (binascii.Error, ValueError):
        signature = b""
    if not biometric.signature_valid(key.public_key, body.challenge, signature):
        raise await fail("bad_signature", 401)

    device = await db.get(Device, key.device_id)
    if (device is None or device.personal_person_id != key.person_id
            or _shared_station(device)):
        raise await fail("not_personal_device", 403)
    account = await db.scalar(
        select(UserAccount).options(joinedload(UserAccount.person))
        .where(UserAccount.person_id == key.person_id))
    if account is None or account.disabled_at is not None \
            or account.person.archived_at is not None:
        raise await fail("account_disabled", 401)
    access = await resolve_access(db, account.person_id)
    if account.person.source == KIOSK_MOVE_SOURCE or not access.can("kiosk", "view"):
        raise await fail("kiosk_not_allowed", 403)
    policy = await load_policy(db)
    if change_reason(policy, account, datetime.now(UTC)) is not None:
        raise await fail("password_change_required", 403)
    if biometric.is_expired(key):
        raise await fail("biometric_expired", 403)

    key.last_used_at = datetime.now(UTC)
    result = await auth_service.start_session(
        db, account, ip=client_ip(request), user_agent=request.headers.get("user-agent"),
        audit_action="login_biometric", access=access, client="kiosk",
        login_method="biometric", kiosk_serial=device.serial)
    return session_response(result, response, await totp_status_out(db, account), policy)


@router.delete("", status_code=204)
async def forget(
    request: Request, db: DbSession,
    serial: str = Query(min_length=1, max_length=120),
    actor: AuthContext = require_permission("kiosk", "view"),
) -> None:
    """Forget the caller's own key on this phone. Always 204: nothing to
    forget is not an error, since the app drops its key either way."""
    device = await _kiosk_device(db, serial)
    if device is None:
        return
    revoked = await biometric.revoke_keys(
        db, person_id=actor.person.id, device_id=device.id, reason="forgotten",
        actor_id=actor.person.id, ip=client_ip(request))
    if revoked:
        audit(db, actor_id=actor.person.id, entity_type="device", entity_id=str(device.id),
              action="biometric_forget", changes={"serial": serial}, ip=client_ip(request))
    await db.commit()
