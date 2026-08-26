"""Move-assets import pipeline (V2 upload-ft parity on the V3 schema).

Pure of HTTP and job-queue concerns: callers hand in parsed rows and
options and get back the report dict that lands in import_jobs.results.
This module grows in three stages: row helpers (this slice), the
validate/commit pipeline, and collision detection.
"""

import random

PRIORITY_MAX = 30


def resolve_make_model_for_creation(asset_make: str,
                                    asset_model: str) -> tuple[str, str]:
    """(make, model) to insert into asset_models — ported from V2's
    upload_helpers: single-populated field splits on first space, then a
    duplicated make prefix is stripped from the model (at most twice) so
    Make='Dell' + Model='Dell R640' stores model='R640'. Model exactly
    equal to make is left alone."""
    make = (asset_make or "").strip()
    model = (asset_model or "").strip()
    if not make and model:
        parts = model.split(" ", 1)
        make = parts[0]
        model = parts[1] if len(parts) > 1 else parts[0]
    elif make and not model:
        parts = make.split(" ", 1)
        make = parts[0]
        model = parts[1] if len(parts) > 1 else ""
    for _ in range(2):
        if make and model.lower().startswith(make.lower() + " "):
            model = model[len(make) + 1:].strip()
    return make, model


def generate_serial(asset_name: str) -> str:
    """V2 format: lowercase_name.13_random_digits."""
    digits = "".join(str(random.randint(0, 9)) for _ in range(13))
    return f"{asset_name.strip().lower()}.{digits}"


def _float(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def parse_row(n: int, canonical: dict, raw: dict, *,
              generate_serials: bool) -> dict:
    """One spreadsheet row -> typed import row, or an error entry."""
    serial = canonical["serial_number"].strip()
    name_raw = canonical["asset_name"].strip()
    serial_generated = False
    if not serial:
        if generate_serials and name_raw:
            serial = generate_serial(name_raw)
            serial_generated = True
        else:
            message = ("Missing required field: Serial Number"
                       if not generate_serials
                       else "Cannot generate serial: Asset Name is also blank")
            return {"row": n, "serial_number": "", "status": "error",
                    "message": message}
    serial = serial.lower()

    make = canonical["asset_make"].strip()
    model = canonical["asset_model"].strip()
    make_model_str = (f"{make} {model}" if make and model
                      else model or make or None)

    cable_info: dict = {}
    for i in range(1, 7):
        if value := canonical[f"data_{i}"].strip():
            cable_info[f"data_{i}"] = value
    for i in range(1, 3):
        if value := canonical[f"mgmt_{i}"].strip():
            cable_info[f"mgmt_{i}"] = value

    notes: list[str] = []
    priority = canonical["priority"].strip() or None
    if priority and len(priority) > PRIORITY_MAX:
        notes.append(f"Priority truncated to {PRIORITY_MAX} characters")
        priority = priority[:PRIORITY_MAX]

    def _ru(field: str) -> float | None:
        text = canonical[field].strip()
        return _float(text) if text else None

    return {
        "row": n, "status": "ok",
        "serial_number": serial,
        "asset_name": (name_raw or serial).lower(),
        "asset_make": make, "asset_model": model,
        "make_model_str": make_model_str,
        "serial_generated": serial_generated,
        "rfid_tag": canonical["rfid_tag"].strip(),
        "priority_wave": priority,
        "disposition": canonical["disposition"].strip() or None,
        "owner": canonical["owner"].strip() or None,
        "source_rack": canonical["source_rack"].strip() or None,
        "source_ru": _ru("source_ru"),
        "destination_rack": canonical["destination_rack"].strip() or None,
        "destination_ru": _ru("destination_ru"),
        "vendor_involved": bool(canonical["vendor_involvement"].strip()),
        "cable_info": cable_info,
        "raw_ft": raw,
        "notes": notes,
    }
