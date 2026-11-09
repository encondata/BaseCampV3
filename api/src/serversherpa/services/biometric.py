"""Biometric sign-in on a person's own kiosk phone: the enroll nonce and
sign-in challenge tokens, enroll, the 30-day anchor, and revoking keys.

A key is an EC P-256 key in the phone's secure hardware that only a strong
biometric unlocks. Enroll registers its public half after the platform
proves where it lives: Android's key attestation
(security/key_attestation.py), or on iOS App Attest
(security/app_attest.py) plus the Secure Enclave key's signature over the
nonce. App Attest is off for now (SS-521): an iOS enroll without it is
stored as "unattested" unless SS_KIOSK_IOS_REQUIRE_APP_ATTEST is set.
Sign-in signs a one-time challenge with it (SHA256withECDSA over the UTF-8
bytes of the challenge string), the same on both.

- The enroll nonce is a signed JWT (typ "bioenroll", 5 minutes) bound to the
  person, the session family and the serial. The Android app passes the
  SHA-256 of its UTF-8 bytes to `setAttestationChallenge` (KeyMint caps the
  attestation challenge at 128 bytes, and the JWT is longer); the iOS app
  binds it, with the key, into App Attest's clientDataHash
  (app_attest.client_data_hash). It is spent once any key has been enrolled
  for that person on that device since it was issued.
- The sign-in challenge is a signed JWT (typ "bio", 60 seconds) naming the
  key, with a random jti. Issuing one records its jti and issue time on the
  key row (`last_nonce`); only the recorded one is accepted. Asking again
  while it is outstanding returns the same challenge (challenge_for), so a
  stranger who knows the serial can't void it; a sign-in attempt clears it,
  so a challenge is good for one attempt.
- `password_sign_in_at` is the 30-day anchor: the password sign-in the key
  was enrolled under, moved forward when a later password session binds
  the device's serial (renew_on_password_bind). Biometric sign-ins never
  move it.

Design: docs/superpowers/specs/2026-10-23-kiosk-biometric-sign-in-design.md
(iOS: docs/superpowers/specs/2026-11-09-ios-biometric-sign-in-design.md)
"""

import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
    load_der_public_key,
)
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import BiometricKey, Device
from serversherpa.security.app_attest import (
    KIOSK_IOS_APP_ID,
    client_data_hash,
    verify_app_attest,
)
from serversherpa.security.attestation_status import load_status
from serversherpa.security.key_attestation import (
    AttestationError,
    verify_attestation,
)
from serversherpa.security.tokens import ISSUER as JWT_ISSUER
from serversherpa.security.tokens import TokenError
from serversherpa.services.audit import audit

logger = logging.getLogger(__name__)

LIFETIME = timedelta(days=30)            # from the last password sign-in
ENROLL_WINDOW = timedelta(minutes=10)    # a password session this fresh may enroll
CHALLENGE_TTL_SECONDS = 60
# /challenge hands the outstanding challenge out again while at least this
# long is left (time to run the biometric prompt); otherwise a new one
CHALLENGE_REUSE_MIN_SECONDS = 20
ENROLL_NONCE_TTL_SECONDS = 300
CHALLENGE_TYP = "bio"
ENROLL_TYP = "bioenroll"
X963_POINT_LENGTH = 65          # 04 || X || Y on P-256
APP_ATTEST_KEY_ID_LENGTH = 32   # SHA-256 of the App Attest key's point


class BiometricError(Exception):
    """A refusal with a stable code (and, for attestation, a reason)."""

    def __init__(self, status: int, code: str, reason: str | None = None):
        super().__init__(code)
        self.status = status
        self.code = code
        self.reason = reason


def _now() -> datetime:
    """The clock for the 30-day rule (tests freeze it)."""
    return datetime.now(UTC)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def renews_at(key: BiometricKey) -> datetime:
    """When the key stops working until a password sign-in renews it."""
    return _aware(key.password_sign_in_at) + LIFETIME


def is_expired(key: BiometricKey, now: datetime | None = None) -> bool:
    """30 days after the anchor the key is expired: at 30 days minus a
    second it still works, at 30 days it doesn't."""
    return (now or _now()) >= renews_at(key)


def attestation_challenge(nonce: str) -> bytes:
    """The bytes the app passes to setAttestationChallenge for `nonce`."""
    return hashlib.sha256(nonce.encode("utf-8")).digest()


