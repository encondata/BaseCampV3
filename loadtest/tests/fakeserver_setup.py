"""The fake's Bulk Actions > Create a move in steps, its site list and the move PATCH.

Copied from the real code: api/routes/move_setup.py (routes, `_guard`, `_draft`,
`_require_editable`), imports/move_setup.py (the draft payload, `draft_problems`,
`apply_job` in one go), imports/naming.py (conventions, CRATE_MAX, TRUCK_MAX),
logistics/bulk_create.py (`check_tags`, `check_vocab`, clashes), imports/parsing.py
(MAX_BYTES, `missing_serial_column`), routes/sites.py (the list), routes/initiatives.py
(PATCH) and services/move_password.py (`set_password`). Same paths, status codes,
error codes and job statuses; only the fields the load test sends are modelled.

The import worker is `fake.process_jobs()`, called like `process_scans`: one call
takes a queued From-To check to `completed` (or `failed`), a queued create to
`running`, and a running create to `completed` (or `failed`).
"""

from __future__ import annotations

import csv
import io
import re
import uuid
from email.parser import BytesParser
from email.policy import HTTP
from typing import TYPE_CHECKING, Literal

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from fakeserver import FakeBaseCamp

GATE_BYPASS_RANK = 60                     # access/defaults.py
CRATE_MAX, TRUCK_MAX = 500, 100           # imports/naming.py
MAX_BYTES = 20 * 1024 * 1024              # imports/parsing.py
IMPORT_EXTENSIONS = (".csv", ".xlsx", ".xls")
MAKE_MODEL_MODES = ("fuzzy", "force", "hybrid")
EDITABLE = ("preview", "failed")
CONTAINER_TYPES = ("pelican_case", "shipping_container", "cart")    # migration 0015
LABEL_TAG_KEYS = ("priority", "vendor", "accessories", "ewaste", "warehouse")
INITIATIVE_STATUSES = ("planned", "scheduled", "in_progress", "on_hold", "completed",
                       "cancelled")
NON_NULLABLE_FIELDS = ("name", "status")
PASSWORD_MIN_LENGTH = 8                   # services/move_password.py MIN_LENGTH
SERIAL_HEADERS = ("serial number", "serial", "serial_number")
X_RUN = re.compile(r"[xX]+")
_CHUNKS = re.compile(r"(\d+)")


class MoveSetupMoveIn(BaseModel):
    name: str
    initiative_type: str = "move"
    origin_site_id: uuid.UUID | None = None
    destination_site_id: uuid.UUID | None = None
    model_config = ConfigDict(extra="forbid")


class MoveSetupCratesIn(BaseModel):
    convention: str = Field(max_length=60)
    count: int
    start: int = 1
    container_type: str | None = None
    tags: dict[str, int] = {}
    model_config = ConfigDict(extra="forbid")


class MoveSetupTrucksIn(BaseModel):
    convention: str = Field(max_length=60)
    count: int
    start: int = 1
    model_config = ConfigDict(extra="forbid")


class MoveSetupPatchIn(BaseModel):
    move: MoveSetupMoveIn | None = None
    crates: MoveSetupCratesIn | None = None
    trucks: MoveSetupTrucksIn | None = None
    skip: list[Literal["assets", "crates", "trucks"]] = []
    model_config = ConfigDict(extra="forbid")


class InitiativeUpdateIn(BaseModel):
    name: str | None = None
    status: str | None = None
    kiosk_password: str | None = Field(default=None, max_length=200)
    model_config = ConfigDict(extra="forbid")


class NamingError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def natural_key(text: str | None) -> list:
    return [int(t) if i % 2 else t.casefold() for i, t in enumerate(_CHUNKS.split(text or ""))]


def generate_names(convention: str, count: int, start: int, *, max_count: int) -> list[str]:
    value = (convention or "").strip()
    if not value:
        raise NamingError("Enter a naming convention, like CRT-xxx.")
    runs = list(X_RUN.finditer(value))
    if not runs:
        raise NamingError("Mark the number with a run of x's, like CRT-xxx.")
    if len(runs) > 1:
        raise NamingError("Use only one run of x's for the number.")
    run = runs[0]
    if count < 0 or count > max_count:
        raise NamingError(f"The count must be between 0 and {max_count}.")
    if start < 0:
        raise NamingError("The start number can't be below 0.")
    width = run.end() - run.start()
    return [f"{value[:run.start()]}{str(start + i).zfill(width)}{value[run.end():]}"
            for i in range(count)]


