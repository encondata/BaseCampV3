"""Label font library: upload TrueType fonts (Zebra 8.3 object names), list
them with the templates that reference them, stream their bytes for the
browser to push to a printer, soft-delete. Storage is the real dev MinIO,
like test_attachments.py."""

import uuid

from serversherpa.api.routes import labels as labels_module
from serversherpa.db.models import AuditLog, LabelFont
from sqlalchemy import select

from tests.test_label_generate_api import _template
from tests.test_sites_api import login
from tests.test_status_values_write import _make

TTF = b"\x00\x01\x00\x00" + bytes(range(256)) * 4   # TrueType magic + payload
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _upload(client, hdrs, filename, data=TTF, name=None):
    files = {"file": (filename, data, "font/ttf")}
    form = {"name": name} if name else {}
    return client.post("/labels/fonts", headers=hdrs, files=files, data=form)


async def test_upload_list_content_delete(client, db, seeded_user):
    admin = await _make(db, client, "admin", "adm-fonts@test.example.com")
    tpl = await _template(db, "front", code="^XA^A@N,25,,E:85620388.TTF^FD{asset_id}^FS^XZ")

    resp = await _upload(client, admin, "85620388.ttf")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "85620388.TTF"
    assert body["display_name"] == "85620388.ttf"
    assert body["size_bytes"] == len(TTF)
    assert body["content_type"] == "font/ttf"
    assert body["uploaded_by_name"]
    assert body["used_by"] == [{"template_id": str(tpl.id), "template_name": tpl.name}]
    font_id = body["id"]

    rows = (await client.get("/labels/fonts", headers=await login(client))).json()
    assert [r["id"] for r in rows] == [font_id]

    content = await client.get(f"/labels/fonts/{font_id}/content", headers=await login(client))
    assert content.status_code == 200
    assert content.content == TTF
    assert content.headers["content-type"].startswith("font/ttf")
    assert 'filename="85620388.TTF"' in content.headers["content-disposition"]

    assert (await client.delete(f"/labels/fonts/{font_id}", headers=admin)).status_code == 204
    assert (await client.get("/labels/fonts", headers=admin)).json() == []
    assert (await client.get(f"/labels/fonts/{font_id}/content", headers=admin)).status_code == 404
    row = await db.get(LabelFont, uuid.UUID(font_id))
    assert row is not None and row.deleted_at is not None
    actions = (await db.execute(select(AuditLog.action).where(
        AuditLog.entity_type == "label_font", AuditLog.entity_id == font_id))).scalars().all()
    assert sorted(actions) == ["create", "delete"]


async def test_upload_validation(client, db, seeded_user):
    admin = await _make(db, client, "admin", "adm-fonts2@test.example.com")
    assert (await _upload(client, admin, "longername.ttf")).json()["detail"]["code"] == "invalid_font_name"
    assert (await _upload(client, admin, "swiss.otf")).json()["detail"]["code"] == "invalid_font_name"
    assert (await _upload(client, admin, "x.ttf", name="bad name.ttf")).json()["detail"]["code"] == "invalid_font_name"
    assert (await _upload(client, admin, "logo.ttf", data=PNG)).json()["detail"]["code"] == "not_a_truetype_font"
    assert (await _upload(client, admin, "empty.ttf", data=b"")).json()["detail"]["code"] == "empty_file"
    big = b"\x00\x01\x00\x00" + b"\x00" * (2 * 1024 * 1024)
    assert (await _upload(client, admin, "big.ttf", data=big)).status_code == 413
    # explicit name overrides the filename and is upper-cased
    ok = await _upload(client, admin, "whatever.ttf", name="tt0003m_.ttf")
    assert ok.status_code == 201 and ok.json()["name"] == "TT0003M_.TTF"
    dup = await _upload(client, admin, "TT0003M_.TTF")
    assert dup.status_code == 409 and dup.json()["detail"]["code"] == "font_name_taken"
    # after deleting, the name is free again
    await client.delete(f"/labels/fonts/{ok.json()['id']}", headers=admin)
    assert (await _upload(client, admin, "TT0003M_.TTF")).status_code == 201


async def test_upload_race_reports_font_name_taken(client, db, seeded_user, monkeypatch):
    """Simulate the duplicate-name race deterministically: force the
    pre-check to see nothing (as if a concurrent upload hadn't committed
    yet when this request checked), so the second upload reaches the
    INSERT and trips label_fonts_name_active_idx. That must map to the
    same clean 409 as the pre-check, and must leave exactly one
    non-deleted row for the name — not a 500, and not a duplicate row."""
    admin = await _make(db, client, "admin", "adm-fonts4@test.example.com")
    first = await _upload(client, admin, "RACE.TTF")
    assert first.status_code == 201, first.text

    async def _sees_nothing(db, name):
        return None

    monkeypatch.setattr(labels_module, "_active_font_id", _sees_nothing)

    second = await _upload(client, admin, "RACE.TTF")
    assert second.status_code == 409, second.text
    assert second.json()["detail"]["code"] == "font_name_taken"

    rows = (await db.execute(select(LabelFont).where(
        LabelFont.name == "RACE.TTF", LabelFont.deleted_at.is_(None)))).scalars().all()
    assert len(rows) == 1


async def test_font_permissions(client, db, seeded_user):
    worker = await _make(db, client, "worker", "w-fonts@test.example.com")
    assert (await client.get("/labels/fonts", headers=worker)).status_code == 403
    assert (await _upload(client, worker, "a.ttf")).status_code == 403
    staff = await login(client)   # labels:view only
    assert (await _upload(client, staff, "b.ttf")).status_code == 403
    assert (await client.delete(f"/labels/fonts/{uuid.uuid4()}", headers=staff)).status_code == 403
    admin = await _make(db, client, "admin", "adm-fonts3@test.example.com")
    assert (await client.delete(f"/labels/fonts/{uuid.uuid4()}", headers=admin)).status_code == 404
