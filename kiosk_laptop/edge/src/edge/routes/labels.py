"""/edge/labels/* — the Label Station's generated labels (edge/labels/):
the run's progress for the regeneration screen, the template a setup
choice would use, and one asset's finished label for the Printing Station.
A session locked to another move is 403 move_locked (deps.setup_move)."""

from fastapi import APIRouter, Depends, Request

from edge import laptop_setup
from edge.deps import err, setup_move
from edge.labels import generate
from edge.sessions import EdgeSession

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
