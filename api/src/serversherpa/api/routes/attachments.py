"""Attachments — the global file-association flow.

One endpoint handles every "attach a file to a record" case: avatars
today; asset photos, project documents, signatures later. Storage is
S3-compatible (MinIO dev / DO Spaces prod) via services.storage.
"""

import uuid
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from sqlalchemy import select, update

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, CurrentUser, DbSession
from serversherpa.api.schemas import AttachmentOut
from serversherpa.db.models import (
    Asset, Attachment, Client, Container, Initiative, Partner, Person,
    ReportDefinition, Site, Truck,
)
from serversherpa.services.audit import audit
from serversherpa.services.storage import presign_get, put_object

router = APIRouter(prefix="/attachments", tags=["attachments"])

EntityType = Literal[
    "person", "client", "partner", "asset", "container", "initiative", "site",
    "truck", "report_definition",
]

ENTITY_MODEL = {
    "person": Person, "client": Client, "partner": Partner, "asset": Asset,
    "container": Container, "initiative": Initiative, "site": Site,
    "truck": Truck, "report_definition": ReportDefinition,
}
AVATAR_KEY_FIELD = {"person": "avatar_key", "client": "logo_key", "partner": "logo_key"}
Kind = Literal["avatar", "photo", "document", "survey_template", "report_asset"]

# Some kinds only make sense on one entity type — the Site & Move Survey
# report's xlsx questionnaire template and the standards docx/pdf, both
# carried on the report definition itself (not the partner — templates
# are company-owned, per report definition, not per partner).
KIND_ENTITY_TYPES = {
    "survey_template": {"report_definition"},
    "report_asset": {"report_definition"},
}

# Extensions accepted for the document kinds that aren't sniffed as images.
DOCUMENT_KIND_EXTENSIONS = {
    "survey_template": {".xlsx"},
    "report_asset": {".docx", ".pdf"},
}
EXTENSION_CONTENT_TYPE = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pdf": "application/pdf",
}

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024

# content sniffing — never trust the client's content type alone
IMAGE_MAGIC: list[tuple[bytes, str, str]] = [
    (b"\xff\xd8\xff", "image/jpeg", ".jpg"),
    (b"\x89PNG\r\n\x1a\n", "image/png", ".png"),
    (b"GIF8", "image/gif", ".gif"),
]


def _sniff_image(data: bytes) -> tuple[str, str] | None:
    for magic, ctype, ext in IMAGE_MAGIC:
        if data.startswith(magic):
            return ctype, ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def _authorize(
    db: DbSession, actor: AuthContext, entity_type: str, entity_id: uuid.UUID,
    action: str, kind: str | None = None,
) -> None:
    entity = await db.get(ENTITY_MODEL[entity_type], entity_id)
    if entity is None:
        raise _err(404, "entity_not_found")
    if entity_type == "person" and entity_id == actor.person.id and kind == "avatar":
        # self-service: managing your OWN avatar is always allowed,
        # regardless of role/permission grants. This is avatars ONLY —
        # a document (or any other kind) on your own person record still
        # needs the normal `attachments` grant; entity_id == actor.person.id
        # is never on its own a bypass. A list request with no `kind`
        # filter can't prove every row would be an avatar, so it falls
        # through to the normal checks below too.
        return
    if entity_type == "report_definition":
        # the survey_template xlsx and the standards docx/pdf both live on
        # the report definition itself, so their attachment permission is
        # the reports resource, not `attachments`: view to see them, change
        # to add/delete them (same gate as editing the definition's other
        # fields in routes/reports.py).
        required = "view" if action == "view" else "change"
        if not actor.access.can("reports", required):
            raise _err(403, "forbidden")
        return
    if entity_type == "asset" and action == "view":
        # asset attachments inherit the asset's visibility: permission
        # derives ENTIRELY from the host resource (assets:view + row
        # scope), exactly like the notes router — attachments:view is
        # never consulted for this case, so a client-scoped actor with
        # only assets:view can see attachments on assets they can see.
        if not actor.access.can("assets", "view"):
            raise _err(403, "forbidden")
        if not actor.access.is_global:
            cond = scope_conditions("assets", actor.access, actor.person.id)
            if cond is not None:
                visible = await db.scalar(select(Asset.id).where(
                    Asset.id == entity_id, cond))
                if visible is None:
                    raise _err(404, "entity_not_found")
        return
    if not actor.access.can("attachments", action):
        raise _err(403, "forbidden")
    # attachments has no SCOPE_COLUMNS entry to backstop a matrix/override
    # grant, so a non-global actor's "attachments" permission (even an
    # admin-set override) is not enough on its own — deny until attachments
    # get a real scope map. Other entity types (and asset add/delete) keep
    # this interim hard deny.
    if not actor.access.is_global:
        raise _err(403, "forbidden")


