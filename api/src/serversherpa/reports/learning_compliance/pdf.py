"""Learning compliance PDF: gathered data -> Jinja2 HTML -> WeasyPrint, with
the Move Scan History footer (Page N of M, generated stamp + tracking id,
PDF417)."""

from datetime import UTC, datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from serversherpa.learning.emails import day_text
from serversherpa.reports.learning_compliance.gather import ComplianceData
from serversherpa.reports.move_report.render import css_string, render_pdf_async
from serversherpa.reports.move_scan_history.barcode import pdf417_data_uri

_ENV = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"),
                   autoescape=select_autoescape(["html"]), trim_blocks=True,
                   lstrip_blocks=True)
_ENV.filters["cssstr"] = css_string

# Generic over the HTML it is given — reused as Move Scan History does.
render_pdf = render_pdf_async


def render_html(data: ComplianceData, *, generated_at: datetime, tracking_id: str) -> str:
    everyone = data.initiative_id is None
    rows = [{
        "person": r.person, "document": r.document, "initiative": r.initiative,
        "state": r.state, "status": r.status,
        "version": f"v{r.version}" if r.version is not None else "",
        "language": r.language or "",
        "signed_at": (f"{day_text(r.signed_at.astimezone(UTC).date())} "
                      f"{r.signed_at.astimezone(UTC):%H:%M}" if r.signed_at else ""),
        "expires_on": day_text(r.expires_on) or "", "overrides": r.overrides,
    } for r in data.rows]
    tiles = [("People", data.people), ("Required documents", len(data.rows)),
             ("Valid", data.count("valid")),
             ("Expires during", data.count("expires_during")),
             ("Missing", data.count("missing"))]
    stamp = f"{generated_at.astimezone(UTC):%Y-%m-%d %H:%M} UTC"
    return _ENV.get_template("learning_compliance.html").render(
        title="Learning compliance",
        scope=data.initiative_name or "All active initiatives and the general set",
        everyone=everyone, tiles=tiles, rows=rows, stamp=stamp, tracking_id=tracking_id,
        barcode_data_uri=pdf417_data_uri(tracking_id))
