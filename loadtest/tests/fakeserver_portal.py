"""The portal half of the fake BaseCamp: what PortalClient calls.

Copied from the real routes under api/src/serversherpa/api/routes/ (auth.py login,
refresh, totp/verify and /me; initiatives.py; sites.py; containers.py; trucks.py;
status_rules.py; status_values.py; system.py; scans.py raw page and asset history;
health.py) and their schemas: same paths, query parameters, field names, permission
checks (`require_permission` is a plain `perms[resource][action]` lookup) and error
codes. Everything the load test does not read is left out.

`register_portal_routes(fake)` is called from `FakeBaseCamp.__init__`. It adds the
portal-only state to the fake and registers the routes on `fake.app`. Every endpoint
is `async def` and reads time from the fake's injected clock.
"""

from __future__ import annotations

import json
import secrets
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from fastapi import Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

if TYPE_CHECKING:
    from fakeserver import FakeBaseCamp, _PortalUser

TRUST_COOKIE = "ss_trust"
TOTP_TRUST_DAYS = 7                       # settings.totp_trust_days default
ROSTER_DEFAULT_STATUS = "loaded_in_system"  # InitiativeAsset.status server default
TRUCK_STATUSES = ("created", "active", "in_transit", "at_destination", "inactive",
                  "historical")
RAW_TEXT_COLUMNS = ("primary", "scan_type", "status", "device", "operator", "site",
                    "location", "source")
RAW_DATE_COLUMNS = ("scanned", "ingested")
DASH = "—"
SPECIAL_DOMAINS = (".test", ".local", ".invalid")

# What a user with `permissions=None` holds: every (resource, action) these routes check.
PORTAL_PERMISSIONS = frozenset({
    "initiatives:view", "sites:view", "containers:view", "trucks:view", "trucks:change",
    "status_rules:view", "assets:view", "scans:view", "devtools:view",
    "initiatives:add", "initiatives:change", "containers:add", "trucks:add",
})


class LoginIn(BaseModel):
    email: str
    password: str
    client: Literal["portal", "kiosk"] = "portal"

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        """The real field is an EmailStr: it refuses special-use domains (422), so a
        test address must not end in one."""
        local, at, domain = v.rpartition("@")
        if not (local and at and "." in domain) or domain.lower().endswith(SPECIAL_DOMAINS):
            raise ValueError("not a deliverable email address")
        return v


class TotpVerifyIn(BaseModel):
    code: str = Field(min_length=6, max_length=16)
    remember: bool = False


class TruckUpdateIn(BaseModel):
    name: str | None = None
    driver_name: str | None = None
    co_driver_name: str | None = None
    load_number: str | None = None
    seal_id: str | None = None
    team_drive: bool | None = None
    contact_info: str | None = None
    status: str | None = None
    tracking_type: dict | None = None
    initiative_id: uuid.UUID | None = None
    start_site_id: uuid.UUID | None = None
    end_site_id: uuid.UUID | None = None
    container_ids: list[uuid.UUID] | None = None
    model_config = ConfigDict(extra="forbid")