def read_form(content_type: str, body: bytes) -> dict[str, tuple[str | None, bytes]]:
    """multipart/form-data -> {field: (filename, bytes)}, with the standard library (the
    real server uses python-multipart; this tool does not depend on it)."""
    if not content_type.lower().startswith("multipart/form-data"):
        return {}
    message = BytesParser(policy=HTTP).parsebytes(
        b"Content-Type: " + content_type.encode("latin-1") + b"\r\n\r\n" + body)
    out: dict[str, tuple[str | None, bytes]] = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            out[name] = (part.get_filename(), part.get_payload(decode=True) or b"")
    return out


def clash_sentence(noun: str, names: list[str], limit: int = 10) -> str:
    shown = ", ".join(names[:limit])
    more = f", and {len(names) - limit} more" if len(names) > limit else ""
    return f"These {noun} names already exist: {shown}{more}."


def register_setup_routes(fake: FakeBaseCamp) -> None:
    from fakeserver_portal import _err

    fake.import_jobs = {}                    # id -> a draft (move_setup) or a check job
    app = fake.app
    now = fake.clock.now

    # ── helpers ──

    def guard(request: Request):
        """require_permission("initiatives", "add"), then _guard."""
        user = fake.require(request, "initiatives", "add")
        perms = fake.perms_of(user)
        if user.rank < GATE_BYPASS_RANK:
            raise _err(403, "forbidden")
        if not (perms.get("containers", {}).get("add") and perms.get("trucks", {}).get("add")):
            raise _err(403, "forbidden")
        return user

    def draft(draft_id: uuid.UUID, user) -> dict:
        job = fake.import_jobs.get(str(draft_id))
        if job is None or job["kind"] != "move_setup" or job["created_by"] != user.person_id:
            raise _err(404, "draft_not_found")
        return job

    def editable(job: dict) -> None:
        if job["status"] not in EDITABLE:
            raise _err(409, "draft_not_editable")

    def reopen(job: dict) -> None:
        job.update(status="preview", error=None, results=None)

    def check_of(job: dict) -> dict | None:
        assets = (job["payload"] or {}).get("assets")
        return fake.import_jobs.get(assets["check_job_id"]) if assets else None

    def move_data(body: MoveSetupMoveIn) -> dict:
        if not body.name.strip():
            raise _err(422, "name_required")
        if body.origin_site_id is None:
            raise _err(422, "origin_required")
        if body.destination_site_id is None:
            raise _err(422, "destination_required")
        for field in ("origin_site_id", "destination_site_id"):
            if str(getattr(body, field)) not in fake.sites:
                raise _err(422, "site_not_found", field=field)
        stored = body.model_dump(mode="json", exclude_none=True)
        stored.update(initiative_type="move", name=body.name.strip())
        return stored

    def crate_clashes(names: list[str]) -> list[str]:
        taken = {c["name"].lower() for c in fake.containers.values()
                 if c.get("archived_at") is None}
        return [n for n in names if n.lower() in taken]

    def truck_clashes(names: list[str]) -> list[str]:
        taken = {t["name"].lower() for t in fake.trucks.values()}
        return [n for n in names if n.lower() in taken]

    def names_preview(section: dict | None, kind: str) -> dict | None:
        if section is None:
            return None
        try:
            names = generate_names(section["convention"], section["count"], section["start"],
                                   max_count=CRATE_MAX if kind == "crates" else TRUCK_MAX)
        except NamingError as exc:
            return {"names": [], "clashes": [], "error": exc.message}
        finder = crate_clashes if kind == "crates" else truck_clashes
        return {"names": names, "clashes": finder(names), "error": None}

    def draft_out(job: dict, *, with_previews: bool = False) -> dict:
        payload = job["payload"]
        return {"id": job["id"], "status": job["status"], "error": job["error"],
                "payload": payload, "initiative_id": job["initiative_id"],
                "total_rows": job["total_rows"], "processed_rows": job["processed_rows"],
                "results": job["results"], "created_at": fake._iso(job["created_at"]),
                "previews": ({"crates": names_preview(payload.get("crates"), "crates"),
                              "trucks": names_preview(payload.get("trucks"), "trucks")}
                             if with_previews and payload else None)}

    def check_out(check: dict) -> dict:
        summary = (check["results"] or {}).get("summary") or {}
        return {"id": check["id"], "initiative_id": None, "kind": "move_assets",
                "filename": check["filename"], "options": check["options"],
                "phase": "validate", "status": check["status"],
                "total_rows": check["total_rows"], "processed_rows": check["total_rows"]
                if check["status"] == "completed" else 0,
                "created_count": summary.get("created", 0), "updated_count": 0,
                "error_count": summary.get("errors", 0), "results": check["results"],
                "error": check["error"], "created_at": fake._iso(check["created_at"]),
                "started_at": None, "finished_at": None}

    def draft_problems(payload: dict) -> list[str]:
        out: list[str] = []
        move = payload.get("move") or {}
        if not all(move.get(f) in fake.sites for f in ("origin_site_id", "destination_site_id")):
            out.append("A site on the first step no longer exists. Pick another.")
        if payload.get("assets") is not None:
            check = fake.import_jobs.get(payload["assets"]["check_job_id"])
            if check is None:
                out.append("The From-To file check is missing. Upload the file again, "
                           "or skip the asset step.")
            elif check["status"] in ("queued", "running"):
                out.append("The From-To file is still being checked. Wait for it to finish, "
                           "then create the move.")
            elif check["status"] != "completed":
                out.append("The From-To file check didn't finish. Upload the file again, "
                           "or skip the asset step.")
        crates = payload.get("crates")
        if crates is not None and crates["count"] > 0:
            if not crates.get("container_type"):
                out.append("Pick a crate type.")
            elif crates["container_type"] not in CONTAINER_TYPES:
                out.append("Pick a crate type from the list.")
            if (found := crate_clashes(names_preview(crates, "crates")["names"])):
                out.append(clash_sentence("crate", found))
        trucks = payload.get("trucks")
        if trucks is not None:
            if found := truck_clashes(names_preview(trucks, "trucks")["names"]):
                out.append(clash_sentence("truck", found))
        return out

    # ── sites ──

    @app.get("/sites")
    async def list_sites(request: Request) -> list[dict]:
        fake.require(request, "sites", "view")
        rows = sorted(fake.sites.values(), key=lambda s: natural_key(s["name"]))
        return [{"id": s["id"], "name": s["name"], "code": s.get("code"), "site_type": None,
                 "status": "active", "status_label": "Active", "status_color": "#51606f",
                 "country": "US", "latitude": s["latitude"], "longitude": s["longitude"],
                 "archived_at": s.get("archived_at"), "created_at": fake._iso(now()),
                 "clients": []} for s in rows]

    # ── the draft ──

    @app.post("/bulk/move-setup", status_code=201)
    async def create_draft(body: MoveSetupMoveIn, request: Request) -> dict:
        user = guard(request)
        move = move_data(body)
        job = {"id": str(uuid.uuid4()), "kind": "move_setup", "created_by": user.person_id,
               "status": "preview", "error": None, "initiative_id": None,
               "payload": {"move": move, "assets": None, "crates": None, "trucks": None},
               "total_rows": 0, "processed_rows": 0, "results": None, "created_at": now()}
        fake.import_jobs[job["id"]] = job
        return draft_out(job)

    @app.get("/bulk/move-setup/{draft_id}")
    async def get_draft(draft_id: uuid.UUID, request: Request) -> dict:
        return draft_out(draft(draft_id, guard(request)))

    @app.patch("/bulk/move-setup/{draft_id}")
    async def update_draft(draft_id: uuid.UUID, body: MoveSetupPatchIn,
                           request: Request) -> dict:
        job = draft(draft_id, guard(request))
        editable(job)
        payload = dict(job["payload"] or {})
        if body.move is not None:
            payload["move"] = move_data(body.move)
        if body.crates is not None:
            data = body.crates.model_dump()
            data["convention"] = data["convention"].strip()
            try:
                generate_names(data["convention"], data["count"], data["start"],
                               max_count=CRATE_MAX)
            except NamingError as exc:
                raise _err(422, "invalid_naming", message=exc.message) from None
            if any(k not in LABEL_TAG_KEYS for k in data["tags"]):
                raise _err(422, "bad_tag_key", allowed=list(LABEL_TAG_KEYS))
            if sum(data["tags"].values()) > data["count"]:
                raise _err(422, "tags_exceed_count")
            if data["container_type"] and data["container_type"] not in CONTAINER_TYPES:
                raise _err(422, "bad_container_type")
            payload["crates"] = data
        if body.trucks is not None:
            data = body.trucks.model_dump()
            data["convention"] = data["convention"].strip()
            try:
                generate_names(data["convention"], data["count"], data["start"],
                               max_count=TRUCK_MAX)
            except NamingError as exc:
                raise _err(422, "invalid_naming", message=exc.message) from None
            payload["trucks"] = data
        for section in body.skip:
            payload[section] = None
        job["payload"] = payload
        reopen(job)
        return draft_out(job, with_previews=True)

    @app.post("/bulk/move-setup/{draft_id}/assets", status_code=201)
    async def upload_assets(draft_id: uuid.UUID, request: Request) -> dict:
        form = read_form(request.headers.get("content-type", ""), await request.body())
        if "file" not in form:                  # File(...): FastAPI's own 422
            raise HTTPException(422, [{"type": "missing", "loc": ["body", "file"]}])
        make_model_mode = (form.get("make_model_mode") or (None, b"fuzzy"))[1].decode()
        generate_serials = (form.get("generate_serials") or (None, b""))[1] in (b"true", b"1")
        job = draft(draft_id, guard(request))
        editable(job)
        if make_model_mode not in MAKE_MODEL_MODES:
            raise _err(422, "invalid_make_model_mode")
        filename = form["file"][0] or "upload.csv"
        if not filename.lower().endswith(IMPORT_EXTENSIONS):
            raise _err(422, "unsupported_file")
        content = form["file"][1]
        if len(content) > MAX_BYTES:
            raise _err(422, "file_too_large", limit=MAX_BYTES)
        if not content:
            raise _err(422, "empty_file")
        check = {"id": str(uuid.uuid4()), "kind": "move_assets", "status": "queued",
                 "filename": filename, "content": content, "error": None, "results": None,
                 "total_rows": 0, "created_at": now(),
                 "options": {"make_model_mode": make_model_mode,
                             "generate_serials": generate_serials,
                             "move_setup_id": job["id"], "client_id": None}}
        for old in [j for j in fake.import_jobs.values() if j["kind"] == "move_assets"
                    and j["options"]["move_setup_id"] == job["id"]]:
            del fake.import_jobs[old["id"]]          # attach_check retires the others
        fake.import_jobs[check["id"]] = check
        job["payload"] = {**job["payload"],
                          "assets": {"check_job_id": check["id"], "filename": filename}}
        reopen(job)
        return check_out(check)

    @app.get("/bulk/move-setup/{draft_id}/assets")
    async def get_assets(draft_id: uuid.UUID, request: Request) -> dict:
        check = check_of(draft(draft_id, guard(request)))
        if check is None:
            raise _err(404, "no_asset_check")
        return check_out(check)

    @app.post("/bulk/move-setup/{draft_id}/create")
    async def create_move(draft_id: uuid.UUID, request: Request) -> dict:
        job = draft(draft_id, guard(request))
        editable(job)
        reasons = draft_problems(job["payload"] or {})
        if reasons:
            raise _err(422, "setup_invalid", reasons=reasons)
        job.update(status="queued", error=None, results=None, processed_rows=0, total_rows=0)
        return draft_out(job)

    # ── the move PATCH ──

    @app.patch("/initiatives/{initiative_id}")
    async def update_initiative(initiative_id: uuid.UUID, body: InitiativeUpdateIn,
                                request: Request) -> dict:
        user = fake.require(request, "initiatives", "change")
        move = fake.initiative(initiative_id)
        wants_password = "kiosk_password" in body.model_fields_set
        data = body.model_dump(exclude_unset=True)
        data.pop("kiosk_password", None)
        if wants_password and user.rank < GATE_BYPASS_RANK:
            raise _err(403, "kiosk_password_forbidden")
        for field in NON_NULLABLE_FIELDS:
            if field in data and not data[field]:
                raise _err(422, f"{field}_required")
        if "status" in data and data["status"] not in INITIATIVE_STATUSES:
            raise _err(422, "unknown_status")
        name = data.get("name", move["name"])
        password = (body.kiosk_password or "").strip() if wants_password else None
        if wants_password and body.kiosk_password:
            # the whole PATCH is one transaction: a refused password changes nothing
            if move["initiative_type"] != "move":
                raise _err(422, "kiosk_password_moves_only")
            if len(password) < PASSWORD_MIN_LENGTH:
                raise _err(422, "kiosk_password_too_short")
            if name.strip().casefold() and name.strip().casefold() in password.casefold():
                raise _err(422, "kiosk_password_contains_name")
            if any(m["password"] == password and m["id"] != move["id"]
                   for m in fake.moves.values()):
                raise _err(422, "kiosk_password_in_use")
        move.update(data)
        if wants_password:
            move["password"] = password or None
        return {**fake.initiative_item(move), "people": [], "links_children": [],
                "links_parents": []}

    # ── the import worker ──

    def run_check(check: dict) -> None:
        try:
            reader = csv.DictReader(io.StringIO(check["content"].decode("utf-8-sig")))
            headers = [h.strip().lower() for h in reader.fieldnames or [] if h]
        except UnicodeDecodeError:
            check.update(status="failed", error="invalid_csv")
            return
        if not any(h in SERIAL_HEADERS for h in headers):
            check.update(status="failed", error="missing_serial_column")
            return
        rows = list(reader)
        errors = sum(1 for r in rows if not (r.get("Serial Number") or "").strip())
        check["rows"] = rows
        check["total_rows"] = len(rows)
        check.update(status="completed", results={
            "summary": {"total_rows": len(rows), "processed_rows": len(rows),
                        "created": len(rows) - errors, "updated": 0, "review": 0,
                        "errors": errors, "client_id": None, "conflicts": 0},
            "details": []})

    def fail(job: dict, code: str, reasons: list[str]) -> None:
        job.update(status="failed", error=code, results={"reasons": reasons}, processed_rows=0)

    def apply(job: dict) -> None:
        payload = job["payload"]
        reasons = [r for r in draft_problems(payload) if "already exist" not in r]
        if reasons:
            fail(job, "setup_invalid", reasons)
            return
        crates, trucks = payload.get("crates"), payload.get("trucks")
        crate_names = names_preview(crates, "crates")["names"] if crates else []
        truck_names = names_preview(trucks, "trucks")["names"] if trucks else []
        if found := crate_clashes(crate_names):
            fail(job, "name_taken", [clash_sentence("crate", found)])
            return
        if found := truck_clashes(truck_names):
            fail(job, "name_taken", [clash_sentence("truck", found)])
            return
        move = payload["move"]
        move_id = str(uuid.uuid4())
        origin, destination = move["origin_site_id"], move["destination_site_id"]
        fake.moves[move_id] = {"id": move_id, "name": move["name"], "status": "planned",
                               "initiative_type": "move", "password": None,
                               "origin_site_id": origin, "destination_site_id": destination}
        check = check_of(job)
        rows = [r for r in (check or {}).get("rows") or []
                if (r.get("Serial Number") or "").strip()]
        for r in rows:
            aid = str(uuid.uuid4())
            fake.assets[aid] = {
                "id": aid, "legacy_id": next(fake._legacy_seq),
                "name": (r.get("Asset Name") or "").strip(),
                "serial_number": r["Serial Number"].strip(),
                "rfid_tag": (r.get("RFID Tag") or "").strip().upper() or None,
                "initiative_id": move_id, "asset_status": None}
        for name in crate_names:
            cid = str(uuid.uuid4())
            fake.containers[cid] = {"id": cid, "name": name, "initiative_id": move_id,
                                    "site_id": origin, "status": "available",
                                    "container_type": crates["container_type"]}
        for name in truck_names:
            tid = str(uuid.uuid4())
            fake.trucks[tid] = {"id": tid, "name": name, "initiative_id": move_id,
                                "status": "created", "start_site_id": origin,
                                "end_site_id": destination}
        if check is not None:
            del fake.import_jobs[check["id"]]        # retire_check_jobs
        job.update(status="completed", error=None, initiative_id=move_id, payload=None,
                   processed_rows=job["total_rows"],
                   results={"move_id": move_id,
                            "assets": {"summary": {"created": len(rows)}, "details": []},
                            "crates": len(crate_names), "trucks": len(truck_names)})

    def process_jobs() -> None:
        for job in list(fake.import_jobs.values()):
            if job["kind"] == "move_assets" and job["status"] == "queued":
                run_check(job)
            elif job["kind"] == "move_setup" and job["status"] == "queued":
                payload = job["payload"] or {}
                check = check_of(job)
                job.update(status="running", total_rows=(
                    len((check or {}).get("rows") or [])
                    + ((payload.get("crates") or {}).get("count") or 0)
                    + ((payload.get("trucks") or {}).get("count") or 0)))
            elif job["kind"] == "move_setup" and job["status"] == "running":
                apply(job)

    fake.process_jobs = process_jobs