# ── tokens ──────────────────────────────────────────────────────────

def _secret() -> str:
    return get_settings().jwt_secret.get_secret_value()


def _challenge_token(key_id: uuid.UUID | str, jti: str, iat: int, ttl_seconds: int) -> str:
    # HS256 over the same claims is the same token, so an outstanding
    # challenge can be handed out again from what the key row records
    return jwt.encode(
        {"iss": JWT_ISSUER, "sub": str(key_id), "jti": jti, "iat": iat,
         "exp": iat + ttl_seconds, "typ": CHALLENGE_TYP},
        _secret(), algorithm="HS256")


def _nonce_id(jti: str, iat: int) -> str:
    """What last_nonce records for a challenge: its jti and issue time."""
    return f"{jti}:{iat}"


def make_sign_in_challenge(
    key_id: uuid.UUID | str, *, ttl_seconds: int = CHALLENGE_TTL_SECONDS,
) -> tuple[str, str]:
    """A new sign-in challenge for `key_id` and its nonce id (to record as
    last_nonce)."""
    jti = secrets.token_urlsafe(16)
    iat = int(datetime.now(UTC).timestamp())
    return _challenge_token(key_id, jti, iat, ttl_seconds), _nonce_id(jti, iat)


def outstanding_challenge(key: BiometricKey) -> str | None:
    """The key's recorded challenge, re-issued, while it is unspent and has
    at least CHALLENGE_REUSE_MIN_SECONDS left to be signed in; else None."""
    jti, sep, iat_text = (key.last_nonce or "").rpartition(":")
    if not sep or not jti:
        return None
    try:
        iat = int(iat_text)
    except ValueError:
        return None
    left = iat + CHALLENGE_TTL_SECONDS - datetime.now(UTC).timestamp()
    if left < CHALLENGE_REUSE_MIN_SECONDS:
        return None
    return _challenge_token(key.id, jti, iat, CHALLENGE_TTL_SECONDS)


def challenge_for(key: BiometricKey) -> str:
    """The challenge the card shows: the outstanding one, or a new one
    recorded on the key. Asking again never voids an outstanding one, so
    knowing a phone's serial is not enough to knock its owner's card out;
    a sign-in attempt spends it. Does not commit."""
    token = outstanding_challenge(key)
    if token is None:
        token, key.last_nonce = make_sign_in_challenge(key.id)
    return token


def decode_sign_in_challenge(token: str) -> tuple[uuid.UUID, str]:
    """(key id, nonce id) of an unexpired sign-in challenge, else TokenError."""
    try:
        claims = jwt.decode(token, _secret(), algorithms=["HS256"], issuer=JWT_ISSUER,
                            options={"require": ["exp", "iat", "sub", "jti"]})
        if claims.get("typ") != CHALLENGE_TYP:
            raise TokenError("wrong token type")
        return uuid.UUID(claims["sub"]), _nonce_id(str(claims["jti"]), int(claims["iat"]))
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
    except (TypeError, ValueError) as exc:
        raise TokenError("invalid subject") from exc


@dataclass(frozen=True)
class EnrollNonce:
    person_id: uuid.UUID
    family_id: uuid.UUID
    serial: str
    issued_at: datetime


def make_enroll_nonce(person_id: uuid.UUID, family_id: uuid.UUID, serial: str) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {"iss": JWT_ISSUER, "sub": str(person_id), "fam": str(family_id), "ser": serial,
         "jti": secrets.token_urlsafe(16), "iat": now, "ts": now.timestamp(),
         "exp": now + timedelta(seconds=ENROLL_NONCE_TTL_SECONDS), "typ": ENROLL_TYP},
        _secret(), algorithm="HS256")


def decode_enroll_nonce(token: str) -> EnrollNonce:
    try:
        claims = jwt.decode(token, _secret(), algorithms=["HS256"], issuer=JWT_ISSUER,
                            options={"require": ["exp", "iat", "sub", "jti"]})
        if claims.get("typ") != ENROLL_TYP:
            raise TokenError("wrong token type")
        return EnrollNonce(
            person_id=uuid.UUID(claims["sub"]), family_id=uuid.UUID(claims["fam"]),
            serial=str(claims["ser"]),
            issued_at=datetime.fromtimestamp(float(claims["ts"]), UTC))
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
    except (KeyError, TypeError, ValueError) as exc:
        raise TokenError("malformed nonce") from exc


