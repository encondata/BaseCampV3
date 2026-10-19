"""/edge/labels/* — the Label Station's generated labels (edge/labels/):
the run's progress for the regeneration screen, the template a setup
choice would use, one asset's finished label for the Printing Station, and
the Labeled scan queued once a label has printed. A session locked to
another move is 403 move_locked (deps.setup_move)."""

import uuid

from fastapi import APIRouter, Depends, Request

from edge import laptop_setup
from edge.db import iso, now_iso
from edge.deps import err, json_object, setup_move
from edge.labels import generate
from edge.sessions import EdgeSession

MAX_ID = 128            # an asset id (a UUID on the portal)
MAX_VALUE = 256         # the scanned value: the asset's barcode
MAX_PRINTED_BODY = 4096
LABELED = "labeled"

router = APIRouter(prefix="/edge/labels")


@router.get("/status")
async def status(request: Request, _: EdgeSession = Depends(setup_move)) -> dict:
    """`state` is 'running' only while a run that renders labels is in progress."""
    store = request.app.state.store
    row = store.one("SELECT state, reason, total, done FROM label_run WHERE id = 1")
    counts = store.one("SELECT COUNT(zpl) AS ready, COUNT(error) AS errors FROM station_labels")
    running = row is not None and row["state"] == "running"
    return {"state": "running" if running else "idle",
            "reason": row["reason"] if row is not None else None,
            "total": row["total"] if row is not None else 0,
            "done": row["done"] if row is not None else 0,
            "ready": counts["ready"], "errors": counts["errors"]}


def _dpi(raw: str | None) -> int | None:
    if raw is None:
        return None
    lo, hi = laptop_setup.DPI_RANGE
    if not raw.isdigit() or not lo <= int(raw) <= hi:
        raise err(422, "bad_request")
    return int(raw)


@router.get("/plan")
async def plan(request: Request, dpi: str | None = None, kind: str | None = None,
               _: EdgeSession = Depends(setup_move)) -> dict:
    """The template the station's labels would use, with a note per earlier
    template that isn't available at this DPI. `dpi` / `kind` override the
    saved settings (setup asks before saving them)."""
    if kind is not None and kind not in laptop_setup.LABEL_KINDS:
        raise err(422, "bad_request")
    built = generate.build_plan(request.app.state.store, label_kind=kind, dpi=_dpi(dpi))
    if built is None:
        raise err(404, "not_label_station")
    t = built.template
    template = None if t is None else {
        "id": t.id, "name": (built.template_json or {}).get("name"), "family": t.family,
        "dpi_key": t.dpi_key, "version": t.version}
    return {"template": template, "notes": built.notes}


@router.get("/asset/{asset_id}")
async def asset_label(request: Request, asset_id: str,
                      _: EdgeSession = Depends(setup_move)) -> dict:
    st = request.app.state
    if st.label_runner.running():
        raise err(409, "labels_regenerating")
    row = st.store.one("SELECT asset_id, zpl, error, template_name, dpi, label_kind "
                       "FROM station_labels WHERE asset_id = ?", (asset_id,))
    if row is None:
        raise err(404, "label_not_found")
    return dict(row)


def _field(body: dict, key: str, limit: int) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise err(422, "bad_request")
    return value


@router.post("/printed")
async def printed(request: Request, _: EdgeSession = Depends(setup_move)) -> dict:
    """A label printed for `asset_id`: queue a Labeled scan (scan_type
    'barcode', status 'labeled') for the move and site of the saved setup.
    It rides the RFID upload queue (edge.rfid.uploader) under the station
    key, with the same retries; `epc` carries the scanned value and no raw
    read stands behind it. 409 not_label_station on any other setup."""
    st = request.app.state
    body = await json_object(request, max_bytes=MAX_PRINTED_BODY)
    setup = laptop_setup.load(st.store)
    if not isinstance(setup, dict) or setup.get("station_type") != "label":
        raise err(409, "not_label_station")
    asset_id = _field(body, "asset_id", MAX_ID)
    value = _field(body, "scanned_value", MAX_VALUE)
    try:
        scanned_at = iso(_field(body, "scanned_at", 64))
    except ValueError:
        raise err(422, "bad_request") from None
    client_scan_id = str(uuid.uuid4())
    st.store.run(
        "INSERT INTO pending_rfid_scans (raw_read_id, client_scan_id, epc, matched_kind, "
        "matched_id, off_move, scanned_at, initiative_id, site_id, scan_status, "
        "upload_state, created_at, scan_type) "
        "VALUES (NULL, ?, ?, 'asset', ?, 0, ?, ?, ?, ?, 'pending', ?, 'barcode')",
        (client_scan_id, value, asset_id, scanned_at,
         _text_or_none(setup.get("initiative_id")), _text_or_none(setup.get("site_id")),
         LABELED, now_iso()))
    st.rfid_upload_wake.set()
    return {"queued": True, "client_scan_id": client_scan_id}


def _text_or_none(value) -> str | None:
    return None if value is None else str(value)
