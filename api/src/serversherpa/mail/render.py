"""Email templates → (subject, html, text). Each email is three files in
templates/: <name>.subject.txt, <name>.html (extends _base.html) and
<name>.txt. Autoescape is on for .html only; StrictUndefined makes a
missing context key an error at enqueue time, not a blank in the inbox."""

from dataclasses import dataclass
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

TEMPLATES_DIR = Path(__file__).parent / "templates"

_env = Environment(
    loader=FileSystemLoader(TEMPLATES_DIR),
    autoescape=select_autoescape(enabled_extensions=("html",), default_for_string=False),
    undefined=StrictUndefined,
    keep_trailing_newline=True,
)


@dataclass(frozen=True)
class Rendered:
    subject: str
    html: str
    text: str


def render(template: str, **ctx) -> Rendered:
    subject = _env.get_template(f"{template}.subject.txt").render(**ctx).strip()
    html = _env.get_template(f"{template}.html").render(subject=subject, **ctx)
    text = _env.get_template(f"{template}.txt").render(**ctx).strip() + "\n"
    return Rendered(subject=subject, html=html, text=text)