def signature_valid(public_key_der: bytes, challenge: str, signature: bytes) -> bool:
    """SHA256withECDSA (DER signature) over the challenge's UTF-8 bytes."""
    try:
        key = load_der_public_key(public_key_der)
        if not isinstance(key, ec.EllipticCurvePublicKey):
            return False
        key.verify(signature, challenge.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    except (InvalidSignature, ValueError, TypeError):
        return False
    return True


# ── keys ────────────────────────────────────────────────────────────

# A kiosk's platform family by sub_type (kiosk.kiosk_sub_type): a Zebra
# handheld is an Android phone. Any other sub_type is its own family.
_PLATFORM_FAMILIES = {"android": "android", "zebra": "android", "ios": "ios"}
# The enroll bodies' platforms, each named after its family.
ENROLL_PLATFORMS = frozenset({"android", "ios"})


def platform_family(sub_type: str | None) -> str | None:
    """The platform family of a kiosk sub_type: "ios", "android" (a Zebra
    too), any other sub_type itself, or None while the device's platform
    isn't known yet."""
    return _PLATFORM_FAMILIES.get(sub_type, sub_type) if sub_type is not None else None


async def clear_personal_on_platform_change(
    db: AsyncSession, device: Device, old_sub_type: str | None, *,
    actor_id: uuid.UUID | None, ip: str | None = None,
) -> bool:
    """After a check-in set `device.sub_type`: a personal device that moved to
    another platform family is no longer the phone that was assigned, so its
    live keys are revoked (reason `platform_changed`) and the assignment is
    cleared, audited as `personal_cleared` with the old and new sub_type.
    A move within a family (Android and Zebra), a first known platform and a
    non-personal device change nothing. Returns whether it cleared. Does not
    commit."""
    before = device.personal_person_id
    old, new = platform_family(old_sub_type), platform_family(device.sub_type)
    if before is None or old is None or old == new:
        return False
    await revoke_keys(db, device_id=device.id, reason="platform_changed",
                      actor_id=actor_id, ip=ip)
    device.personal_person_id = None
    device.personal_set_at = None
    device.personal_set_by = None
    audit(db, actor_id=actor_id, entity_type="device", entity_id=str(device.id),
          action="personal_cleared",
          changes={"person_id": {"from": str(before), "to": None},
                   "sub_type": {"from": old_sub_type, "to": device.sub_type},
                   "reason": "platform_changed"}, ip=ip)
    return True


def shared_station(device: Device) -> bool:
    """A Label, RFID or Time Clock station, or any kiosk holding a station
    key, is shared: it is never anyone's personal phone for biometrics,
    whatever its personal_person_id says."""
    return device.station_key_hash is not None or device.station_type is not None


async def list_live_keys(db: AsyncSession, person_id: uuid.UUID) -> list[dict]:
    """The person's live keys, newest first, as BiometricKeyOut fields (the
    user page and /auth/me). Never the public key or the nonce."""
    rows = (await db.execute(
        select(BiometricKey, Device.name)
        .join(Device, Device.id == BiometricKey.device_id)
        .where(BiometricKey.person_id == person_id, BiometricKey.revoked_at.is_(None))
        .order_by(BiometricKey.created_at.desc(), BiometricKey.id))).all()
    return [{"id": key.id, "device_id": key.device_id, "device_name": name,
             "security_level": key.security_level, "created_at": key.created_at,
             "last_used_at": key.last_used_at, "renews_at": renews_at(key)}
            for key, name in rows]


async def live_key_by_id(db: AsyncSession, person_id: uuid.UUID,
                         key_id: uuid.UUID) -> BiometricKey | None:
    """The person's live key `key_id`; None for another person's, a revoked
    or an unknown key."""
    return await db.scalar(select(BiometricKey).where(
        BiometricKey.id == key_id, BiometricKey.person_id == person_id,
        BiometricKey.revoked_at.is_(None)))


async def live_key(db: AsyncSession, person_id: uuid.UUID,
                   device_id: uuid.UUID) -> BiometricKey | None:
    return await db.scalar(select(BiometricKey).where(
        BiometricKey.person_id == person_id, BiometricKey.device_id == device_id,
        BiometricKey.revoked_at.is_(None)))


async def nonce_spent(db: AsyncSession, nonce: EnrollNonce, device_id: uuid.UUID) -> bool:
    """True once a key (live or not) was enrolled for the nonce's person on
    this device after the nonce was issued: each nonce enrolls one key."""
    return bool(await db.scalar(select(func.count()).select_from(BiometricKey).where(
        BiometricKey.person_id == nonce.person_id, BiometricKey.device_id == device_id,
        BiometricKey.created_at >= nonce.issued_at)))


async def _store_key(
    db: AsyncSession, *, person_id: uuid.UUID, device: Device, public_key_der: bytes,
    security_level: str, platform: str, password_sign_in_at: datetime,
    ip: str | None,
) -> BiometricKey:
    """Store `public_key_der` (DER SubjectPublicKeyInfo) as the person's live
    key on `device`, revoking every older live key on the device, audited as
    `biometric_enroll` with the platform and whether the key was attested
    (every level but "unattested"). Does not commit."""
    await revoke_keys(db, device_id=device.id, reason="replaced", actor_id=person_id, ip=ip)
    await db.flush()          # the old live key leaves the partial unique index first
    key = BiometricKey(
        id=uuid.uuid4(), person_id=person_id, device_id=device.id,
        public_key=public_key_der, key_alg="ES256",
        security_level=security_level, created_at=datetime.now(UTC),
        password_sign_in_at=password_sign_in_at)
    db.add(key)
    audit(db, actor_id=person_id, entity_type="biometric_key", entity_id=str(key.id),
          action="biometric_enroll",
          changes={"device_id": str(device.id), "serial": device.serial,
                   "platform": platform, "security_level": security_level,
                   "attested": security_level != "unattested"}, ip=ip)
    await db.flush()
    return key


async def enroll(
    db: AsyncSession, *, person_id: uuid.UUID, device: Device, nonce: str,
    chain_der: list[bytes], password_sign_in_at: datetime, ip: str | None = None,
) -> BiometricKey:
    """Android: verify the attestation chain and store its key as the
    person's live key on `device`, revoking every older live key on the
    device. The caller has checked the session, the device and the nonce,
    and holds the device row FOR UPDATE. Does not commit."""
    now = datetime.now(UTC)
    status = await load_status(db)
    if status is None or not status.fresh(now):
        raise BiometricError(422, "attestation_status_unavailable")
    try:
        attested = verify_attestation(
            chain_der, nonce=attestation_challenge(nonce),
            digests=set(get_settings().kiosk_signing_digests), status=status, now=now)
    except AttestationError as exc:
        # the API answers only the reason; the log keeps the detail (never
        # the chain itself) for whoever looks into a refused phone
        logger.warning("attestation refused: %s %s", exc.reason, exc.detail)
        raise BiometricError(422, "attestation_failed", reason=exc.reason) from None
    return await _store_key(
        db, person_id=person_id, device=device, public_key_der=attested.public_key_der,
        security_level=attested.security_level, platform="android",
        password_sign_in_at=password_sign_in_at, ip=ip)


def _x963_to_spki(raw: bytes) -> bytes:
    """DER SubjectPublicKeyInfo of an uncompressed P-256 point (04 || X ||
    Y), which must lie on the curve; else attestation_failed{parse}."""
    if len(raw) != X963_POINT_LENGTH or raw[0] != 0x04:
        raise BiometricError(422, "attestation_failed", reason="parse")
    try:
        key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError:
        raise BiometricError(422, "attestation_failed", reason="parse") from None
    return key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)