class TruckUpdateCreateIn(BaseModel):
    location: str | dict
    approximate_address: str = ""
    recorded_at: datetime | None = None
    source: str = "manual"
    model_config = ConfigDict(extra="forbid")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def parse_location(value: str | dict) -> tuple[float, float]:
    """trucks/location.py: {lat, lng} or "lat, lng", both in range."""
    if isinstance(value, dict):
        try:
            lat, lng = float(value["lat"]), float(value["lng"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("expected {lat, lng}") from None
    else:
        parts = [p.strip() for p in str(value).split(",")]
        if len(parts) != 2:
            raise ValueError('expected "lat, lng"')
        lat, lng = float(parts[0]), float(parts[1])
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise ValueError("out of range")
    return lat, lng


def format_location(lat: float, lng: float) -> str:
    return f"{lat:.6f}, {lng:.6f}"


def _default_rules(statuses: dict[str, str]) -> list[dict]:
    """One enabled asset rule per checkpoint, like a fully set-up server."""
    return [{"id": str(uuid.uuid4()), "name": f"Set {label}", "description": "",
             "trigger_status": key, "trigger_match_type": "asset", "priority": 10,
             "enabled": True, "conditions": [],
             "actions": [{"action_type": "set_asset_status", "params": {"status": key}}],
             "names": {}} for key, label in statuses.items()]


def register_portal_routes(fake: FakeBaseCamp) -> None:
    from fakeserver import ASSET_STATUSES, _Family
    from fakeserver_setup import register_setup_routes

    # ── portal state (tests change these directly) ──
    fake.status_rules = _default_rules(ASSET_STATUSES)
    fake.inactive_asset_statuses = set()
    fake.truck_updates = []                  # rows of POST /trucks/{id}/updates
    fake.read_only = False
    fake.background = {"state": "running", "running": 2, "total": 2}  # None = no workers
    fake.totp_verifications = []             # {"challenge_header": bool, "remember": bool}
    trust: dict[str, tuple[str, float]] = {}       # ss_trust token -> (email, expires)
    challenges: dict[str, tuple[str, str]] = {}    # challenge token -> (email, purpose)
    app = fake.app
    now = fake.clock.now

    def perms_of(user: _PortalUser) -> dict[str, dict[str, bool]]:
        held = PORTAL_PERMISSIONS if user.permissions is None else user.permissions
        out: dict[str, dict[str, bool]] = {}
        for item in held:
            resource, _, action = item.partition(":")
            out.setdefault(resource, {})[action] = True
        return out

    def user_of(person_id: str) -> _PortalUser | None:
        return next((u for u in fake.portal_users.values() if u.person_id == person_id), None)

    def portal_user(request: Request) -> _PortalUser:
        actor = fake._actor(request)
        user = user_of(actor.person_id)
        if actor.family.client != "portal" or user is None:
            raise _err(403, "kiosk_session")
        return user

    def require(request: Request, resource: str, action: str) -> _PortalUser:
        user = portal_user(request)
        if not perms_of(user).get(resource, {}).get(action, False):
            raise _err(403, "forbidden")
        return user

    fake.perms_of, fake.require = perms_of, require

    def session(user: _PortalUser, response: Response) -> dict:
        family = _Family(id=str(uuid.uuid4()), person_id=user.person_id, client="portal",
                         initiative_id=None, expires_at=now() + fake.session_seconds)
        body = fake._issue(family, response)
        body.update(person={"id": user.person_id, "display_name": user.email},
                    roles=["super_admin"], perms=perms_of(user), max_rank=user.rank,
                    scope={"global": True, "client_ids": [], "partner_ids": [],
                           "restricted_client_ids": []},
                    totp={"enrolled": user.totp == "verify", "enrolled_at": None,
                          "required": user.totp is not None, "backup_codes_remaining": 10},
                    kiosk_move=None)
        return body

    # ── /auth ──

    @app.post("/auth/login")
    async def login(body: LoginIn, request: Request, response: Response) -> dict:
        user = fake.portal_users.get(body.email.lower())
        if user is None or user.password != body.password:
            raise _err(401, "invalid_credentials")
        if body.client == "portal" and user.totp is not None:
            held = trust.get(request.cookies.get(TRUST_COOKIE) or "")
            trusted = held is not None and held[0] == user.email.lower() and held[1] > now()
            if user.totp == "enroll" or not trusted:
                token = secrets.token_urlsafe(24)
                challenges[token] = (user.email.lower(), user.totp)
                return {"status": "totp_verify" if user.totp == "verify" else "totp_enroll",
                        "challenge_token": token,
                        "backup_codes_remaining": 10 if user.totp == "verify" else None}
        return session(user, response)

    @app.post("/auth/totp/verify")
    async def totp_verify(body: TotpVerifyIn, response: Response,
                          x_totp_challenge: str | None = Header(default=None)) -> dict:
        fake.totp_verifications.append({"challenge_header": x_totp_challenge is not None,
                                        "remember": body.remember})
        if not x_totp_challenge:
            raise _err(401, "missing_token")
        held = challenges.get(x_totp_challenge)
        if held is None or held[1] != "verify":
            raise _err(401, "invalid_challenge")
        user = fake.portal_users[held[0]]
        if body.code != user.code:
            raise _err(401, "totp_invalid")
        out = session(user, response)
        if body.remember:
            token = secrets.token_urlsafe(24)
            trust[token] = (held[0], now() + TOTP_TRUST_DAYS * 86400)
            response.set_cookie(TRUST_COOKIE, token, max_age=TOTP_TRUST_DAYS * 86400,
                                httponly=True, samesite="lax", path="/auth")
        return out

    @app.get("/auth/me")
    async def me(request: Request) -> dict:
        user = portal_user(request)
        family = fake._actor(request).family
        return {"person": {"id": user.person_id, "display_name": user.email},
                "roles": ["super_admin"], "session_expires_at": fake._iso(family.expires_at),
                "must_change_password": False, "must_change_reason": None,
                "password_expires_at": None, "preferences": {}, "perms": perms_of(user),
                "max_rank": user.rank,
                "scope": {"global": True, "client_ids": [], "partner_ids": [],
                          "restricted_client_ids": []},
                "password_min_length": 8,
                "totp": {"enrolled": user.totp == "verify", "enrolled_at": None,
                         "required": user.totp is not None, "backup_codes_remaining": 10},
                "kiosk_move": None}

    # ── initiatives and sites ──

    def site_name(site_id: str | None) -> str | None:
        return fake.sites[site_id]["name"] if site_id in fake.sites else None

    def initiative_item(m: dict) -> dict:
        return {"id": m["id"], "name": m["name"], "initiative_type": m["initiative_type"],
                "type_label": m["initiative_type"].title(), "type_color": "#51606f",
                "status": m["status"], "status_label": m["status"].replace("_", " ").title(),
                "status_color": "#51606f",
                "origin_site_id": m["origin_site_id"],
                "origin_site_name": site_name(m["origin_site_id"]),
                "destination_site_id": m["destination_site_id"],
                "destination_site_name": site_name(m["destination_site_id"]),
                "archived_at": m.get("archived_at"), "created_at": fake._iso(now())}

    def initiative(initiative_id: uuid.UUID) -> dict:
        move = fake.moves.get(str(initiative_id))
        if move is None:
            raise _err(404, "initiative_not_found")
        return move

    fake.initiative, fake.initiative_item = initiative, initiative_item

    def move_status(asset: dict) -> str:
        return asset["asset_status"] or ROSTER_DEFAULT_STATUS

    @app.get("/initiatives")
    async def list_initiatives(request: Request) -> list[dict]:
        require(request, "initiatives", "view")
        return [initiative_item(m) for m in reversed(list(fake.moves.values()))]

    @app.get("/initiatives/{initiative_id}")
    async def get_initiative(initiative_id: uuid.UUID, request: Request) -> dict:
        require(request, "initiatives", "view")
        return {**initiative_item(initiative(initiative_id)), "people": [],
                "links_children": [], "links_parents": []}

    @app.get("/initiatives/{initiative_id}/assets")
    async def initiative_assets(initiative_id: uuid.UUID, request: Request) -> list[dict]:
        require(request, "initiatives", "view")
        move = initiative(initiative_id)
        rows = []
        for a in fake.assets.values():
            if a["initiative_id"] != move["id"]:
                continue
            container_id = fake.container_of.get(a["id"])
            truck_id = fake.truck_of.get(container_id) if container_id else None
            rows.append({
                "id": str(uuid.uuid5(uuid.NAMESPACE_URL, a["id"])), "asset_id": a["id"],
                "status": move_status(a), "status_label": move_status(a),
                "status_color": "#51606f",
                "asset": {"id": a["id"], "legacy_id": a["legacy_id"],
                          "serial_number": a["serial_number"], "name": a["name"],
                          "rfid_tag": a["rfid_tag"], "status": move_status(a),
                          "status_label": move_status(a), "status_color": "#51606f",
                          "container_id": container_id, "truck_id": truck_id},
            })
        return rows

    @app.get("/initiatives/{initiative_id}/asset-totals")
    async def asset_totals(initiative_id: uuid.UUID, request: Request) -> dict:
        require(request, "initiatives", "view")
        move = initiative(initiative_id)
        counts: dict[str, int] = {}
        for a in fake.assets.values():
            if a["initiative_id"] == move["id"]:
                counts[move_status(a)] = counts.get(move_status(a), 0) + 1
        return {"total": sum(counts.values()), "by_status": counts}

    @app.get("/sites/{site_id}")
    async def get_site(site_id: uuid.UUID, request: Request) -> dict:
        require(request, "sites", "view")
        site = fake.sites.get(str(site_id))
        if site is None:
            raise _err(404, "site_not_found")
        return {"id": site["id"], "name": site["name"], "status": "active",
                "status_label": "Active", "status_color": "#51606f", "country": "US",
                "latitude": site["latitude"], "longitude": site["longitude"]}

    # ── containers and trucks ──

    @app.get("/containers")
    async def list_containers(request: Request,
                              initiative_id: uuid.UUID | None = None) -> list[dict]:
        require(request, "containers", "view")
        return [{"id": c["id"], "name": c["name"], "status": c["status"],
                 "status_label": c["status"].title(), "status_color": "#51606f",
                 "site_id": c["site_id"], "site_name": site_name(c["site_id"]),
                 "initiative_id": c["initiative_id"], "location_detail": "",
                 "asset_count": fake._asset_count(c["id"]),
                 "archived_at": c.get("archived_at"),
                 "created_at": fake._iso(now())}
                for c in fake.containers.values()
                if initiative_id is None or c["initiative_id"] == str(initiative_id)]

    def truck_item(t: dict) -> dict:
        return {"id": t["id"], "name": t["name"], "status": t["status"],
                "status_label": t["status"].replace("_", " ").title(),
                "status_color": "#51606f", "initiative_id": t["initiative_id"],
                "start_site_id": t["start_site_id"],
                "start_site_name": site_name(t["start_site_id"]),
                "end_site_id": t["end_site_id"], "end_site_name": site_name(t["end_site_id"]),
                "container_count": fake._container_count(t["id"]), "archived_at": None,
                "created_at": fake._iso(now()), "updated_at": fake._iso(now())}

    def truck(truck_id: uuid.UUID) -> dict:
        found = fake.trucks.get(str(truck_id))
        if found is None:
            raise _err(404, "truck_not_found")
        return found

    def truck_detail(t: dict) -> dict:
        crates = [fake.containers[c] for c, on in fake.truck_of.items() if on == t["id"]]
        return {**truck_item(t), "containers": [
            {"id": c["id"], "name": c["name"], "status": c["status"],
             "status_label": c["status"].title(), "status_color": "#51606f",
             "asset_count": fake._asset_count(c["id"])} for c in crates]}

    @app.get("/trucks")
    async def list_trucks(request: Request,
                          initiative_id: uuid.UUID | None = None) -> list[dict]:
        require(request, "trucks", "view")
        return [truck_item(t) for t in fake.trucks.values()
                if initiative_id is None or t["initiative_id"] == str(initiative_id)]

    @app.get("/trucks/{truck_id}")
    async def get_truck(truck_id: uuid.UUID, request: Request) -> dict:
        require(request, "trucks", "view")
        return truck_detail(truck(truck_id))

    @app.patch("/trucks/{truck_id}")
    async def update_truck(truck_id: uuid.UUID, body: TruckUpdateIn, request: Request) -> dict:
        require(request, "trucks", "change")
        t = truck(truck_id)
        if body.status is not None:
            if body.status not in TRUCK_STATUSES:
                raise _err(422, "unknown_status")
            t["status"] = body.status
        return truck_detail(t)

    @app.post("/trucks/{truck_id}/updates", status_code=201)
    async def create_truck_update(truck_id: uuid.UUID, body: TruckUpdateCreateIn,
                                  request: Request) -> dict:
        require(request, "trucks", "change")
        truck(truck_id)
        try:
            lat, lng = parse_location(body.location)
        except ValueError:
            raise _err(422, "invalid_location") from None
        row = {"id": str(uuid.uuid4()), "truck_id": str(truck_id),
               "recorded_at": (body.recorded_at.isoformat() if body.recorded_at
                               else fake._iso(now())),
               "location": format_location(lat, lng), "lat": lat, "lng": lng,
               "approximate_address": body.approximate_address, "source": body.source}
        fake.truck_updates.append(row)
        return row

    @app.get("/trucks/{truck_id}/updates")
    async def list_truck_updates(truck_id: uuid.UUID, request: Request) -> list[dict]:
        require(request, "trucks", "view")
        truck(truck_id)
        rows = [u for u in fake.truck_updates if u["truck_id"] == str(truck_id)]
        return sorted(rows, key=lambda u: u["recorded_at"], reverse=True)

    # ── status rules, status values, system status ──

    @app.get("/status-rules")
    async def list_rules(request: Request) -> list[dict]:
        require(request, "status_rules", "view")
        stamp = fake._iso(now())
        return [{**r, "created_at": stamp, "updated_at": stamp} for r in fake.status_rules]

    @app.get("/status-values")
    async def list_status_values(request: Request, record_type: str | None = None) -> list:
        user = portal_user(request)
        if record_type is None:
            raise _err(403, "forbidden")      # the unfiltered listing is developer-only
        if record_type != "asset":
            raise _err(422, "unknown_record_type")
        if not perms_of(user).get("assets", {}).get("view", False):
            raise _err(403, "forbidden")
        return [{"record_type": "asset", "key": key, "label": label, "description": "",
                 "color": "#51606f", "sort_order": i, "is_active": True,
                 "progress_weight": None, "usage_count": None}
                for i, (key, label) in enumerate(ASSET_STATUSES.items())
                if key not in fake.inactive_asset_statuses]

    @app.get("/system/status")
    async def system_status() -> dict:
        return {"read_only": fake.read_only, "read_only_message": "",
                "workers_paused": False, "banner": None, "totp_trust_days": TOTP_TRUST_DAYS,
                "email_enabled": False, "push_enabled": False,
                "password_reset_ttl_minutes": 15, "password_min_length": 8,
                "background": fake.background,
                "apps": {"wiki": True, "kiosk": True, "learn": True, "devices": True}}

    # ── scans ──

    def raw_filters(raw: str | None) -> dict[str, dict]:
        """scans/raw_query.parse_filters: {colKey: {text?, values?, exclude?}}."""
        if raw is None or raw.strip() == "":
            return {}
        try:
            data = json.loads(raw)
        except ValueError:
            raise _err(422, "invalid_filters") from None
        if not isinstance(data, dict):
            raise _err(422, "invalid_filters")
        for key, spec in data.items():
            if (key not in RAW_TEXT_COLUMNS + RAW_DATE_COLUMNS or not isinstance(spec, dict)
                    or set(spec) - {"text", "values", "exclude"}):
                raise _err(422, "invalid_filters")
        return {k: v for k, v in data.items() if k in RAW_TEXT_COLUMNS}

    def raw_matches(row: dict, filters: dict[str, dict]) -> bool:
        """Only the device column is wired up: a case-insensitive contains on the
        displayed text (the real `icontains(text, autoescape=True)`)."""
        for key, spec in filters.items():
            if key != "device":
                raise _err(422, "invalid_filters")   # not modelled by the fake
            shown = row["device_id"] or DASH
            if spec.get("text") and spec["text"].lower() not in shown.lower():
                return False
            if spec.get("values") and shown not in spec["values"]:
                return False
            if spec.get("exclude") and shown in spec["exclude"]:
                return False
        return True

    @app.get("/scans/raw/page")
    async def page_raw_scans(request: Request, limit: int = Query(100, ge=1, le=500),
                             q: str = "", filters: str | None = None,
                             sort: str = "scanned",
                             direction: Literal["asc", "desc"] = Query("desc", alias="dir"),
                             cursor: str | None = None) -> dict:
        require(request, "scans", "view")
        wanted = raw_filters(filters)
        rows = [r for r in fake.raw_scans if raw_matches(r, wanted)]
        rows.sort(key=lambda r: (r["scanned_at"], r["id"]), reverse=direction == "desc")
        return {"rows": [{"id": r["id"], "scanned_value": r["scanned_value"],
                          "scan_type": r["scan_type"], "status": r["status"],
                          "scanned_at": r["scanned_at"], "device_id": r["device_id"],
                          "site_id": r["site_id"], "source": r["source"]}
                         for r in rows[:limit]],
                "next_cursor": None, "total": len(rows)}

    @app.get("/scans/asset/{asset_id}")
    async def asset_scans(asset_id: uuid.UUID, request: Request,
                          limit: int | None = Query(None, ge=1, le=500)) -> list[dict]:
        require(request, "scans", "view")
        rows = [s for s in fake.processed_scans if s["asset_id"] == str(asset_id)]
        rows.sort(key=lambda s: s["scanned_at"], reverse=True)
        return [{"id": str(uuid.uuid5(uuid.NAMESPACE_URL, str(s["id"]))),
                 "processed_at": s["processed_at"], "scanned_value": s["scanned_value"],
                 "scan_type": s["scan_type"], "status": s["status"],
                 "scanned_at": s["scanned_at"], "device_id": s["device_id"],
                 "operator_id": s["operator_id"], "site_id": s["site_id"],
                 "source": s["source"], "off_move": s["off_move"]}
                for s in rows[:limit or 100]]

    # ── Developer › Database › Health ──

    @app.get("/devtools/health/summary")
    async def health_summary(request: Request) -> dict:
        require(request, "devtools", "view")
        return {"database_size_bytes": 1 << 28, "version": "PostgreSQL 17",
                "started_at": fake._iso(now() - 86400), "latency_ms": 0.4,
                "connections": 12, "max_connections": 100, "cache_hit_ratio": 0.99}

    @app.get("/devtools/health/connections")
    async def health_connections(request: Request) -> dict[str, Any]:
        require(request, "devtools", "view")
        return {"groups": [{"application_name": "serversherpa-api", "state": "idle",
                            "count": 10, "oldest_query_seconds": None,
                            "oldest_transaction_seconds": None, "waiting_on_lock": 0}]}

    register_setup_routes(fake)