def _out(att: Attachment) -> AttachmentOut:
    out = AttachmentOut.model_validate(att)
    out.url = presign_get(att.storage_key)
    return out


@router.post("", response_model=AttachmentOut, status_code=201)
async def upload_attachment(
    user: CurrentUser,
    db: DbSession,
    entity_type: Annotated[EntityType, Form()],
    entity_id: Annotated[uuid.UUID, Form()],
    kind: Annotated[Kind, Form()],
    file: Annotated[UploadFile, File()],
) -> AttachmentOut:
    await _authorize(db, user, entity_type, entity_id, "add", kind)

    if kind == "avatar" and entity_type not in AVATAR_KEY_FIELD:
        raise _err(422, "avatar_not_supported")
    allowed_entity_types = KIND_ENTITY_TYPES.get(kind)
    if allowed_entity_types is not None and entity_type not in allowed_entity_types:
        raise _err(422, "kind_not_allowed")

    data = await file.read()
    if kind in ("avatar", "photo"):
        if len(data) > MAX_IMAGE_BYTES:
            raise _err(413, "file_too_large")
        sniffed = _sniff_image(data)
        if sniffed is None:
            raise _err(422, "not_an_image")
        content_type, ext = sniffed
    else:
        if len(data) > MAX_DOCUMENT_BYTES:
            raise _err(413, "file_too_large")
        allowed_extensions = DOCUMENT_KIND_EXTENSIONS.get(kind)
        ext = PurePosixPath(file.filename or "").suffix.lower()
        if allowed_extensions is not None:
            if ext not in allowed_extensions:
                raise _err(422, "invalid_file_type")
            content_type = EXTENSION_CONTENT_TYPE[ext]
        else:
            content_type = file.content_type or "application/octet-stream"
            ext = ""
    if len(data) == 0:
        raise _err(422, "empty_file")

    key = f"attachments/{entity_type}/{entity_id}/{kind}/{uuid.uuid4()}{ext}"
    await put_object(key, data, content_type)

    now = datetime.now(UTC)

    if kind == "avatar":
        # single current avatar/logo: retire previous rows BEFORE inserting
        # the new one (the update autoflushes — ordering matters), repoint
        await db.execute(
            update(Attachment)
            .where(Attachment.entity_type == entity_type,
                   Attachment.entity_id == entity_id,
                   Attachment.kind == "avatar",
                   Attachment.deleted_at.is_(None))
            .values(deleted_at=now)
        )
        entity = await db.get(ENTITY_MODEL[entity_type], entity_id)
        assert entity is not None  # _authorize checked
        setattr(entity, AVATAR_KEY_FIELD[entity_type], key)
        entity.updated_at = now

    attachment = Attachment(
        entity_type=entity_type,
        entity_id=entity_id,
        kind=kind,
        storage_key=key,
        filename=file.filename or f"upload{ext}",
        content_type=content_type,
        size_bytes=len(data),
        uploaded_by=user.person.id,
    )
    db.add(attachment)

    audit(db, actor_id=user.person.id, entity_type=entity_type,
          entity_id=str(entity_id), action="attachment.add",
          changes={"filename": {"from": None, "to": attachment.filename}})

    await db.commit()
    return _out(attachment)


@router.get("", response_model=list[AttachmentOut])
async def list_attachments(
    user: CurrentUser,
    db: DbSession,
    entity_type: EntityType,
    entity_id: uuid.UUID,
    kind: Kind | None = None,
) -> list[AttachmentOut]:
    await _authorize(db, user, entity_type, entity_id, "view", kind)
    stmt = select(Attachment).where(
        Attachment.entity_type == entity_type,
        Attachment.entity_id == entity_id,
        Attachment.deleted_at.is_(None),
    ).order_by(Attachment.created_at.desc())
    if kind is not None:
        stmt = stmt.where(Attachment.kind == kind)
    rows = (await db.scalars(stmt)).all()
    return [_out(a) for a in rows]


@router.delete("/{attachment_id}", status_code=204)
async def delete_attachment(
    attachment_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> None:
    att = await db.get(Attachment, attachment_id)
    if att is None or att.deleted_at is not None:
        raise _err(404, "attachment_not_found")
    await _authorize(db, user, att.entity_type, att.entity_id, "delete", att.kind)

    att.deleted_at = datetime.now(UTC)
    if att.kind == "avatar":
        entity = await db.get(ENTITY_MODEL[att.entity_type], att.entity_id)
        field = AVATAR_KEY_FIELD.get(att.entity_type)
        if entity is not None and field and getattr(entity, field) == att.storage_key:
            setattr(entity, field, None)

    audit(db, actor_id=user.person.id, entity_type=att.entity_type,
          entity_id=str(att.entity_id), action="attachment.remove",
          changes={"filename": {"from": att.filename, "to": None}})

    await db.commit()