async def enroll_ios(
    db: AsyncSession, *, person_id: uuid.UUID, device: Device, nonce: str,
    public_key_x963: bytes, app_attest_key_id: bytes | None, attestation: bytes | None,
    proof: bytes, password_sign_in_at: datetime, ip: str | None = None,
) -> BiometricKey:
    """iOS: check the Secure Enclave key's own signature over the nonce
    (`proof`) and store the key the way `enroll` stores an Android one,
    as `secure_enclave` or `unattested`:
    - with an App Attest statement (`app_attest_key_id` and `attestation`),
      verify it first (it binds the nonce and the key through
      clientDataHash); the key is `secure_enclave`;
    - without one (both None: App Attest is off in the app until SS-521),
      the key is `unattested`, or refused as
      attestation_failed{attestation_required} when
      SS_KIOSK_IOS_REQUIRE_APP_ATTEST is set;
    - with only one of the two, attestation_failed{parse}: a sent
      attestation is never dropped.
    Google's revocation list is Android's and plays no part. The caller has
    checked the session, the device, its platform and the nonce, and holds
    the device row FOR UPDATE. Does not commit."""
    public_key_der = _x963_to_spki(public_key_x963)
    if attestation is None and app_attest_key_id is None:
        if get_settings().kiosk_ios_require_app_attest:
            logger.warning("app attest refused: no attestation and it is required")
            raise BiometricError(422, "attestation_failed", reason="attestation_required")
        security_level = "unattested"
    elif attestation is None or app_attest_key_id is None:
        raise BiometricError(422, "attestation_failed", reason="parse")
    else:
        if len(app_attest_key_id) != APP_ATTEST_KEY_ID_LENGTH:
            raise BiometricError(422, "attestation_failed", reason="parse")
        try:
            verify_app_attest(
                attestation, key_id=app_attest_key_id,
                client_data_hash=client_data_hash(nonce, public_key_x963),
                app_id=KIOSK_IOS_APP_ID,
                allow_development=get_settings().kiosk_app_attest_development)
        except AttestationError as exc:
            # as on Android: the API answers only the reason, the log keeps the
            # detail (never the attestation object itself)
            logger.warning("app attest refused: %s %s", exc.reason, exc.detail)
            raise BiometricError(422, "attestation_failed", reason=exc.reason) from None
        security_level = "secure_enclave"
    if not signature_valid(public_key_der, nonce, proof):
        logger.warning("biometric enroll refused: proof signature over the nonce does not verify")
        raise BiometricError(422, "attestation_failed", reason="proof")
    return await _store_key(
        db, person_id=person_id, device=device, public_key_der=public_key_der,
        security_level=security_level, platform="ios",
        password_sign_in_at=password_sign_in_at, ip=ip)


