"""The per-worker sign-off certificate: a PDF listing every sign-off (or
those for one initiative) with the document, version, language, when and
how it was signed. A drawn signature is embedded as an image. Read-only."""
import base64
import uuid
from datetime import UTC, datetime
from pathlib import Path

from fastapi import HTTPException
from jinja2 import Environment, FileSystemLoader, select_autoescape
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, Person
from serversherpa.learning.emails import day_text
from serversherpa.learning.models import (
    LearningAssignment,
    LearningDocument,
    LearningDocumentVersion,
    LearningSignoff,
)
from serversherpa.learning.settings import load_settings
from serversherpa.reports.move_report.render import render_pdf_async

_ENV = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"),
                   autoescape=select_autoescape(["html"]), trim_blocks=True,
                   lstrip_blocks=True)


def _not_found(code: str) -> HTTPException:
    return HTTPException(status_code=404, detail={"code": code, "message": "Not found."})


def _stamp(at: datetime) -> str:
    at = at.astimezone(UTC)
    return f"{day_text(at.date())} {at:%H:%M} UTC"


async def certificate_html(db: AsyncSession, person_id: uuid.UUID, *,
                           initiative_id: uuid.UUID | None = None,
                           generated_at: datetime | None = None) -> str:
    person = await db.get(Person, person_id)
    if person is None:
        raise _not_found("person_not_found")
    initiative = None
    if initiative_id is not None:
        # only an initiative this person actually has learning on: the id
        # alone must not let anyone confirm or read another initiative's name
        initiative = await db.get(Initiative, initiative_id)
        on_record = initiative is not None and (
            await db.scalar(select(LearningSignoff.id).where(
                LearningSignoff.person_id == person_id,
                LearningSignoff.initiative_id == initiative_id).limit(1)) is not None
            or await db.scalar(select(LearningAssignment.id).where(
                LearningAssignment.person_id == person_id,
                LearningAssignment.initiative_id == initiative_id).limit(1)) is not None)
        if not on_record:
            raise _not_found("initiative_not_found")
    query = (select(LearningSignoff, LearningDocument.title, LearningDocumentVersion.version_no,
                    Initiative.name)
             .join(LearningDocument, LearningDocument.id == LearningSignoff.document_id)
             .join(LearningDocumentVersion,
                   LearningDocumentVersion.id == LearningSignoff.version_id)
             .outerjoin(Initiative, Initiative.id == LearningSignoff.initiative_id)
             .where(LearningSignoff.person_id == person_id)
             .order_by(LearningSignoff.signed_at, LearningSignoff.created_at,
                       LearningSignoff.id))
    if initiative_id is not None:
        query = query.where(LearningSignoff.initiative_id == initiative_id)
    rows = []
    for signoff, title, version_no, initiative_name in (await db.execute(query)).all():
        rows.append({
            "document": title, "version": version_no, "language": signoff.language,
            "signed_at": _stamp(signoff.signed_at), "typed_name": signoff.typed_name,
            "signature": (None if signoff.signature_png is None else
                          "data:image/png;base64,"
                          + base64.b64encode(signoff.signature_png).decode("ascii")),
            "quiz_score": signoff.quiz_score, "initiative": initiative_name})
    generated_at = generated_at or datetime.now(UTC)
    return _ENV.get_template("learning_certificate.html").render(
        name=person.display_name, brand=(await load_settings(db)).brand_line,
        scope=initiative.name if initiative else None, rows=rows,
        show_initiative=initiative is None,
        generated=_stamp(generated_at))


async def certificate_pdf(db: AsyncSession, person_id: uuid.UUID, *,
                          initiative_id: uuid.UUID | None = None) -> bytes:
    return await render_pdf_async(
        await certificate_html(db, person_id, initiative_id=initiative_id))