async def revoke_keys(
    db: AsyncSession, *, person_id: uuid.UUID | None = None,
    device_id: uuid.UUID | None = None, reason: str,
    key_id: uuid.UUID | None = None, actor_id: uuid.UUID | None = None,
    ip: str | None = None, all_keys: bool = False,
) -> int:
    """Revoke the live keys matching every filter given, each audited as
    `biometric_revoke` with `reason`. Revoking every live key (the global
    revoke-all) takes `all_keys=True`: a call with no filter and no
    all_keys raises ValueError, so a `person_id=None` passed by mistake
    can't wipe everyone's keys. Returns how many were revoked. Does not
    commit."""
    if not all_keys and person_id is None and device_id is None and key_id is None:
        raise ValueError("revoke_keys needs a person, device or key filter, or all_keys=True")
    stmt = (update(BiometricKey).where(BiometricKey.revoked_at.is_(None))
            .values(revoked_at=datetime.now(UTC), revoke_reason=reason, last_nonce=None)
            .returning(BiometricKey.id, BiometricKey.person_id, BiometricKey.device_id)
            .execution_options(synchronize_session=False))
    if person_id is not None:
        stmt = stmt.where(BiometricKey.person_id == person_id)
    if device_id is not None:
        stmt = stmt.where(BiometricKey.device_id == device_id)
    if key_id is not None:
        stmt = stmt.where(BiometricKey.id == key_id)
    rows = (await db.execute(stmt)).all()
    for row in rows:
        audit(db, actor_id=actor_id, entity_type="biometric_key", entity_id=str(row.id),
              action="biometric_revoke",
              changes={"reason": reason, "person_id": str(row.person_id),
                       "device_id": str(row.device_id)}, ip=ip)
    return len(rows)


async def renew_on_password_bind(
    db: AsyncSession, person_id: uuid.UUID, device_id: uuid.UUID,
    *, at: datetime | None = None,
) -> None:
    """A password session has just bound this device: the person's live
    key there counts its 30 days from that password sign-in (`at`, else
    now). The anchor never moves backward. Does not commit."""
    at = at or datetime.now(UTC)
    await db.execute(
        update(BiometricKey)
        .where(BiometricKey.person_id == person_id, BiometricKey.device_id == device_id,
               BiometricKey.revoked_at.is_(None),
               BiometricKey.password_sign_in_at < at)
        .values(password_sign_in_at=at)
        .execution_options(synchronize_session=False))
