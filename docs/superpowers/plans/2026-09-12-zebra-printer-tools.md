# Zebra Printer Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `/labels/printers` Zebra tab from a placeholder into working tools for the browser-connected Zebra printer: a printer card with identity/health, a test-label alignment modal, a font library with install-to-printer, and a guided setup wizard.

**Architecture:** Extend the Print Labels WebUSB transport (`labels/zebraUsb.ts`) with generic read/query/chunked-send and pure parsers, add a pure command-builder module, extend `useZebraPrinter` with query/identify/status/known devices/log, add a `label_fonts` table + `/labels/fonts` routes, and build three content-sized modals plus the page. Spec: `docs/superpowers/specs/2026-09-12-zebra-printer-tools-design.md` (read it first).

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + MinIO (api/), React 18 + TypeScript + Vite + vitest/jsdom/testing-library (portal/), WebUSB.

## Global Constraints

- Branch: `zebra-printer-tools` in a worktree off `reports` (currently `reports` == `main` + the spec commit). Never switch the main checkout's branch.
- API tests (from the worktree's `api/`, FOREGROUND, long timeout): `SS_TEST_DB=serversherpa_test_zebra PYTHONPATH=<worktree>/api/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/<file> -q -x` — the `PYTHONPATH` override is REQUIRED (the main venv's editable install points at main's src). Storage tests hit the real dev MinIO (docker) like `test_attachments.py` does.
- Portal tests (from the worktree's `portal/`): `npx vitest run <file>`; guardrail `npx vitest run src/styles/listTypography.test.ts`; `npx tsc -b` before each commit. `portal/node_modules` is a symlink to the main checkout — never `npm install` in the worktree, never `git add -A`.
- American English in all copy, comments, docs. Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never commit `api/src/serversherpa/_dev_reload.py`.
- Modals: `modal-scrim` > `modal-card reports-modal-card rgm-card <own-modifier>` with `modal-head` > `rgm-head-text` (eyebrow "Printers" / h3 / page-hint) + `modal-close`; Escape only when `!e.defaultPrevented`; own width rule; `overflow: visible; max-height: none` when hosting a ComboBox.
- Lists: `DataTable` for tables; row text carries `cell-top`/`cell-sub`/`mono`/`chip`/`pn`; no inline font styles; page CSS on list-ish selectors is layout/color only.
- ZPL command strings exactly as listed in the spec's "Transport additions"; parsers never throw (return `null` on garbage).

## File map

| File | Responsibility |
|---|---|
| `api/migrations/versions/0060_label_fonts.py` (create) | `label_fonts` table + partial unique index |
| `api/src/serversherpa/db/models.py` (modify) | `LabelFont` |
| `api/src/serversherpa/api/schemas.py` (modify) | `LabelFontUsedByOut`, `LabelFontOut` |
| `api/src/serversherpa/api/routes/labels.py` (modify) | `/labels/fonts` list/upload/delete/content |
| `api/tests/test_label_fonts_api.py` (create) | endpoint tests |
| `portal/src/lib/api.ts` (modify) + `api.labelFonts.test.ts` | font client |
| `portal/src/labels/zebraCommands.ts` (+ test) | command builders, name/magic validation, DPI mapping |
| `portal/src/labels/zebraUsb.ts` (modify, + test additions) | `readText`, `query`, `sendBytes`, parsers |
| `portal/src/lib/useZebraPrinter.ts` (modify, + test additions) | `query`, `sendBytes`, `identify`, `status`, `knownDevices`, `connectTo`, `log` |
| `portal/src/labels/zebraSetup.ts` (+ test) | wizard pure logic: choices from config, commands for changes, confirm-by-re-read |
| `portal/src/components/printers/AlignmentTestModal.tsx` (+ test) | test label modal |
| `portal/src/components/printers/InstallFontsModal.tsx` (+ test) | font library + install |
| `portal/src/components/printers/PrinterSetupModal.tsx` (+ test) | setup wizard |
| `portal/src/components/printers/PrinterHealth.tsx` (+ test) | identity/health chips (shared by card + wizard) |
| `portal/src/pages/Printers.tsx` (rewrite, + test) | page |
| `portal/src/styles/printers.css` (create) | `zp-*` layout rules |

---

### Task 1: API — `label_fonts` table and `/labels/fonts` routes

**Files:**
- Create: `api/migrations/versions/0060_label_fonts.py`
- Modify: `api/src/serversherpa/db/models.py` (after `LabelTemplate`), `api/src/serversherpa/api/schemas.py` (after `LabelTemplateOut`), `api/src/serversherpa/api/routes/labels.py`
- Test: `api/tests/test_label_fonts_api.py`

**Interfaces:**
- Produces: `GET /labels/fonts` → `list[LabelFontOut]`; `POST /labels/fonts` multipart (`file`, optional `name`) → 201 `LabelFontOut`; `DELETE /labels/fonts/{id}` → 204; `GET /labels/fonts/{id}/content` → TTF bytes. `LabelFontOut = { id, name, display_name, size_bytes, content_type, uploaded_by, uploaded_by_name, created_at, used_by: [{template_id, template_name}] }`. Errors: 422 `invalid_font_name` | `not_a_truetype_font` | `empty_file`, 413 `file_too_large`, 409 `font_name_taken`, 404 `font_not_found`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_label_fonts_api.py
"""Label font library: upload TrueType fonts (Zebra 8.3 object names), list
them with the templates that reference them, stream their bytes for the
browser to push to a printer, soft-delete. Storage is the real dev MinIO,
like test_attachments.py."""

import uuid

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


async def test_font_permissions(client, db, seeded_user):
    worker = await _make(db, client, "worker", "w-fonts@test.example.com")
    assert (await client.get("/labels/fonts", headers=worker)).status_code == 403
    assert (await _upload(client, worker, "a.ttf")).status_code == 403
    staff = await login(client)   # labels:view only
    assert (await _upload(client, staff, "b.ttf")).status_code == 403
    assert (await client.delete(f"/labels/fonts/{uuid.uuid4()}", headers=staff)).status_code == 403
    admin = await _make(db, client, "admin", "adm-fonts3@test.example.com")
    assert (await client.delete(f"/labels/fonts/{uuid.uuid4()}", headers=admin)).status_code == 404
```

If `login(client)`'s default account turns out to hold `labels:add` (check `tests/test_labels_templates_api.py` for which persona creates templates), swap the "staff" assertions to a persona that has only `labels:view`, or drop those two lines and note it in the report.

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `api/`): `SS_TEST_DB=serversherpa_test_zebra PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/test_label_fonts_api.py -q -x`
Expected: FAIL — `LabelFont` import error.

- [ ] **Step 3: Migration**

```python
# api/migrations/versions/0060_label_fonts.py
"""Label font library — TrueType fonts admins upload once and push to a
Zebra printer's E: drive from Labels → Printers (Install Fonts). `name` is
the printer-side object name (Zebra 8.3, e.g. 85620388.TTF); unique among
non-deleted rows so a deleted font's name can be reused.

Design: docs/superpowers/specs/2026-09-12-zebra-printer-tools-design.md

Revision ID: 0060
Revises: 0059
Create Date: 2026-09-12
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0060"
down_revision: str | None = "0059"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NAME_IDX = "label_fonts_name_active_idx"


def upgrade() -> None:
    op.create_table(
        "label_fonts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", postgresql.CITEXT(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False, server_default=""),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False, server_default="font/ttf"),
        sa.Column("uploaded_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("people.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(NAME_IDX, "label_fonts", ["name"], unique=True,
                    postgresql_where=sa.text("deleted_at IS NULL"))


def downgrade() -> None:
    op.drop_index(NAME_IDX, table_name="label_fonts")
    op.drop_table("label_fonts")
```

Check how earlier migrations declare timestamp columns (`grep -n "DateTime\|TIMESTAMP" api/migrations/versions/0042_labels.py`) and match that style if it differs.

- [ ] **Step 4: Model**

Append after `LabelTemplate` in `api/src/serversherpa/db/models.py`:

```python
class LabelFont(Base):
    """A TrueType font in the label font library: `name` is the Zebra
    object name it is installed under on the printer's E: drive
    (Install Fonts on Labels → Printers). Soft-deleted; the partial
    unique index on (name) WHERE deleted_at IS NULL lives in 0060."""
    __tablename__ = "label_fonts"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    display_name: Mapped[str] = mapped_column(server_default="")
    storage_key: Mapped[str]
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    content_type: Mapped[str] = mapped_column(server_default="font/ttf")
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    deleted_at: Mapped[datetime | None]
```

- [ ] **Step 5: Schemas**

After `LabelTemplateOut` in `schemas.py`:

```python
class LabelFontUsedByOut(BaseModel):
    template_id: uuid.UUID
    template_name: str


class LabelFontOut(BaseModel):
    id: uuid.UUID
    name: str
    display_name: str
    size_bytes: int
    content_type: str
    uploaded_by: uuid.UUID | None
    uploaded_by_name: str | None
    created_at: datetime
    used_by: list[LabelFontUsedByOut]
```

- [ ] **Step 6: Routes**

In `api/src/serversherpa/api/routes/labels.py`: add `LabelFont` to the models import, `LabelFontOut, LabelFontUsedByOut` to the schemas import, `from pathlib import PurePosixPath`, `from typing import Annotated`, `from fastapi import File, Form, UploadFile` (extend the existing fastapi import), and `from serversherpa.services.storage import get_object, put_object`. Then append:

```python
# ── font library (Labels → Printers › Install Fonts) ─────────────────

FONT_NAME_RE = re.compile(r"^[A-Z0-9_]{1,8}\.TTF$")
MAX_FONT_BYTES = 2 * 1024 * 1024
TRUETYPE_MAGICS = (b"\x00\x01\x00\x00", b"true")


def font_object_name(filename: str | None) -> str | None:
    """Zebra object name for a font file: the bare filename, upper-cased,
    valid only as 8.3 `NAME.TTF` (letters, digits, underscore)."""
    name = PurePosixPath(filename or "").name.upper()
    return name if FONT_NAME_RE.match(name) else None


def _person_display(preferred: str | None, first: str | None, last: str | None) -> str | None:
    full = " ".join(p for p in (first, last) if p).strip()
    return preferred or full or None


async def _fonts_used_by(db: DbSession) -> dict[str, list[LabelFontUsedByOut]]:
    """Map upper-cased `E:<NAME>` references found in active code templates
    → the templates that carry them (templates are few; a scan is fine)."""
    rows = (await db.execute(
        select(LabelTemplate.id, LabelTemplate.name, LabelTemplate.code)
        .where(LabelTemplate.is_active == True, LabelTemplate.code.isnot(None)))).all()  # noqa: E712
    out: dict[str, list[LabelFontUsedByOut]] = {}
    for tpl_id, tpl_name, code in rows:
        for ref in re.findall(r"E:([A-Z0-9_]{1,8}\.TTF)", (code or "").upper()):
            out.setdefault(ref, []).append(LabelFontUsedByOut(template_id=tpl_id, template_name=tpl_name))
    return out


def _font_out(font: LabelFont, uploader: str | None, used_by: list[LabelFontUsedByOut]) -> LabelFontOut:
    return LabelFontOut(
        id=font.id, name=font.name, display_name=font.display_name, size_bytes=font.size_bytes,
        content_type=font.content_type, uploaded_by=font.uploaded_by, uploaded_by_name=uploader,
        created_at=font.created_at, used_by=used_by)


async def _font_or_404(db: DbSession, font_id: uuid.UUID) -> LabelFont:
    font = await db.get(LabelFont, font_id)
    if font is None or font.deleted_at is not None:
        raise _err(404, "font_not_found")
    return font


@router.get("/fonts", response_model=list[LabelFontOut])
async def list_label_fonts(
    db: DbSession, _actor: AuthContext = require_permission("labels", "view"),
) -> list[LabelFontOut]:
    rows = (await db.execute(
        select(LabelFont, Person.preferred_name, Person.first_name, Person.last_name)
        .outerjoin(Person, Person.id == LabelFont.uploaded_by)
        .where(LabelFont.deleted_at.is_(None))
        .order_by(LabelFont.name))).all()
    used = await _fonts_used_by(db)
    return [_font_out(f, _person_display(p, fn, ln), used.get(f.name.upper(), []))
            for f, p, fn, ln in rows]


@router.post("/fonts", response_model=LabelFontOut, status_code=201)
async def upload_label_font(
    db: DbSession,
    file: Annotated[UploadFile, File()],
    name: Annotated[str | None, Form()] = None,
    actor: AuthContext = require_permission("labels", "add"),
) -> LabelFontOut:
    object_name = font_object_name(name) if name else font_object_name(file.filename)
    if object_name is None:
        raise _err(422, "invalid_font_name")
    data = await file.read()
    if len(data) == 0:
        raise _err(422, "empty_file")
    if len(data) > MAX_FONT_BYTES:
        raise _err(413, "file_too_large")
    if not data.startswith(TRUETYPE_MAGICS):
        raise _err(422, "not_a_truetype_font")
    taken = await db.scalar(select(LabelFont.id).where(
        LabelFont.name == object_name, LabelFont.deleted_at.is_(None)))
    if taken is not None:
        raise _err(409, "font_name_taken")

    key = f"label-fonts/{uuid.uuid4()}.ttf"
    await put_object(key, data, "font/ttf")
    font = LabelFont(name=object_name, display_name=file.filename or object_name,
                     storage_key=key, size_bytes=len(data), content_type="font/ttf",
                     uploaded_by=actor.person.id)
    db.add(font)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="label_font", entity_id=str(font.id),
          action="create", changes={"name": {"from": None, "to": object_name},
                                    "size_bytes": {"from": None, "to": len(data)}})
    await db.commit()
    await db.refresh(font)
    used = await _fonts_used_by(db)
    uploader = _person_display(actor.person.preferred_name, actor.person.first_name,
                               actor.person.last_name)
    return _font_out(font, uploader, used.get(object_name, []))


@router.delete("/fonts/{font_id}", status_code=204)
async def delete_label_font(
    font_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("labels", "delete"),
) -> None:
    font = await _font_or_404(db, font_id)
    font.deleted_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="label_font", entity_id=str(font.id),
          action="delete", changes={"name": {"from": font.name, "to": None}})
    await db.commit()


@router.get("/fonts/{font_id}/content")
async def label_font_content(
    font_id: uuid.UUID, db: DbSession,
    _actor: AuthContext = require_permission("labels", "view"),
) -> Response:
    """The raw TTF bytes — the browser pushes them to the printer over
    WebUSB (`~DY`), so it needs the bytes, not a presigned URL."""
    font = await _font_or_404(db, font_id)
    data = await get_object(font.storage_key)
    return Response(content=data, media_type=font.content_type,
                    headers={"Content-Disposition": f'attachment; filename="{font.name}"'})
```

`Response` is already imported from fastapi in this file; `Person` is already in the models import. If `AuthContext.person` lacks `preferred_name`/`first_name`/`last_name` attributes, load the Person row by `actor.person.id` instead.

- [ ] **Step 7: Run the tests, then the head check**

Run: `SS_TEST_DB=serversherpa_test_zebra PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest tests/test_label_fonts_api.py tests/test_labels_templates_api.py -q -x` plus whichever test asserts a single alembic head (`grep -rln "heads()" tests | head`).
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add api/migrations/versions/0060_label_fonts.py api/src/serversherpa/db/models.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/labels.py api/tests/test_label_fonts_api.py
git commit -m "feat(labels): font library — label_fonts table (0060) + /labels/fonts list/upload/delete/content

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Portal font client

**Files:**
- Modify: `portal/src/lib/api.ts` (after `convertLabelTemplate`)
- Test: `portal/src/lib/api.labelFonts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LabelFontUsedBy { template_id: string; template_name: string }
  export interface LabelFont { id: string; name: string; display_name: string; size_bytes: number; content_type: string; uploaded_by: string | null; uploaded_by_name: string | null; created_at: string; used_by: LabelFontUsedBy[] }
  export async function listLabelFonts(): Promise<LabelFont[]>
  export async function uploadLabelFont(file: File, name?: string): Promise<LabelFont>
  export async function deleteLabelFont(id: string): Promise<void>
  export async function getLabelFontBytes(id: string): Promise<Uint8Array>
  ```

- [ ] **Step 1: Write the failing test**

```ts
// portal/src/lib/api.labelFonts.test.ts
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { ApiError, deleteLabelFont, getLabelFontBytes, listLabelFonts, uploadLabelFont, type LabelFont } from './api';

afterEach(() => vi.unstubAllGlobals());

const font: LabelFont = {
  id: 'f1', name: '85620388.TTF', display_name: 'swiss.ttf', size_bytes: 1024, content_type: 'font/ttf',
  uploaded_by: 'p1', uploaded_by_name: 'Jimmy', created_at: '2026-09-12T00:00:00Z',
  used_by: [{ template_id: 't1', template_name: 'Front Asset Tag' }],
};

it('lists fonts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([font]), { status: 200 })));
  expect(await listLabelFonts()).toEqual([font]);
});

it('uploads as multipart with the optional name', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(font), { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
  const file = new File([new Uint8Array([0, 1, 0, 0])], 'swiss.ttf', { type: 'font/ttf' });
  expect(await uploadLabelFont(file, '85620388.TTF')).toEqual(font);
  const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/labels/fonts')) as [string, RequestInit];
  expect(url).toContain('/labels/fonts');
  expect(init.method).toBe('POST');
  const body = init.body as FormData;
  expect(body.get('name')).toBe('85620388.TTF');
  expect((body.get('file') as File).name).toBe('swiss.ttf');
});

it('deletes and downloads bytes', async () => {
  const fetchMock = vi.fn(async (url: string) => String(url).endsWith('/content')
    ? new Response(new Uint8Array([0, 1, 0, 0, 9]), { status: 200 })
    : new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  await deleteLabelFont('f1');
  expect(String(fetchMock.mock.calls[0][0])).toContain('/labels/fonts/f1');
  const bytes = await getLabelFontBytes('f1');
  expect(Array.from(bytes)).toEqual([0, 1, 0, 0, 9]);
});

it('surfaces API errors', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: { code: 'font_name_taken' } }), { status: 409 })));
  await expect(uploadLabelFont(new File([''], 'x.ttf'))).rejects.toBeInstanceOf(ApiError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/api.labelFonts.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Implement**

Append after `convertLabelTemplate` in `portal/src/lib/api.ts`:

```ts
// ── Label font library (Labels → Printers › Install Fonts) ───────────

export interface LabelFontUsedBy { template_id: string; template_name: string }

/** A TrueType font admins uploaded once; `name` is the Zebra object name
 *  it installs under on the printer's E: drive. */
export interface LabelFont {
  id: string; name: string; display_name: string; size_bytes: number; content_type: string;
  uploaded_by: string | null; uploaded_by_name: string | null; created_at: string;
  used_by: LabelFontUsedBy[];
}

export async function listLabelFonts(): Promise<LabelFont[]> {
  const resp = await apiFetch('/labels/fonts');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function uploadLabelFont(file: File, name?: string): Promise<LabelFont> {
  const form = new FormData();
  form.set('file', file);
  if (name) form.set('name', name);
  const resp = await apiFetch('/labels/fonts', { method: 'POST', body: form });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteLabelFont(id: string): Promise<void> {
  const resp = await apiFetch(`/labels/fonts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

/** The TTF bytes, for pushing to a printer over WebUSB. */
export async function getLabelFontBytes(id: string): Promise<Uint8Array> {
  const resp = await apiFetch(`/labels/fonts/${encodeURIComponent(id)}/content`);
  if (!resp.ok) throw await errorFrom(resp);
  return new Uint8Array(await resp.arrayBuffer());
}
```

- [ ] **Step 4: Run the test + tsc**

Run: `npx vitest run src/lib/api.labelFonts.test.ts && npx tsc -b` → PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/api.labelFonts.test.ts
git commit -m "feat(portal): label font library client (list/upload/delete/bytes)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Command builders — `labels/zebraCommands.ts`

**Files:**
- Create: `portal/src/labels/zebraCommands.ts`
- Test: `portal/src/labels/zebraCommands.test.ts`

**Interfaces:**
- Produces (exact exports):
  ```ts
  export const HOST_IDENTIFICATION = '~HI'; export const HOST_STATUS = '~HS';
  export const CALIBRATE = '~JC'; export const PRINT_CONFIGURATION_LABEL = '~WC';
  export const SAVE_SETTINGS = '^XA^JUS^XZ'; export const FACTORY_DEFAULTS = '^XA^JUF^XZ';
  export function configurationQuery(): string            // '^XA^HH^XZ'
  export function directoryQuery(drive = 'E'): string      // '^XA^HWE:*.*^XZ'
  export function deleteObject(drive: string, name: string): string   // '^XA^IDE:NAME.TTF^XZ'
  export function downloadFontHeader(drive: string, name: string, totalBytes: number): string // '~DYE:NAME.TTF,B,T,<n>,,'
  export function setDarkness(n: number): string            // '~SD07' (clamped 0–30, 2 digits)
  export function setPrintSpeed(ips: number): string        // '^XA^PR6^XZ' (clamped 2–14, integer)
  export type MediaTracking = 'W' | 'M' | 'N' | 'A'; export type PrintMode = 'T' | 'P' | 'C' | 'R'; export type PrintMethod = 'D' | 'T';
  export function setMediaTracking(m: MediaTracking): string   // '^XA^MNW^XZ'
  export function setPrintMode(m: PrintMode): string           // '^XA^MMT^XZ'
  export function setPrintMethod(m: PrintMethod): string       // '^XA^MTD^XZ'
  export function setLabelSize(widthDots: number, lengthDots: number): string // '^XA^PW812^LL406^XZ'
  export function fontObjectName(filename: string): string | null   // upper-cased 8.3 NAME.TTF or null
  export function isTrueType(bytes: Uint8Array): boolean
  export function dpiFromDotsPerMm(dpmm: number): number    // 6→150, 8→203, 12→300, 24→600, else round(dpmm*25.4)
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// portal/src/labels/zebraCommands.test.ts
import { describe, expect, it } from 'vitest';

import {
  CALIBRATE, FACTORY_DEFAULTS, HOST_IDENTIFICATION, HOST_STATUS, PRINT_CONFIGURATION_LABEL, SAVE_SETTINGS,
  configurationQuery, deleteObject, directoryQuery, downloadFontHeader, dpiFromDotsPerMm, fontObjectName,
  isTrueType, setDarkness, setLabelSize, setMediaTracking, setPrintMethod, setPrintMode, setPrintSpeed,
} from './zebraCommands';

describe('command strings', () => {
  it('constants', () => {
    expect(HOST_IDENTIFICATION).toBe('~HI');
    expect(HOST_STATUS).toBe('~HS');
    expect(CALIBRATE).toBe('~JC');
    expect(PRINT_CONFIGURATION_LABEL).toBe('~WC');
    expect(SAVE_SETTINGS).toBe('^XA^JUS^XZ');
    expect(FACTORY_DEFAULTS).toBe('^XA^JUF^XZ');
  });
  it('queries and object commands', () => {
    expect(configurationQuery()).toBe('^XA^HH^XZ');
    expect(directoryQuery()).toBe('^XA^HWE:*.*^XZ');
    expect(directoryQuery('R')).toBe('^XA^HWR:*.*^XZ');
    expect(deleteObject('E', '85620388.TTF')).toBe('^XA^IDE:85620388.TTF^XZ');
    expect(downloadFontHeader('E', '85620388.TTF', 124336)).toBe('~DYE:85620388.TTF,B,T,124336,,');
  });
  it('settings with clamping', () => {
    expect(setDarkness(7)).toBe('~SD07');
    expect(setDarkness(30)).toBe('~SD30');
    expect(setDarkness(45)).toBe('~SD30');
    expect(setDarkness(-2)).toBe('~SD00');
    expect(setDarkness(12.6)).toBe('~SD13');
    expect(setPrintSpeed(6)).toBe('^XA^PR6^XZ');
    expect(setPrintSpeed(1)).toBe('^XA^PR2^XZ');
    expect(setPrintSpeed(99)).toBe('^XA^PR14^XZ');
    expect(setMediaTracking('W')).toBe('^XA^MNW^XZ');
    expect(setPrintMode('P')).toBe('^XA^MMP^XZ');
    expect(setPrintMethod('D')).toBe('^XA^MTD^XZ');
    expect(setLabelSize(812, 406)).toBe('^XA^PW812^LL406^XZ');
  });
});

describe('font helpers', () => {
  it('validates Zebra 8.3 object names', () => {
    expect(fontObjectName('85620388.ttf')).toBe('85620388.TTF');
    expect(fontObjectName('/tmp/tt0003m_.TTF')).toBe('TT0003M_.TTF');
    expect(fontObjectName('longername.ttf')).toBeNull();
    expect(fontObjectName('a.otf')).toBeNull();
    expect(fontObjectName('bad name.ttf')).toBeNull();
    expect(fontObjectName('')).toBeNull();
  });
  it('sniffs TrueType magics', () => {
    expect(isTrueType(new Uint8Array([0, 1, 0, 0, 5]))).toBe(true);
    expect(isTrueType(new TextEncoder().encode('true\x00'))).toBe(true);
    expect(isTrueType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isTrueType(new Uint8Array([]))).toBe(false);
  });
  it('maps dots per mm to DPI', () => {
    expect(dpiFromDotsPerMm(6)).toBe(150);
    expect(dpiFromDotsPerMm(8)).toBe(203);
    expect(dpiFromDotsPerMm(12)).toBe(300);
    expect(dpiFromDotsPerMm(24)).toBe(600);
    expect(dpiFromDotsPerMm(10)).toBe(254);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/labels/zebraCommands.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// portal/src/labels/zebraCommands.ts
/**
 * ZPL command builders for the Printers page tools (identity/status
 * queries, E: object management, media/quality settings, save/reset) and
 * the font-file helpers the Install Fonts flow shares with the API's
 * validation. Pure strings — the transport (`zebraUsb.ts`) sends them.
 */

export const HOST_IDENTIFICATION = '~HI';
export const HOST_STATUS = '~HS';
export const CALIBRATE = '~JC';
export const PRINT_CONFIGURATION_LABEL = '~WC';
export const SAVE_SETTINGS = '^XA^JUS^XZ';
export const FACTORY_DEFAULTS = '^XA^JUF^XZ';

export const configurationQuery = (): string => '^XA^HH^XZ';
export const directoryQuery = (drive = 'E'): string => `^XA^HW${drive}:*.*^XZ`;
export const deleteObject = (drive: string, name: string): string => `^XA^ID${drive}:${name}^XZ`;

/** `~DYd:name,B,T,<bytes>,,` — binary TrueType download; the file bytes
 *  follow the header on the same stream. */
export const downloadFontHeader = (drive: string, name: string, totalBytes: number): string =>
  `~DY${drive}:${name},B,T,${totalBytes},,`;

const clampInt = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(n)));

export const setDarkness = (n: number): string => `~SD${String(clampInt(n, 0, 30)).padStart(2, '0')}`;
export const setPrintSpeed = (ips: number): string => `^XA^PR${clampInt(ips, 2, 14)}^XZ`;

export type MediaTracking = 'W' | 'M' | 'N' | 'A';
export type PrintMode = 'T' | 'P' | 'C' | 'R';
export type PrintMethod = 'D' | 'T';

export const setMediaTracking = (m: MediaTracking): string => `^XA^MN${m}^XZ`;
export const setPrintMode = (m: PrintMode): string => `^XA^MM${m}^XZ`;
export const setPrintMethod = (m: PrintMethod): string => `^XA^MT${m}^XZ`;
export const setLabelSize = (widthDots: number, lengthDots: number): string =>
  `^XA^PW${Math.round(widthDots)}^LL${Math.round(lengthDots)}^XZ`;

const FONT_NAME_RE = /^[A-Z0-9_]{1,8}\.TTF$/;

/** Zebra object name for a font file: bare filename, upper-cased, only
 *  valid as 8.3 `NAME.TTF` (letters, digits, underscore). */
export function fontObjectName(filename: string): string | null {
  const bare = filename.split(/[\\/]/).pop() ?? '';
  const name = bare.toUpperCase();
  return FONT_NAME_RE.test(name) ? name : null;
}

export function isTrueType(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const b = bytes.subarray(0, 4);
  return (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)
    || (b[0] === 0x74 && b[1] === 0x72 && b[2] === 0x75 && b[3] === 0x65); // 'true'
}

/** `~HI` reports dots per millimeter; Zebra's nominal DPIs are the usual
 *  203/300/600 rather than the exact conversion. */
export function dpiFromDotsPerMm(dpmm: number): number {
  const nominal: Record<number, number> = { 6: 150, 8: 203, 12: 300, 24: 600 };
  return nominal[dpmm] ?? Math.round(dpmm * 25.4);
}
```

- [ ] **Step 4: Run + tsc** → PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add portal/src/labels/zebraCommands.ts portal/src/labels/zebraCommands.test.ts
git commit -m "feat(portal): ZPL command builders and font-name/TrueType helpers for the printer tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Transport additions — `readText`, `query`, `sendBytes`, parsers

**Files:**
- Modify: `portal/src/labels/zebraUsb.ts`
- Modify: `portal/src/labels/zebraUsb.test.ts` (append a new `describe` block; existing tests stay green)

**Interfaces:**
- Produces (exact exports, added to the existing ones):
  ```ts
  export interface ReadOptions { firstTimeoutMs?: number; drainTimeoutMs?: number; maxReads?: number }
  export function readText(device: UsbDeviceLike, opts?: ReadOptions, clock?: Clock): Promise<string>   // '' when nothing arrives / no bulk IN
  export function query(device: UsbDeviceLike, command: string, opts?: ReadOptions, clock?: Clock): Promise<string>
  export function sendBytes(device: UsbDeviceLike, bytes: Uint8Array, opts?: { chunkSize?: number; onProgress?: (sent: number, total: number) => void }): Promise<void>
  export interface HostIdentification { model: string; firmware: string; dotsPerMm: number; memory: string; dpi: number }
  export function parseHostIdentification(text: string): HostIdentification | null
  export interface HostStatus { paperOut: boolean; paused: boolean; labelLength: number; formatsQueued: number; bufferFull: boolean; partialFormat: boolean; corruptRam: boolean; underTemp: boolean; overTemp: boolean; headOpen: boolean; ribbonOut: boolean; thermalTransfer: boolean; printMode: string; labelWaiting: boolean; labelsRemaining: number }
  export function parseHostStatus(text: string): HostStatus | null
  export interface DirectoryListing { objects: { name: string; bytes: number }[]; bytesFree: number | null }
  export function parseDirectory(text: string): DirectoryListing | null
  export interface PrinterConfiguration { darkness: number | null; printSpeed: number | null; tearOff: number | null; printMode: string | null; mediaType: string | null; printMethod: string | null; printWidth: number | null; labelLength: number | null; firmware: string | null; raw: Record<string, string> }
  export function parseConfiguration(text: string): PrinterConfiguration | null
  ```
  `queryQueuedFormats` is re-implemented on top of `query('~HS', { firstTimeoutMs: 2000, drainTimeoutMs: 250, maxReads: 4 })` with identical observable behavior (the existing tests prove it). `dpi` comes from `dpiFromDotsPerMm` (Task 3).

- [ ] **Step 1: Append the failing tests** to `zebraUsb.test.ts` (the `FakeDevice` and `instantClock` helpers already exist there; `FakeDevice.responses` is keyed to `~HS` writes — extend it so ANY transferOut whose text starts with `~H`, `^XA^HH`, or `^XA^HW` pops the next response: change the `if (text === '~HS')` line to `if (/^(~H|\^XA\^H)/.test(text))`):

```ts
import { dpiFromDotsPerMm } from './zebraCommands';
import {
  parseConfiguration, parseDirectory, parseHostIdentification, parseHostStatus, query, readText, sendBytes,
} from './zebraUsb';

const HI = '\x02ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\x03';
const HS = '\x02030,1,0,1245,003,0,0,0,000,0,0,1\x03\r\n\x02000,0,1,0,0,2,4,0,00000012,1,000\x03\r\n\x021234,0\x03';
const HW = '\x02- DIR E:*.*\r\n* 85620388.TTF       124336\r\n* TT0003M_.TTF      169188\r\n-1928576 bytes free E: ONBOARD FLASH\r\n\x03';
const HH = [
  '\x02', '+10.0               DARKNESS', '6.0 IPS             PRINT SPEED', '+000                TEAR OFF',
  'TEAR OFF            PRINT MODE', 'GAP/NOTCH           MEDIA TYPE', 'DIRECT-THERMAL      PRINT METHOD',
  '812                 PRINT WIDTH', '1218                LABEL LENGTH', 'V72.19.15Z <-       FIRMWARE',
  'NORMAL MODE         PRINT MODE FLAG', '\x03',
].join('\r\n');

describe('readText / query / sendBytes', () => {
  it('reads the first packet and drains the rest, returning everything', async () => {
    const dev = new FakeDevice(); dev.opened = true;
    dev.responses = [['\x02abc', 'def\x03']];
    expect(await query(dev, '~HI', {}, instantClock())).toBe('\x02abcdef\x03');
    expect(dev.sent).toEqual(['~HI']);
  });
  it('returns an empty string when nothing arrives or there is no bulk IN', async () => {
    const silent = new FakeDevice(); silent.opened = true;
    expect(await readText(silent, {}, instantClock())).toBe('');
    const noIn = new FakeDevice([{ direction: 'out', type: 'bulk' }]); noIn.opened = true;
    expect(await readText(noIn, {}, instantClock())).toBe('');
  });
  it('sends bytes in chunks and reports progress', async () => {
    const dev = new FakeDevice(); dev.opened = true;
    const bytes = new Uint8Array(150_000).map((_, i) => i % 251);
    const progress: [number, number][] = [];
    await sendBytes(dev, bytes, { chunkSize: 65536, onProgress: (s, t) => progress.push([s, t]) });
    expect(dev.sentBytes.map((b) => b.length)).toEqual([65536, 65536, 18928]);
    expect(progress).toEqual([[65536, 150000], [131072, 150000], [150000, 150000]]);
    expect(Buffer.concat(dev.sentBytes.map((b) => Buffer.from(b)))).toEqual(Buffer.from(bytes));
  });
});

describe('parsers', () => {
  it('parses ~HI', () => {
    expect(parseHostIdentification(HI)).toEqual({ model: 'ZD421-203dpi ZPL', firmware: 'V92.21.16Z', dotsPerMm: 8, memory: '8192KB', dpi: dpiFromDotsPerMm(8) });
    expect(parseHostIdentification('garbage')).toBeNull();
    expect(parseHostIdentification('')).toBeNull();
  });
  it('parses the three ~HS strings', () => {
    const s = parseHostStatus(HS)!;
    expect(s.paperOut).toBe(true); expect(s.paused).toBe(false); expect(s.labelLength).toBe(1245);
    expect(s.formatsQueued).toBe(3); expect(s.bufferFull).toBe(false); expect(s.overTemp).toBe(true);
    expect(s.underTemp).toBe(false); expect(s.headOpen).toBe(true); expect(s.ribbonOut).toBe(false);
    expect(s.thermalTransfer).toBe(false); expect(s.printMode).toBe('2'); expect(s.labelsRemaining).toBe(12);
    expect(parseHostStatus('\x02030,0\x03')).toBeNull();
    expect(parseHostStatus('')).toBeNull();
  });
  it('parses an E: directory listing', () => {
    expect(parseDirectory(HW)).toEqual({ objects: [{ name: '85620388.TTF', bytes: 124336 }, { name: 'TT0003M_.TTF', bytes: 169188 }], bytesFree: 1928576 });
    expect(parseDirectory('\x02- DIR E:*.*\r\n-2000000 bytes free E:\x03')).toEqual({ objects: [], bytesFree: 2000000 });
    expect(parseDirectory('')).toBeNull();
  });
  it('parses ^HH configuration', () => {
    const c = parseConfiguration(HH)!;
    expect(c.darkness).toBe(10); expect(c.printSpeed).toBe(6); expect(c.tearOff).toBe(0);
    expect(c.printMode).toBe('TEAR OFF'); expect(c.mediaType).toBe('GAP/NOTCH'); expect(c.printMethod).toBe('DIRECT-THERMAL');
    expect(c.printWidth).toBe(812); expect(c.labelLength).toBe(1218); expect(c.firmware).toBe('V72.19.15Z');
    expect(c.raw['PRINT MODE FLAG']).toBe('NORMAL MODE');
    expect(parseConfiguration('')).toBeNull();
    expect(parseConfiguration('no labels here')).toBeNull();
  });
});
```

Add `sentBytes: Uint8Array[] = []` to `FakeDevice` and push `new Uint8Array(data as ArrayBuffer | ArrayBufferView)` copies in `transferOut` (keep `sent` for the decoded text).

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/labels/zebraUsb.test.ts` → new exports missing.

- [ ] **Step 3: Implement** (add to `zebraUsb.ts`; import `dpiFromDotsPerMm` from `./zebraCommands`)

```ts
export interface ReadOptions { firstTimeoutMs?: number; drainTimeoutMs?: number; maxReads?: number }

/** Read whatever the printer sends back: one read with a longer timeout,
 *  then short drain reads until one times out or `maxReads` is reached.
 *  '' when there is no bulk IN endpoint or nothing arrives. */
export async function readText(
  device: UsbDeviceLike, { firstTimeoutMs = 2000, drainTimeoutMs = 250, maxReads = 8 }: ReadOptions = {},
  clock: Clock = realClock,
): Promise<string> {
  const { in: inEp } = findBulkEndpoints(device);
  if (!inEp) return '';
  const readWithTimeout = (ms: number) => Promise.race([
    device.transferIn(inEp.endpointNumber, 4096),
    clock.sleep(ms).then(() => { throw new Error('read timeout'); }),
  ]);
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < maxReads; i++) {
    try {
      const r = await readWithTimeout(i === 0 ? firstTimeoutMs : drainTimeoutMs);
      text += decoder.decode(r.data);
    } catch {
      break;
    }
  }
  return text;
}

export async function query(
  device: UsbDeviceLike, command: string, opts: ReadOptions = {}, clock: Clock = realClock,
): Promise<string> {
  await sendRaw(device, command);
  return readText(device, opts, clock);
}

/** Chunked bulk OUT for object downloads (`~DY` + TTF bytes). */
export async function sendBytes(
  device: UsbDeviceLike, bytes: Uint8Array,
  { chunkSize = 65536, onProgress }: { chunkSize?: number; onProgress?: (sent: number, total: number) => void } = {},
): Promise<void> {
  await ensureOpen(device);
  const { out } = findBulkEndpoints(device);
  if (!out) throw new Error('Could not find printer output endpoint');
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    await device.transferOut(out.endpointNumber, chunk);
    onProgress?.(Math.min(offset + chunkSize, bytes.length), bytes.length);
  }
}

const strip = (text: string) => text.replace(/[\x02\x03]/g, '');

export interface HostIdentification { model: string; firmware: string; dotsPerMm: number; memory: string; dpi: number }

/** `~HI` → `<STX>model,firmware,dotsPerMm,memory[,x]<ETX>`. */
export function parseHostIdentification(text: string): HostIdentification | null {
  const body = strip(text).trim();
  const parts = body.split(',').map((p) => p.trim());
  if (parts.length < 4) return null;
  const dotsPerMm = parseInt(parts[2], 10);
  if (!parts[0] || Number.isNaN(dotsPerMm)) return null;
  return { model: parts[0], firmware: parts[1], dotsPerMm, memory: parts[3], dpi: dpiFromDotsPerMm(dotsPerMm) };
}

export interface HostStatus {
  paperOut: boolean; paused: boolean; labelLength: number; formatsQueued: number; bufferFull: boolean;
  partialFormat: boolean; corruptRam: boolean; underTemp: boolean; overTemp: boolean;
  headOpen: boolean; ribbonOut: boolean; thermalTransfer: boolean; printMode: string;
  labelWaiting: boolean; labelsRemaining: number;
}

/** `~HS` string 1 `aaa,b,c,dddd,eee,f,g,h,iii,j,k,l` and string 2
 *  `mmm,n,o,p,q,r,s,t,uuuuuuuu,v,www` (ZPL manual field order). */
export function parseHostStatus(text: string): HostStatus | null {
  const strings = text.split('\x02').slice(1).map((s) => s.split('\x03')[0].split(','));
  const s1 = strings[0];
  const s2 = strings[1] ?? [];
  if (!s1 || s1.length < 12) return null;
  const flag = (v: string | undefined) => v?.trim() === '1';
  const int = (v: string | undefined) => { const n = parseInt(v ?? '', 10); return Number.isNaN(n) ? 0 : n; };
  return {
    paperOut: flag(s1[1]), paused: flag(s1[2]), labelLength: int(s1[3]), formatsQueued: int(s1[4]),
    bufferFull: flag(s1[5]), partialFormat: flag(s1[7]), corruptRam: flag(s1[9]),
    underTemp: flag(s1[10]), overTemp: flag(s1[11]),
    headOpen: flag(s2[2]), ribbonOut: flag(s2[3]), thermalTransfer: flag(s2[4]),
    printMode: (s2[5] ?? '').trim(), labelWaiting: flag(s2[7]), labelsRemaining: int(s2[8]),
  };
}

export interface DirectoryListing { objects: { name: string; bytes: number }[]; bytesFree: number | null }

/** `^HW` → `- DIR E:*.*` header, `* NAME.EXT <bytes>` rows, `-<n> bytes free` trailer. */
export function parseDirectory(text: string): DirectoryListing | null {
  const body = strip(text);
  if (!/DIR\s+\w:/i.test(body)) return null;
  const objects: { name: string; bytes: number }[] = [];
  let bytesFree: number | null = null;
  for (const line of body.split(/\r?\n/)) {
    const obj = line.match(/^\s*\*?\s*([A-Z0-9_]{1,8}\.[A-Z0-9]{1,3})\s+(\d+)\s*$/i);
    if (obj) { objects.push({ name: obj[1].toUpperCase(), bytes: parseInt(obj[2], 10) }); continue; }
    const free = line.match(/(\d+)\s+bytes free/i);
    if (free) bytesFree = parseInt(free[1], 10);
  }
  return { objects, bytesFree };
}

export interface PrinterConfiguration {
  darkness: number | null; printSpeed: number | null; tearOff: number | null; printMode: string | null;
  mediaType: string | null; printMethod: string | null; printWidth: number | null; labelLength: number | null;
  firmware: string | null; raw: Record<string, string>;
}

/** `^HH` → lines of `<value>   <LABEL>`; labels are upper-case words. */
export function parseConfiguration(text: string): PrinterConfiguration | null {
  const raw: Record<string, string> = {};
  for (const line of strip(text).split(/\r?\n/)) {
    const m = line.trim().match(/^(.*?)\s{2,}([A-Z][A-Z0-9 ./-]*[A-Z0-9])$/);
    if (m) raw[m[2]] = m[1].trim();
  }
  if (Object.keys(raw).length === 0) return null;
  const num = (label: string) => { const v = raw[label]; if (v === undefined) return null; const n = parseFloat(v); return Number.isNaN(n) ? null : n; };
  const str = (label: string) => raw[label] ?? null;
  return {
    darkness: num('DARKNESS'), printSpeed: num('PRINT SPEED'), tearOff: num('TEAR OFF'),
    printMode: str('PRINT MODE'), mediaType: str('MEDIA TYPE'), printMethod: str('PRINT METHOD'),
    printWidth: num('PRINT WIDTH'), labelLength: num('LABEL LENGTH'),
    firmware: raw.FIRMWARE ? raw.FIRMWARE.replace(/\s*<-\s*$/, '') : null, raw,
  };
}
```

Then replace `queryQueuedFormats`'s body with:

```ts
export async function queryQueuedFormats(device: UsbDeviceLike, clock: Clock = realClock): Promise<number | null> {
  if (!device.opened) return null;
  const { in: inEp, out: outEp } = findBulkEndpoints(device);
  if (!inEp || !outEp) return null;
  try {
    const text = await query(device, '~HS', { firstTimeoutMs: 2000, drainTimeoutMs: 250, maxReads: 4 }, clock);
    return text ? parseHostStatusQueued(text) : null;
  } catch {
    return null;
  }
}
```

(`readText`'s first read hangs → `''` → `null`, matching the old timeout → `null`.)

- [ ] **Step 4: Run the whole transport test file + tsc** — `npx vitest run src/labels/zebraUsb.test.ts && npx tsc -b` → all pass incl. the pre-existing `~HS`/`waitForPrinterIdle` cases.

- [ ] **Step 5: Commit**

```bash
git add portal/src/labels/zebraUsb.ts portal/src/labels/zebraUsb.test.ts
git commit -m "feat(portal): zebraUsb readText/query/sendBytes + ~HI/~HS/^HW/^HH parsers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Hook additions — `query`, `sendBytes`, `identify`, `status`, known devices, log

**Files:**
- Modify: `portal/src/lib/useZebraPrinter.ts`, `portal/src/lib/useZebraPrinter.test.tsx` (append tests; the fake device there needs a `transferIn` that can answer — reuse the `responses`/pending pattern from `zebraUsb.test.ts`, or give `fakeDevice()` an optional `reply` string returned once by `transferIn` then hang).

**Interfaces:**
- Produces (added to `ZebraPrinter`):
  ```ts
  export interface PrinterLogEntry { at: string; command: string; response: string }
  query(command: string, opts?: ReadOptions): Promise<string>
  sendBytes(bytes: Uint8Array, onProgress?: (sent: number, total: number) => void): Promise<void>
  identify(): Promise<HostIdentification | null>
  status(): Promise<HostStatus | null>
  knownDevices(): Promise<UsbDeviceLike[]>        // navigator.usb.getDevices(), [] when unsupported
  connectTo(device: UsbDeviceLike): Promise<void>  // open a known device without the chooser
  log: PrinterLogEntry[]; clearLog(): void          // capped at 200, newest last
  ```
  `UsbApi` gains `getDevices?: () => Promise<UsbDeviceLike[]>`. Every `send`/`query`/`sendBytes` appends a log entry (`command` truncated to 200 chars; bytes logged as `<N bytes>`; `response` truncated to 2000 chars, `''` for sends).

- [ ] **Step 1: Append the failing tests**

```tsx
describe('printer tools additions', () => {
  it('query sends the command, returns the reply, and logs both', async () => {
    const dev = fakeDevice(); dev.reply = '\x02ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\x03';
    const usb = fakeUsb(dev);
    const { result } = renderHook(() => useZebraPrinter(usb));
    await act(async () => { await result.current.connect(); });
    let text = '';
    await act(async () => { text = await result.current.query('~HI'); });
    expect(text).toContain('ZD421');
    expect(result.current.log.at(-1)).toMatchObject({ command: '~HI' });
    expect(result.current.log.at(-1)?.response).toContain('ZD421');
    let id: unknown = null;
    dev.reply = '\x02ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\x03';
    await act(async () => { id = await result.current.identify(); });
    expect(id).toMatchObject({ model: 'ZD421-203dpi ZPL', dpi: 203 });
  });
  it('sendBytes forwards chunks and logs a byte count', async () => {
    const dev = fakeDevice(); const usb = fakeUsb(dev);
    const { result } = renderHook(() => useZebraPrinter(usb));
    await act(async () => { await result.current.connect(); });
    await act(async () => { await result.current.sendBytes(new Uint8Array(10)); });
    expect(dev.log.filter((l) => l.startsWith('out:')).length).toBeGreaterThan(0);
    expect(result.current.log.at(-1)?.command).toBe('<10 bytes>');
  });
  it('lists known devices and connects to one without the chooser', async () => {
    const dev = fakeDevice('ZD621'); const usb = fakeUsb(dev);
    usb.getDevices = vi.fn(async () => [dev]);
    const { result } = renderHook(() => useZebraPrinter(usb));
    let known: unknown[] = [];
    await act(async () => { known = await result.current.knownDevices(); });
    expect(known).toEqual([dev]);
    await act(async () => { await result.current.connectTo(dev); });
    expect(result.current.connected).toBe(true);
    expect(usb.requestDevice).not.toHaveBeenCalled();
    expect(result.current.productName).toBe('ZD621');
  });
  it('caps the log at 200 entries and clears it', async () => {
    const dev = fakeDevice(); const usb = fakeUsb(dev);
    const { result } = renderHook(() => useZebraPrinter(usb));
    await act(async () => { await result.current.connect(); });
    for (let i = 0; i < 205; i++) await act(async () => { await result.current.send(`^XA^FD${i}^FS^XZ`); });
    expect(result.current.log.length).toBe(200);
    expect(result.current.log[0].command).toBe('^XA^FD5^FS^XZ');
    act(() => result.current.clearLog());
    expect(result.current.log).toEqual([]);
  });
});
```

Adjust `fakeDevice()` in that file: add `reply: string | null = null` and make `transferIn` return `reply` once (as a DataView) then hang; `fakeUsb` gets an optional `getDevices`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/useZebraPrinter.test.tsx`.

- [ ] **Step 3: Implement** — in `useZebraPrinter.ts`: import `query as usbQuery, sendBytes as usbSendBytes, parseHostIdentification, parseHostStatus, type HostIdentification, type HostStatus, type ReadOptions` from `../labels/zebraUsb` and `HOST_IDENTIFICATION, HOST_STATUS` from `../labels/zebraCommands`; add the types/fields above; keep a `const [log, setLog] = useState<PrinterLogEntry[]>([])` with `const record = useCallback((command: string, response: string) => setLog((l) => [...l, { at: new Date().toISOString(), command: command.slice(0, 200), response: response.slice(0, 2000) }].slice(-200)), [])`; extract `adopt(next)` (set ref/state + success notice) shared by `connect` and `connectTo`; `send` records `(zpl, '')` after a successful `sendRaw`; `query` = `usbQuery(held, command, opts)` then `record(command, text)` and returns text (drops the device on "Printer connection lost"); `sendBytes` = `usbSendBytes` then `record('<N bytes>', '')`; `identify` = `parseHostIdentification(await query(HOST_IDENTIFICATION))`; `status` = `parseHostStatus(await query(HOST_STATUS, { maxReads: 4 }))`; `knownDevices` = `usb?.getDevices ? usb.getDevices() : []`; `connectTo(device)` = close held, `openPrinter(device)`, `adopt(device)` with the error path like `connect`.

- [ ] **Step 4: Run the hook tests + tsc + the Print Labels page test** (`npx vitest run src/lib/useZebraPrinter.test.tsx src/pages/PrintLabels.test.tsx && npx tsc -b`) → all pass (the page mocks the hook object; adding fields must not break it).

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/useZebraPrinter.ts portal/src/lib/useZebraPrinter.test.tsx
git commit -m "feat(portal): useZebraPrinter gains query/sendBytes/identify/status, known devices, and a command log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Page CSS, `PrinterHealth` chips, and the Test label alignment modal

**Files:**
- Create: `portal/src/styles/printers.css` (ALL `zp-*` rules for the feature — later tasks add markup only)
- Create: `portal/src/components/printers/PrinterHealth.tsx` (+ `PrinterHealth.test.tsx`)
- Create: `portal/src/components/printers/AlignmentTestModal.tsx` (+ `AlignmentTestModal.test.tsx`)

**Interfaces:**
- Consumes: `HostIdentification`, `HostStatus` (Task 4); `readPrintSettings`, `writePrintSettings`, `alignmentTestZpl`, `applyPrintSettings`, `clampSetting`, `PrintSettings` (`lib/printLabels.ts`); `vocabOfKind`, `sizeMeta`, `dpiDots` (`lib/labels.ts`); `ComboBox`; `LabelVocab`.
- Produces:
  ```tsx
  export function healthChips(status: HostStatus | null): { label: string; tone: 'c-green' | 'c-red' | 'c-amber' | 'c-slate' }[]   // pure
  export default function PrinterHealth(props: { identity: HostIdentification | null; status: HostStatus | null; productName: string | null }): JSX.Element
  export default function AlignmentTestModal(props: { vocab: LabelVocab[]; printerDpi: number | null; onPrint: (zpl: string) => Promise<void>; onClose: () => void }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// portal/src/components/printers/PrinterHealth.test.tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { HostStatus } from '../../labels/zebraUsb';
import PrinterHealth, { healthChips } from './PrinterHealth';

afterEach(cleanup);
const ok: HostStatus = {
  paperOut: false, paused: false, labelLength: 1218, formatsQueued: 0, bufferFull: false, partialFormat: false,
  corruptRam: false, underTemp: false, overTemp: false, headOpen: false, ribbonOut: false, thermalTransfer: false,
  printMode: '0', labelWaiting: false, labelsRemaining: 0,
};

describe('healthChips', () => {
  it('is a single green Ready chip when nothing is wrong', () => {
    expect(healthChips(ok)).toEqual([{ label: 'Ready', tone: 'c-green' }]);
  });
  it('lists every raised flag in red plus the queue in slate', () => {
    expect(healthChips({ ...ok, paperOut: true, headOpen: true, paused: true, overTemp: true, formatsQueued: 3 }).map((c) => c.label))
      .toEqual(['Paper out', 'Head open', 'Paused', 'Over temperature', '3 labels queued']);
    expect(healthChips({ ...ok, paused: true })[0].tone).toBe('c-amber');
    expect(healthChips({ ...ok, formatsQueued: 1 })).toEqual([{ label: 'Ready', tone: 'c-green' }, { label: '1 label queued', tone: 'c-slate' }]);
  });
  it('is empty without a status', () => { expect(healthChips(null)).toEqual([]); });
});

it('renders identity and health chips', () => {
  render(<PrinterHealth productName="ZD421" status={{ ...ok, ribbonOut: true }}
                       identity={{ model: 'ZD421-203dpi ZPL', firmware: 'V92.21.16Z', dotsPerMm: 8, memory: '8192KB', dpi: 203 }} />);
  expect(screen.getByText('ZD421-203dpi ZPL')).toBeTruthy();
  expect(screen.getByText('V92.21.16Z')).toBeTruthy();
  expect(screen.getByText('203 DPI')).toBeTruthy();
  expect(screen.getByText('8192KB')).toBeTruthy();
  expect(screen.getByText('Ribbon out')).toBeTruthy();
});
```

```tsx
// portal/src/components/printers/AlignmentTestModal.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LabelVocab } from '../../lib/api';
import AlignmentTestModal from './AlignmentTestModal';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);
beforeEach(() => localStorage.clear());

const vocab: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'size', key: '2x1', label: '2" x 1"', description: '', meta: { width_in: 2, height_in: 1 }, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '300', label: '300 DPI', description: '', meta: { dots: 300 }, sort_order: 2, is_active: true, usage_count: null },
];

function setup(printerDpi: number | null = 203) {
  const onPrint = vi.fn(async (_zpl: string) => undefined);
  const onClose = vi.fn();
  render(<AlignmentTestModal vocab={vocab} printerDpi={printerDpi} onPrint={onPrint} onClose={onClose} />);
  return { onPrint, onClose };
}

describe('AlignmentTestModal', () => {
  it('preselects the printer DPI and prints the 4x2 test with the stored offsets', async () => {
    localStorage.setItem('labels.print.settings', JSON.stringify({ verticalOffset: 5, horizontalOffset: -3 }));
    const { onPrint } = setup(203);
    expect(screen.getByRole('tab', { name: '203 DPI' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByLabelText('Vertical offset') as HTMLInputElement).value).toBe('5');
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    const zpl = onPrint.mock.calls[0][0];
    expect(zpl).toContain('^PW812');
    expect(zpl).toContain('^LL406');
    expect(zpl).toContain('^LT5');
    expect(zpl).toContain('^LS3');
    expect(zpl).not.toContain('^PQ');
    expect(await screen.findByText('Alignment test label (4x2) sent to printer')).toBeTruthy();
  });
  it('defaults to 300 DPI without a printer DPI and shows the boxes preview', () => {
    setup(null);
    expect(screen.getByRole('tab', { name: '300 DPI' }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelectorAll('svg rect').length).toBeGreaterThanOrEqual(3);
  });
  it('Save offsets persists edited offsets and is disabled until changed', async () => {
    setup();
    const save = screen.getByRole('button', { name: 'Save offsets' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const v = screen.getByLabelText('Vertical offset');
    fireEvent.change(v, { target: { value: '12' } });
    fireEvent.blur(v);
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    expect(JSON.parse(localStorage.getItem('labels.print.settings') ?? '{}').verticalOffset).toBe(12);
    expect(screen.getByText('Offsets saved — Print Labels will use them.')).toBeTruthy();
  });
  it('shows a print failure', async () => {
    const { onPrint } = setup();
    onPrint.mockRejectedValueOnce(new Error('Printer connection lost. Please reconnect.'));
    await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    expect(await screen.findByText('Printer connection lost. Please reconnect.')).toBeTruthy();
  });
  it('closes on Done, ×, and Escape', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run to verify failure** — both files → module not found.

- [ ] **Step 3: CSS** — create `portal/src/styles/printers.css`:

```css
/* Labels → Printers (Zebra tools) — layout + color only. Typography rides
   the shared primitives (eyebrow / modal-section / page-hint / chip /
   cell-top / cell-sub / mono); nothing here sets font or line-height
   on list-ish selectors (guardrail). */
.zp-card {
  display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px;
  padding: 18px 22px; border: 1px solid var(--paper-line); border-radius: 12px;
  background: var(--surface-2, #f5f7fa);
}
.zp-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.zp-card-head .modal-section { margin: 0; }
.zp-printer-status { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.zp-printer-status .dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
.zp-printer-status .dot.on { background: var(--c-green); }
.zp-printer-status .dot.off { background: var(--c-red); }
.zp-printer-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.zp-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.zp-known { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.zp-known .mini-btn { display: inline-flex; align-items: center; gap: 6px; }

/* tool rows: title/description on the left, the action on the right */
.zp-tool-row { grid-template-columns: minmax(0, 1fr) auto; cursor: default; }
.zp-tool-action { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }

/* notice strip (same look as Print Labels) */
.zp-notice {
  display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
  padding: 10px 14px; border: 1px solid var(--paper-line); border-radius: 10px; background: var(--surface-2, #f5f7fa);
}
.zp-notice .page-hint { margin: 0; flex: 1; }
.zp-notice.info { border-color: var(--c-blue-bd, #bcd4f5); background: var(--c-blue-bg, #eef4fd); }
.zp-notice.success { border-color: var(--c-green-bd, #b7e0c1); background: var(--c-green-bg, #edf8ef); }
.zp-notice.warning { border-color: var(--c-amber-bd, #efd39a); background: var(--c-amber-bg, #fff7e6); }
.zp-notice.error { border-color: var(--c-red-bd, #f0b4b4); background: var(--c-red-bg, #fdecec); }

/* modals */
.modal-card.reports-modal-card.rgm-card.zp-align-card { width: min(760px, 96vw); max-width: 96vw; overflow: visible; max-height: none; }
.modal-card.reports-modal-card.rgm-card.zp-fonts-card { width: min(1100px, 96vw); max-width: 96vw; }
.modal-card.reports-modal-card.rgm-card.zp-setup-card { width: min(980px, 96vw); max-width: 96vw; overflow: visible; max-height: none; }
.zp-two-col { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(280px, 1fr); gap: 12px 32px; align-items: start; }
@media (max-width: 800px) { .zp-two-col { grid-template-columns: 1fr; } }
.zp-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.zp-col .modal-section { margin: 0; }
.zp-col .page-hint { margin: 0; }
.zp-form { grid-template-columns: 1fr 1fr; gap: 12px 18px; }
.zp-form .field-hint { margin: 4px 0 0; }
.zp-preview { display: flex; align-items: center; justify-content: center; padding: 12px; border: 1px solid var(--paper-line); border-radius: 10px; background: var(--surface, #fff); }
.zp-preview svg { width: 100%; height: auto; max-width: 320px; }
.zp-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

/* fonts */
.zp-upload { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--paper-line); border-radius: 10px; background: var(--surface, #fff); }
.zp-upload-row { display: grid; grid-template-columns: minmax(0, 1fr) 160px auto; gap: 10px; align-items: end; }
@media (max-width: 800px) { .zp-upload-row { grid-template-columns: 1fr; } }
.zp-font-progress { height: 6px; border-radius: 3px; background: var(--c-blue-bg, #eef4fd); overflow: hidden; margin-top: 4px; }
.zp-font-progress-fill { height: 100%; background: var(--accent); border-radius: inherit; transition: width 150ms ease; }
.zp-inline-actions { display: inline-flex; gap: 6px; }

/* setup wizard */
.zp-config-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.zp-config-item { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1px solid var(--paper-line); border-radius: 10px; background: var(--surface, #fff); }
.zp-choices { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.zp-range { display: grid; grid-template-columns: minmax(0, 1fr) 64px; gap: 10px; align-items: center; }
.zp-range input[type="range"] { width: 100%; }
.zp-confirm { display: flex; flex-direction: column; gap: 4px; }
.zp-log { margin-top: 12px; }
.zp-log summary { cursor: pointer; }
.zp-log pre { max-height: 220px; overflow: auto; margin: 8px 0 0; padding: 10px 12px; border: 1px solid var(--paper-line); border-radius: 10px; background: var(--surface, #fff); white-space: pre-wrap; overflow-wrap: anywhere; }
.zp-guard { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.zp-guard input { width: 120px; }
```

- [ ] **Step 4: `PrinterHealth.tsx`**

```tsx
// portal/src/components/printers/PrinterHealth.tsx
/**
 * Identity + health chips for the connected Zebra printer, read from `~HI`
 * and `~HS` (parsed in labels/zebraUsb.ts). Shared by the Printers page
 * card and the setup wizard's Identify step. `healthChips` is pure.
 */
import type { HostIdentification, HostStatus } from '../../labels/zebraUsb';

export type ChipTone = 'c-green' | 'c-red' | 'c-amber' | 'c-slate';

export function healthChips(status: HostStatus | null): { label: string; tone: ChipTone }[] {
  if (!status) return [];
  const chips: { label: string; tone: ChipTone }[] = [];
  if (status.paperOut) chips.push({ label: 'Paper out', tone: 'c-red' });
  if (status.headOpen) chips.push({ label: 'Head open', tone: 'c-red' });
  if (status.paused) chips.push({ label: 'Paused', tone: 'c-amber' });
  if (status.ribbonOut) chips.push({ label: 'Ribbon out', tone: 'c-red' });
  if (status.overTemp) chips.push({ label: 'Over temperature', tone: 'c-red' });
  if (status.underTemp) chips.push({ label: 'Under temperature', tone: 'c-amber' });
  if (status.bufferFull) chips.push({ label: 'Buffer full', tone: 'c-amber' });
  if (chips.length === 0) chips.push({ label: 'Ready', tone: 'c-green' });
  if (status.formatsQueued > 0) {
    chips.push({ label: `${status.formatsQueued} label${status.formatsQueued === 1 ? '' : 's'} queued`, tone: 'c-slate' });
  }
  return chips;
}

export default function PrinterHealth({ identity, status, productName }: {
  identity: HostIdentification | null; status: HostStatus | null; productName: string | null;
}) {
  return (
    <div className="zp-chips" aria-label="Printer identity and health">
      {identity ? (
        <>
          <span className="chip tag" title="Model">{identity.model}</span>
          <span className="chip tag" title="Firmware">{identity.firmware}</span>
          <span className="chip tag" title="Resolution">{identity.dpi} DPI</span>
          <span className="chip tag" title="Memory">{identity.memory}</span>
        </>
      ) : productName ? <span className="chip tag">{productName}</span> : null}
      {healthChips(status).map((c) => (
        <span key={c.label} className={`chip ${c.tone}`}><span className="dot" />{c.label}</span>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: `AlignmentTestModal.tsx`**

```tsx
// portal/src/components/printers/AlignmentTestModal.tsx
/**
 * Printers › Test label alignment — the same concentric-boxes test as
 * Print Labels' settings modal (`alignmentTestZpl`), with the offsets
 * editable here and saved to the shared `labels.print.settings` store so
 * Print Labels prints with them. DPI preselects from the printer's `~HI`.
 */
import { useEffect, useMemo, useState } from 'react';

import type { LabelVocab } from '../../lib/api';
import { dpiDots, sizeMeta, vocabOfKind } from '../../lib/labels';
import {
  alignmentTestZpl, applyPrintSettings, clampSetting, readPrintSettings, writePrintSettings,
} from '../../lib/printLabels';
import ComboBox from '../ComboBox';

const DEFAULT_SIZE = '4x2';

/** The inner-box insets V2's routine draws (outer box at 5, then every 25
 *  dots while both sides stay ≥ 50) — mirrored here for the preview. */
export function alignmentInsets(widthDots: number, heightDots: number): number[] {
  const insets = [5];
  for (let inset = 30; widthDots - 2 * inset >= 50 && heightDots - 2 * inset >= 50; inset += 25) insets.push(inset);
  return insets;
}

export default function AlignmentTestModal({ vocab, printerDpi, onPrint, onClose }: {
  vocab: LabelVocab[]; printerDpi: number | null; onPrint: (zpl: string) => Promise<void>; onClose: () => void;
}) {
  const sizes = useMemo(() => vocabOfKind(vocab, 'size'), [vocab]);
  const dpis = useMemo(() => vocabOfKind(vocab, 'dpi'), [vocab]);
  const [sizeKey, setSizeKey] = useState(DEFAULT_SIZE);
  const [dpiKey, setDpiKey] = useState(() =>
    (printerDpi && dpis.some((d) => d.key === String(printerDpi))) ? String(printerDpi) : (dpis.some((d) => d.key === '300') ? '300' : (dpis[0]?.key ?? '300')));
  const [stored] = useState(() => readPrintSettings());
  const [vText, setVText] = useState(String(stored.verticalOffset));
  const [hText, setHText] = useState(String(stored.horizontalOffset));
  const [saved, setSaved] = useState({ v: stored.verticalOffset, h: stored.horizontalOffset });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const size = sizes.find((s) => s.key === sizeKey) ?? sizes[0] ?? null;
  const dots = dpiDots(vocab, dpiKey);
  const vertical = clampSetting('verticalOffset', vText);
  const horizontal = clampSetting('horizontalOffset', hText);
  const dirty = vertical !== saved.v || horizontal !== saved.h;
  const dims = size ? { w: Math.round(sizeMeta(size).width_in * dots), h: Math.round(sizeMeta(size).height_in * dots) } : null;

  const print = async () => {
    if (!size || !dims) return;
    setNotice(null);
    setBusy(true);
    try {
      const zpl = applyPrintSettings(alignmentTestZpl(dims.w, dims.h, size.key, dots),
        { ...stored, verticalOffset: vertical, horizontalOffset: horizontal }, { singleCopy: true });
      await onPrint(zpl);
      setNotice({ type: 'success', message: `Alignment test label (${size.key}) sent to printer` });
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error && err.message ? err.message : 'Failed to print alignment test label' });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    writePrintSettings({ ...readPrintSettings(), verticalOffset: vertical, horizontalOffset: horizontal });
    setSaved({ v: vertical, h: horizontal });
    setNotice({ type: 'success', message: 'Offsets saved — Print Labels will use them.' });
  };

  const field = (id: string, label: string, hint: string, value: string, set: (v: string) => void, commit: () => void) => (
    <div>
      <label htmlFor={id}>{label} (dots)</label>
      <input id={id} type="number" aria-label={label} aria-describedby={`${id}-hint`} value={value}
             onChange={(e) => set(e.target.value)} onBlur={commit}
             onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
      <p id={`${id}-hint`} className="page-hint field-hint">{hint}</p>
    </div>
  );

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card zp-align-card" role="dialog" aria-label="Test label alignment">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Printers</div>
            <h3>Test label alignment</h3>
            <p className="page-hint">Prints concentric boxes 25 dots apart so you can dial in the offsets. The same offsets are used by Print Labels.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="zp-two-col">
            <section className="zp-col" aria-label="Label and offsets">
              <div className="modal-section">Label</div>
              <ComboBox options={sizes.map((s) => ({ value: s.key, label: s.label }))} value={size?.key ?? ''} onChange={setSizeKey} placeholder="Label size…" />
              <div className="segmented" role="tablist" aria-label="Printer DPI">
                {dpis.map((d) => (
                  <button key={d.key} type="button" role="tab" aria-selected={dpiKey === d.key} className={dpiKey === d.key ? 'on' : ''} onClick={() => setDpiKey(d.key)}>{d.label}</button>
                ))}
              </div>
              <div className="modal-section">Offsets</div>
              <div className="pf-form zp-form">
                {field('at-vertical', 'Vertical offset', 'Offset in dots (+ moves down)', vText, setVText, () => setVText(String(vertical)))}
                {field('at-horizontal', 'Horizontal offset', 'Offset in dots (+ moves right)', hText, setHText, () => setHText(String(horizontal)))}
              </div>
            </section>
            <section className="zp-col" aria-label="Preview">
              <div className="modal-section">Preview</div>
              <div className="zp-preview">
                {dims && (
                  <svg viewBox={`0 0 ${dims.w} ${dims.h}`} role="img" aria-label={`${size?.label ?? ''} alignment boxes`}>
                    <rect x="0" y="0" width={dims.w} height={dims.h} fill="#fff" stroke="#c9ced6" strokeWidth={Math.max(1, dims.w / 400)} />
                    {alignmentInsets(dims.w, dims.h).map((i, idx) => (
                      <rect key={i} x={i} y={i} width={dims.w - 2 * i} height={dims.h - 2 * i} fill="none" stroke="#1a1d21" strokeWidth={idx === 0 ? 4 : 2} />
                    ))}
                  </svg>
                )}
              </div>
              <p className="page-hint">{dims ? `${dims.w} × ${dims.h} dots at ${dots} DPI` : 'Pick a label size.'}</p>
            </section>
          </div>
          {notice && <div className={`zp-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}><p className="page-hint">{notice.message}</p></div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" disabled={busy || !size} onClick={() => void print()}>{busy ? 'Sending…' : 'Print test label'}</button>
          <button type="button" className="mini-btn" disabled={!dirty} onClick={save}>Save offsets</button>
          <button type="button" className="mini-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run tests + guardrail + tsc** — `npx vitest run src/components/printers src/styles/listTypography.test.ts && npx tsc -b` → pass, clean. (Note: nothing in `printers.css` is imported yet — the guardrail scans all `styles/*.css` regardless.)

- [ ] **Step 7: Commit**

```bash
git add portal/src/styles/printers.css portal/src/components/printers/PrinterHealth.tsx portal/src/components/printers/PrinterHealth.test.tsx portal/src/components/printers/AlignmentTestModal.tsx portal/src/components/printers/AlignmentTestModal.test.tsx
git commit -m "feat(portal): Printers page CSS, PrinterHealth chips, and the Test label alignment modal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Install fonts modal

**Files:**
- Create: `portal/src/components/printers/InstallFontsModal.tsx` (+ `InstallFontsModal.test.tsx`)

**Interfaces:**
- Consumes: `LabelFont` (Task 2); `ZebraPrinter` (Task 5: `connected`, `query`, `send`, `sendBytes`); `directoryQuery`, `downloadFontHeader`, `deleteObject`, `fontObjectName`, `isTrueType` (Task 3); `parseDirectory`, `DirectoryListing` (Task 4); `relativeTime`; `DataTable`.
- Produces:
  ```tsx
  export type FontState = 'installed' | 'missing' | 'printer-only'
  export function fontStates(library: LabelFont[], listing: DirectoryListing | null): { library: Record<string, FontState>; printerOnly: { name: string; bytes: number }[] }  // pure, keyed by NAME
  export default function InstallFontsModal(props: {
    printer: Pick<ZebraPrinter, 'connected' | 'query' | 'send' | 'sendBytes'>;
    fonts: LabelFont[] | null;                 // null = loading
    canAdd: boolean; canDelete: boolean;
    onUpload: (file: File, name: string) => Promise<void>;
    onDeleteFont: (id: string) => Promise<void>;
    onFetchBytes: (id: string) => Promise<Uint8Array>;
    onClose: () => void;
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
// portal/src/components/printers/InstallFontsModal.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LabelFont } from '../../lib/api';
import InstallFontsModal, { fontStates } from './InstallFontsModal';

afterEach(cleanup);

const font = (id: string, name: string, used: string[] = []): LabelFont => ({
  id, name, display_name: name.toLowerCase(), size_bytes: 124336, content_type: 'font/ttf', uploaded_by: 'p',
  uploaded_by_name: 'Jimmy', created_at: new Date(Date.now() - 3_600_000).toISOString(),
  used_by: used.map((t) => ({ template_id: t, template_name: t })),
});
const LIB = [font('f1', '85620388.TTF', ['Front Asset Tag']), font('f2', 'ARIAL_B.TTF')];
const DIR = '\x02- DIR E:*.*\r\n* 85620388.TTF       124336\r\n* TT0003M_.TTF      169188\r\n-1928576 bytes free E: ONBOARD FLASH\r\n\x03';

function fakePrinter(connected = true) {
  return {
    connected,
    query: vi.fn(async (_cmd: string) => DIR),
    send: vi.fn(async (_zpl: string) => undefined),
    sendBytes: vi.fn(async (bytes: Uint8Array, onProgress?: (s: number, t: number) => void) => { onProgress?.(bytes.length, bytes.length); }),
  };
}

function setup(over: Partial<Parameters<typeof InstallFontsModal>[0]> = {}) {
  const printer = fakePrinter();
  const h = {
    onUpload: vi.fn(async (_f: File, _n: string) => undefined), onDeleteFont: vi.fn(async (_id: string) => undefined),
    onFetchBytes: vi.fn(async (_id: string) => new Uint8Array([0, 1, 0, 0, 7, 7])), onClose: vi.fn(),
  };
  render(<InstallFontsModal printer={printer} fonts={LIB} canAdd canDelete {...h} {...over} />);
  return { printer, ...h };
}

describe('fontStates', () => {
  it('classifies library fonts and printer-only objects', () => {
    const listing = { objects: [{ name: '85620388.TTF', bytes: 1 }, { name: 'TT0003M_.TTF', bytes: 2 }], bytesFree: 9 };
    expect(fontStates(LIB, listing)).toEqual({
      library: { '85620388.TTF': 'installed', 'ARIAL_B.TTF': 'missing' },
      printerOnly: [{ name: 'TT0003M_.TTF', bytes: 2 }],
    });
    expect(fontStates(LIB, null).library).toEqual({});
  });
});

describe('InstallFontsModal', () => {
  it('lists the library with usage, reads the printer directory, and shows states', async () => {
    const { printer } = setup();
    expect(screen.getByText('Install fonts')).toBeTruthy();
    expect(screen.getByText('Front Asset Tag')).toBeTruthy();
    await waitFor(() => expect(printer.query).toHaveBeenCalledWith('^XA^HWE:*.*^XZ'));
    expect(await screen.findByText('Installed')).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByText('Printer only')).toBeTruthy();
    expect(screen.getByText(/1,883 KB free|1883 KB free/)).toBeTruthy();
  });
  it('installs a missing font: header, bytes, then re-reads the directory', async () => {
    const { printer, onFetchBytes } = setup();
    await screen.findByText('Missing');
    const row = screen.getByText('ARIAL_B.TTF').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(printer.sendBytes).toHaveBeenCalled());
    expect(onFetchBytes).toHaveBeenCalledWith('f2');
    expect(printer.send).toHaveBeenCalledWith('~DYE:ARIAL_B.TTF,B,T,6,,');
    expect(printer.query.mock.calls.filter((c) => c[0] === '^XA^HWE:*.*^XZ').length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText('Installed ✓')).toBeTruthy();
  });
  it('Install all missing installs every missing library font', async () => {
    const { printer } = setup();
    await screen.findByText('Missing');
    await userEvent.click(screen.getByRole('button', { name: 'Install all missing' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('~DYE:ARIAL_B.TTF,B,T,6,,'));
    expect(printer.send.mock.calls.filter((c) => String(c[0]).startsWith('~DY')).length).toBe(1);
  });
  it('removes an object from the printer', async () => {
    const { printer } = setup();
    await screen.findByText('Printer only');
    const row = screen.getByText('TT0003M_.TTF').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove from printer' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^IDE:TT0003M_.TTF^XZ'));
  });
  it('uploads a TTF with a validated name and blocks bad names', async () => {
    const { onUpload } = setup();
    const input = screen.getByLabelText('TrueType font file') as HTMLInputElement;
    const file = new File([new Uint8Array([0, 1, 0, 0, 1])], 'Swiss721.ttf', { type: 'font/ttf' });
    await userEvent.upload(input, file);
    const name = screen.getByLabelText('Printer name') as HTMLInputElement;
    expect(name.value).toBe('SWISS721.TTF');
    fireEvent.change(name, { target: { value: 'too long name.ttf' } });
    expect(screen.getByText('Use up to 8 letters, digits, or underscores plus .TTF')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Upload' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: '85620388.TTF' } });
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(onUpload).toHaveBeenCalledWith(file, '85620388.TTF');
  });
  it('removes a library font after inline confirmation', async () => {
    const { onDeleteFont } = setup();
    const row = screen.getByText('ARIAL_B.TTF').closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Remove ARIAL_B.TTF from the library? Printers keep their copy.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(onDeleteFont).toHaveBeenCalledWith('f2');
  });
  it('without a printer the install column explains and hides install buttons', () => {
    setup({ printer: fakePrinter(false) });
    expect(screen.getByText('Connect a printer to install fonts.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });
  it('hides upload/remove without permissions', () => {
    setup({ canAdd: false, canDelete: false });
    expect(screen.queryByLabelText('TrueType font file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```tsx
// portal/src/components/printers/InstallFontsModal.tsx
/**
 * Printers › Install fonts — the V3 font library (TrueType files admins
 * upload once) on the left, the connected printer's E: drive on the
 * right. Install streams a `~DY` header + the TTF bytes over WebUSB and
 * re-reads the directory to confirm. Presentational for the API side
 * (callbacks); talks to the printer through the hook's query/send.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { LabelFont } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import type { ZebraPrinter } from '../../lib/useZebraPrinter';
import { deleteObject, directoryQuery, downloadFontHeader, fontObjectName, isTrueType } from '../../labels/zebraCommands';
import { parseDirectory, type DirectoryListing } from '../../labels/zebraUsb';
import DataTable from '../DataTable';

export type FontState = 'installed' | 'missing' | 'printer-only';

export function fontStates(library: LabelFont[], listing: DirectoryListing | null) {
  const onPrinter = new Map((listing?.objects ?? []).map((o) => [o.name.toUpperCase(), o]));
  const lib: Record<string, FontState> = {};
  if (listing) for (const f of library) lib[f.name.toUpperCase()] = onPrinter.has(f.name.toUpperCase()) ? 'installed' : 'missing';
  const libNames = new Set(library.map((f) => f.name.toUpperCase()));
  const printerOnly = (listing?.objects ?? []).filter((o) => !libNames.has(o.name.toUpperCase())).map((o) => ({ name: o.name, bytes: o.bytes }));
  return { library: lib, printerOnly };
}

const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString()} KB`;
const NAME_HINT = 'Use up to 8 letters, digits, or underscores plus .TTF';

interface Props {
  printer: Pick<ZebraPrinter, 'connected' | 'query' | 'send' | 'sendBytes'>;
  fonts: LabelFont[] | null;
  canAdd: boolean; canDelete: boolean;
  onUpload: (file: File, name: string) => Promise<void>;
  onDeleteFont: (id: string) => Promise<void>;
  onFetchBytes: (id: string) => Promise<Uint8Array>;
  onClose: () => void;
}

type Progress = { sent: number; total: number } | 'done' | { error: string };

export default function InstallFontsModal({ printer, fonts, canAdd, canDelete, onUpload, onDeleteFont, onFetchBytes, onClose }: Props) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [listError, setListError] = useState('');
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<LabelFont | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !busy && !uploading) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy, uploading]);

  const readDirectory = useCallback(async () => {
    if (!printer.connected) { setListing(null); return; }
    try {
      const parsed = parseDirectory(await printer.query(directoryQuery()));
      setListing(parsed);
      setListError(parsed ? '' : "Couldn't read the printer's E: drive.");
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Couldn't read the printer's E: drive.");
    }
  }, [printer]);

  useEffect(() => { void readDirectory(); }, [readDirectory]);

  const states = useMemo(() => fontStates(fonts ?? [], listing), [fonts, listing]);

  const install = async (f: LabelFont) => {
    setBusy(true);
    setProgress((p) => ({ ...p, [f.id]: { sent: 0, total: f.size_bytes } }));
    try {
      const bytes = await onFetchBytes(f.id);
      await printer.send(downloadFontHeader('E', f.name, bytes.length));
      await printer.sendBytes(bytes, (sent, total) => setProgress((p) => ({ ...p, [f.id]: { sent, total } })));
      await new Promise((r) => setTimeout(r, 500));
      await readDirectory();
      setProgress((p) => ({ ...p, [f.id]: 'done' }));
    } catch (err) {
      setProgress((p) => ({ ...p, [f.id]: { error: err instanceof Error ? err.message : 'Install failed' } }));
    } finally {
      setBusy(false);
    }
  };

  const installAllMissing = async () => {
    for (const f of fonts ?? []) if (states.library[f.name.toUpperCase()] === 'missing') await install(f);
  };

  const removeFromPrinter = async (objectName: string) => {
    setBusy(true);
    try {
      await printer.send(deleteObject('E', objectName));
      await new Promise((r) => setTimeout(r, 300));
      await readDirectory();
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  const pickFile = (f: File | null) => {
    setFile(f);
    setUploadError('');
    setName(f ? (fontObjectName(f.name) ?? f.name.toUpperCase()) : '');
  };
  const nameValid = fontObjectName(name) !== null;

  const upload = async () => {
    if (!file || !nameValid) return;
    setUploading(true);
    setUploadError('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isTrueType(bytes)) throw new Error('That file is not a TrueType font.');
      await onUpload(file, fontObjectName(name) as string);
      pickFile(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const progressCell = (f: LabelFont) => {
    const p = progress[f.id];
    if (!p) return null;
    if (p === 'done') return <span className="chip c-green">Installed ✓</span>;
    if ('error' in p) return <span className="pf-error">{p.error}</span>;
    const pct = p.total ? Math.round((p.sent / p.total) * 100) : 0;
    return <div className="zp-font-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="zp-font-progress-fill" style={{ width: `${pct}%` }} /></div>;
  };

  const libraryRows = (fonts ?? []).map((f) => {
    const state = states.library[f.name.toUpperCase()];
    return {
      key: f.id,
      cells: [
        <span className="mono" key="n">{f.name}</span>,
        <span className="cell-sub" key="d">{f.display_name}</span>,
        <span className="mono" key="s">{kb(f.size_bytes)}</span>,
        <span className="zp-chips" key="u">{f.used_by.length === 0 ? <span className="cell-sub">—</span> : f.used_by.map((u) => <span key={u.template_id} className="chip tag">{u.template_name}</span>)}</span>,
        <span className="mono" key="t">{relativeTime(f.created_at)}</span>,
        <span className="zp-inline-actions" key="a">
          {printer.connected && state && (
            <button type="button" className="mini-btn" disabled={busy} onClick={() => void install(f)}>{state === 'installed' ? 'Reinstall' : 'Install'}</button>
          )}
          {canDelete && <button type="button" className="mini-btn danger" disabled={busy} onClick={() => setConfirmDelete(f)}>Remove</button>}
        </span>,
        <span key="p">{state && !progress[f.id] ? <span className={`chip ${state === 'installed' ? 'c-green' : 'c-amber'}`}>{state === 'installed' ? 'Installed' : 'Missing'}</span> : progressCell(f)}</span>,
      ],
    };
  });

  const printerRows = states.printerOnly.map((o) => ({
    key: o.name,
    cells: [
      <span className="mono" key="n">{o.name}</span>,
      <span className="mono" key="s">{kb(o.bytes)}</span>,
      <span className="chip c-slate" key="c">Printer only</span>,
      <button type="button" className="mini-btn danger" key="r" disabled={busy} onClick={() => void removeFromPrinter(o.name)}>Remove from printer</button>,
    ],
  }));

  const missingCount = Object.values(states.library).filter((s) => s === 'missing').length;

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy && !uploading) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card zp-fonts-card" role="dialog" aria-label="Install fonts">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Printers</div>
            <h3>Install fonts</h3>
            <p className="page-hint">Fonts referenced by label templates must live on the printer's E: drive. Upload TrueType fonts here once, then install them on each printer.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy || uploading}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="zp-two-col">
            <section className="zp-col" aria-label="Font library">
              <div className="modal-section">Font library</div>
              {canAdd && (
                <div className="zp-upload">
                  <div className="pf-form zp-upload-row">
                    <div>
                      <label htmlFor="zp-font-file">TrueType font file</label>
                      <input id="zp-font-file" type="file" accept=".ttf" aria-label="TrueType font file" disabled={uploading}
                             onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
                    </div>
                    <div>
                      <label htmlFor="zp-font-name">Printer name</label>
                      <input id="zp-font-name" aria-label="Printer name" value={name} disabled={!file || uploading}
                             onChange={(e) => setName(e.target.value.toUpperCase())} />
                    </div>
                    <button type="button" className="btn-solid" disabled={!file || !nameValid || uploading} onClick={() => void upload()}>{uploading ? 'Uploading…' : 'Upload'}</button>
                  </div>
                  {file && !nameValid && <p className="pf-error">{NAME_HINT}</p>}
                  {uploadError && <p className="pf-error">{uploadError}</p>}
                </div>
              )}
              {fonts === null ? <p className="page-hint">Loading fonts…</p> : fonts.length === 0 ? <div className="dir-empty">No fonts uploaded yet.</div> : (
                <DataTable ariaLabel="Font library" rows={libraryRows} columns={[
                  { key: 'name', label: 'Name', width: '1.2fr', mono: true }, { key: 'display', label: 'File', width: '1fr' },
                  { key: 'size', label: 'Size', width: '0.6fr', mono: true, align: 'right' }, { key: 'used', label: 'Used by', width: '1.2fr' },
                  { key: 'when', label: 'Uploaded', width: '0.7fr', mono: true }, { key: 'actions', label: '', width: '1fr', align: 'right' },
                  { key: 'state', label: 'On printer', width: '0.9fr' },
                ]} />
              )}
              {confirmDelete && (
                <div className="zp-guard">
                  <span className="cell-sub">Remove {confirmDelete.name} from the library? Printers keep their copy.</span>
                  <button type="button" className="mini-btn danger" onClick={() => { const f = confirmDelete; setConfirmDelete(null); void onDeleteFont(f.id); }}>Yes, remove</button>
                  <button type="button" className="mini-btn" onClick={() => setConfirmDelete(null)}>Keep</button>
                </div>
              )}
            </section>
            <section className="zp-col" aria-label="On the printer">
              <div className="zp-card-head">
                <div className="modal-section">On the printer</div>
                {printer.connected && listing && (
                  <div className="zp-actions">
                    <span className="cell-sub">{listing.bytesFree !== null ? `${kb(listing.bytesFree)} free` : ''}</span>
                    <button type="button" className="mini-btn" disabled={busy} onClick={() => void readDirectory()}>Refresh</button>
                    <button type="button" className="mini-btn" disabled={busy || missingCount === 0} onClick={() => void installAllMissing()}>Install all missing</button>
                  </div>
                )}
              </div>
              {!printer.connected ? <p className="page-hint">Connect a printer to install fonts.</p>
                : listError ? <p className="pf-error">{listError}</p>
                : !listing ? <p className="page-hint">Reading the printer's E: drive…</p>
                : (
                  <>
                    <p className="page-hint">Library fonts show their state in the table on the left. Objects only on the printer:</p>
                    {printerRows.length === 0 ? <div className="dir-empty">No other objects on E:.</div> : (
                      <DataTable ariaLabel="Printer objects" rows={printerRows} columns={[
                        { key: 'name', label: 'Name', width: '1.4fr', mono: true }, { key: 'size', label: 'Size', width: '0.6fr', mono: true, align: 'right' },
                        { key: 'state', label: 'State', width: '0.8fr' }, { key: 'remove', label: '', width: '1fr', align: 'right' },
                      ]} />
                    )}
                  </>
                )}
            </section>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" onClick={onClose} disabled={busy || uploading}>Done</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests + guardrail + tsc.** If `userEvent.upload` does not trigger `onChange` with `accept=".ttf"`, use `fireEvent.change(input, { target: { files: [file] } })`. The "1,883 KB free" text depends on `toLocaleString`; the regex accepts both.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/printers/InstallFontsModal.tsx portal/src/components/printers/InstallFontsModal.test.tsx
git commit -m "feat(portal): Install fonts modal — font library upload/remove, printer E: listing, install/reinstall/remove over WebUSB

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Setup logic (`labels/zebraSetup.ts`) and the Full printer setup wizard

**Files:**
- Create: `portal/src/labels/zebraSetup.ts` (+ `zebraSetup.test.ts`)
- Create: `portal/src/components/printers/PrinterSetupModal.tsx` (+ `PrinterSetupModal.test.tsx`)

**Interfaces:**
- Consumes: `PrinterConfiguration`, `HostIdentification`, `HostStatus`, `parseConfiguration` (Task 4); command builders (Task 3); `ZebraPrinter` (Task 5: `query`, `send`, `identify`, `status`, `log`, `clearLog`); `PrinterHealth` (Task 6); `ChoiceCard` (`components/reports/ReportOptionsLayout`); `ComboBox`; `vocabOfKind`, `sizeMeta`.
- Produces:
  ```ts
  export interface MediaChoices { tracking: MediaTracking | null; method: PrintMethod | null; mode: PrintMode | null; widthDots: number | null; lengthDots: number | null }
  export function mediaChoicesFromConfig(c: PrinterConfiguration | null): MediaChoices
  export function commandsForMedia(current: MediaChoices, next: MediaChoices): string[]     // only changed settings, in order tracking, method, mode, size
  export function confirmMedia(c: PrinterConfiguration | null, next: MediaChoices): Record<'tracking' | 'method' | 'mode' | 'size', boolean | null>   // null = not applied / unknown
  export interface QualityChoices { darkness: number | null; speed: number | null }
  export function qualityFromConfig(c: PrinterConfiguration | null): QualityChoices
  export function commandsForQuality(current: QualityChoices, next: QualityChoices): string[]
  export function confirmQuality(c: PrinterConfiguration | null, next: QualityChoices): Record<'darkness' | 'speed', boolean | null>
  export default function PrinterSetupModal(props: { printer: Pick<ZebraPrinter, 'query' | 'send' | 'identify' | 'status' | 'log' | 'clearLog' | 'productName'>; vocab: LabelVocab[]; identity: HostIdentification | null; onClose: () => void }): JSX.Element
  ```
  Config → choice mapping: `mediaType` containing GAP → `'W'`, MARK → `'M'`, CONTINUOUS → `'N'`; `printMethod` containing DIRECT → `'D'`, THERMAL-TRANS → `'T'`; `printMode` TEAR → `'T'`, PEEL → `'P'`, CUT → `'C'`, REWIND → `'R'`. Confirm: same containment checks; darkness `|c.darkness − n| < 0.5`; speed `c.printSpeed === n`; size `printWidth === w && labelLength === l`.

- [ ] **Step 1: Write the failing tests**

```ts
// portal/src/labels/zebraSetup.test.ts
import { describe, expect, it } from 'vitest';

import type { PrinterConfiguration } from './zebraUsb';
import { commandsForMedia, commandsForQuality, confirmMedia, confirmQuality, mediaChoicesFromConfig, qualityFromConfig } from './zebraSetup';

const cfg: PrinterConfiguration = {
  darkness: 10, printSpeed: 6, tearOff: 0, printMode: 'TEAR OFF', mediaType: 'GAP/NOTCH', printMethod: 'DIRECT-THERMAL',
  printWidth: 812, labelLength: 1218, firmware: 'V72', raw: {},
};

describe('media', () => {
  it('derives choices from the configuration', () => {
    expect(mediaChoicesFromConfig(cfg)).toEqual({ tracking: 'W', method: 'D', mode: 'T', widthDots: 812, lengthDots: 1218 });
    expect(mediaChoicesFromConfig({ ...cfg, mediaType: 'MARK', printMethod: 'THERMAL-TRANS.', printMode: 'PEEL OFF' })).toMatchObject({ tracking: 'M', method: 'T', mode: 'P' });
    expect(mediaChoicesFromConfig(null)).toEqual({ tracking: null, method: null, mode: null, widthDots: null, lengthDots: null });
  });
  it('emits only the commands for changed settings, in order', () => {
    const cur = mediaChoicesFromConfig(cfg);
    expect(commandsForMedia(cur, cur)).toEqual([]);
    expect(commandsForMedia(cur, { ...cur, tracking: 'N', mode: 'C', widthDots: 609, lengthDots: 406 }))
      .toEqual(['^XA^MNN^XZ', '^XA^MMC^XZ', '^XA^PW609^LL406^XZ']);
    expect(commandsForMedia(cur, { ...cur, method: 'T' })).toEqual(['^XA^MTT^XZ']);
  });
  it('confirms against a re-read configuration', () => {
    expect(confirmMedia(cfg, { tracking: 'W', method: 'D', mode: 'T', widthDots: 812, lengthDots: 1218 })).toEqual({ tracking: true, method: true, mode: true, size: true });
    expect(confirmMedia(cfg, { tracking: 'M', method: null, mode: 'C', widthDots: 609, lengthDots: 1218 })).toEqual({ tracking: false, method: null, mode: false, size: false });
    expect(confirmMedia(null, { tracking: 'W', method: 'D', mode: 'T', widthDots: 812, lengthDots: 1218 })).toEqual({ tracking: null, method: null, mode: null, size: null });
  });
});

describe('quality', () => {
  it('derives, diffs, and confirms darkness/speed', () => {
    expect(qualityFromConfig(cfg)).toEqual({ darkness: 10, speed: 6 });
    expect(commandsForQuality({ darkness: 10, speed: 6 }, { darkness: 10, speed: 6 })).toEqual([]);
    expect(commandsForQuality({ darkness: 10, speed: 6 }, { darkness: 14, speed: 4 })).toEqual(['~SD14', '^XA^PR4^XZ']);
    expect(confirmQuality({ ...cfg, darkness: 14.0 }, { darkness: 14, speed: 6 })).toEqual({ darkness: true, speed: true });
    expect(confirmQuality(cfg, { darkness: 14, speed: null })).toEqual({ darkness: false, speed: null });
  });
});
```

```tsx
// portal/src/components/printers/PrinterSetupModal.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LabelVocab } from '../../lib/api';
import type { HostStatus } from '../../labels/zebraUsb';
import PrinterSetupModal from './PrinterSetupModal';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

const HH = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    DARKNESS: '+10.0', 'PRINT SPEED': '6.0 IPS', 'TEAR OFF': '+000', 'PRINT MODE': 'TEAR OFF', 'MEDIA TYPE': 'GAP/NOTCH',
    'PRINT METHOD': 'DIRECT-THERMAL', 'PRINT WIDTH': '812', 'LABEL LENGTH': '1218', FIRMWARE: 'V72.19.15Z <-', ...over,
  };
  return '\x02' + Object.entries(base).map(([k, v]) => `${v.padEnd(20)}${k}`).join('\r\n') + '\x03';
};
const status: HostStatus = { paperOut: false, paused: false, labelLength: 1218, formatsQueued: 0, bufferFull: false, partialFormat: false, corruptRam: false, underTemp: false, overTemp: false, headOpen: false, ribbonOut: false, thermalTransfer: false, printMode: '0', labelWaiting: false, labelsRemaining: 0 };
const vocab: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'size', key: '3x2', label: '3" x 2"', description: '', meta: { width_in: 3, height_in: 2 }, sort_order: 2, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: null },
];

function fakePrinter(config = HH()) {
  const state = { config };
  const printer = {
    productName: 'ZD421',
    query: vi.fn(async (cmd: string) => (cmd === '^XA^HH^XZ' ? state.config : '')),
    send: vi.fn(async (_zpl: string) => undefined),
    identify: vi.fn(async () => ({ model: 'ZD421-203dpi ZPL', firmware: 'V92', dotsPerMm: 8, memory: '8192KB', dpi: 203 })),
    status: vi.fn(async () => status),
    log: [{ at: '2026-09-12T00:00:00Z', command: '~HI', response: 'ZD421' }],
    clearLog: vi.fn(),
  };
  return { printer, state };
}

function setup(config?: string) {
  const { printer, state } = fakePrinter(config);
  const onClose = vi.fn();
  render(<PrinterSetupModal printer={printer} vocab={vocab} identity={{ model: 'ZD421-203dpi ZPL', firmware: 'V92', dotsPerMm: 8, memory: '8192KB', dpi: 203 }} onClose={onClose} />);
  return { printer, state, onClose };
}

describe('PrinterSetupModal', () => {
  it('Identify reads the configuration and shows it', async () => {
    const { printer } = setup();
    expect(screen.getByText('Full printer setup')).toBeTruthy();
    await waitFor(() => expect(printer.query).toHaveBeenCalledWith('^XA^HH^XZ'));
    expect(await screen.findByText('GAP/NOTCH')).toBeTruthy();
    expect(screen.getByText('DIRECT-THERMAL')).toBeTruthy();
    expect(screen.getByText('V72.19.15Z')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
  });
  it('Media: applies only changed settings, re-reads, and confirms', async () => {
    const { printer, state } = setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('radio', { name: /Gap \/ notch/ }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('radio', { name: /Continuous/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Cutter/ }));
    state.config = HH({ 'MEDIA TYPE': 'CONTINUOUS', 'PRINT MODE': 'CUTTER' });
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^MNN^XZ'));
    expect(printer.send).toHaveBeenCalledWith('^XA^MMC^XZ');
    expect(printer.send).not.toHaveBeenCalledWith('^XA^MTD^XZ');
    expect(await screen.findByText('Media tracking confirmed')).toBeTruthy();
    expect(screen.getByText('Print mode confirmed')).toBeTruthy();
  });
  it('Media: reports a value the printer did not take', async () => {
    const { printer } = setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('radio', { name: /Black mark/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^MNM^XZ'));
    expect(await screen.findByText('Media tracking: printer reports GAP/NOTCH')).toBeTruthy();
  });
  it('Calibrate sends ~JC', async () => {
    const { printer } = setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Calibrate media' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('~JC'));
  });
  it('Print quality: darkness and speed apply and confirm', async () => {
    const { printer, state } = setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('Darkness'), { target: { value: '14' } });
    fireEvent.change(screen.getByLabelText('Print speed'), { target: { value: '4' } });
    state.config = HH({ DARKNESS: '+14.0', 'PRINT SPEED': '4.0 IPS' });
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('~SD14'));
    expect(printer.send).toHaveBeenCalledWith('^XA^PR4^XZ');
    expect(await screen.findByText('Darkness confirmed')).toBeTruthy();
  });
  it('Save & verify: save, config label, alignment, guarded factory reset', async () => {
    const { printer } = setup();
    await screen.findByText('GAP/NOTCH');
    for (let i = 0; i < 3; i++) await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save to printer' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^JUS^XZ'));
    await userEvent.click(screen.getByRole('button', { name: 'Print configuration label' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('~WC'));
    await userEvent.click(screen.getByRole('button', { name: 'Print alignment test' }));
    await waitFor(() => expect(printer.send.mock.calls.some((c) => String(c[0]).includes('ALIGN 4x2 203DPI'))).toBe(true));
    const reset = screen.getByRole('button', { name: 'Restore factory defaults' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Type RESET to confirm'), 'RESET');
    expect(reset.disabled).toBe(false);
    await userEvent.click(reset);
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA^JUF^XZ'));
  });
  it('shows the command log', async () => {
    setup();
    await screen.findByText('GAP/NOTCH');
    await userEvent.click(screen.getByText('Command log'));
    expect(screen.getByText(/~HI/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: `zebraSetup.ts`**

```ts
// portal/src/labels/zebraSetup.ts
/** Pure logic for the Full printer setup wizard: choices derived from a
 *  `^HH` configuration, the commands to apply a change (only what
 *  changed), and confirm-by-re-read checks. */
import {
  setDarkness, setLabelSize, setMediaTracking, setPrintMethod, setPrintMode, setPrintSpeed,
  type MediaTracking, type PrintMethod, type PrintMode,
} from './zebraCommands';
import type { PrinterConfiguration } from './zebraUsb';

export interface MediaChoices {
  tracking: MediaTracking | null; method: PrintMethod | null; mode: PrintMode | null;
  widthDots: number | null; lengthDots: number | null;
}

const has = (v: string | null | undefined, needle: string) => (v ?? '').toUpperCase().includes(needle);

export function trackingFromMediaType(v: string | null): MediaTracking | null {
  if (has(v, 'GAP') || has(v, 'NOTCH') || has(v, 'WEB')) return 'W';
  if (has(v, 'MARK')) return 'M';
  if (has(v, 'CONTIN')) return 'N';
  return null;
}
export function methodFromPrintMethod(v: string | null): PrintMethod | null {
  if (has(v, 'DIRECT')) return 'D';
  if (has(v, 'THERMAL-TRANS') || has(v, 'TRANSFER')) return 'T';
  return null;
}
export function modeFromPrintMode(v: string | null): PrintMode | null {
  if (has(v, 'TEAR')) return 'T';
  if (has(v, 'PEEL')) return 'P';
  if (has(v, 'CUT')) return 'C';
  if (has(v, 'REWIND')) return 'R';
  return null;
}

export function mediaChoicesFromConfig(c: PrinterConfiguration | null): MediaChoices {
  if (!c) return { tracking: null, method: null, mode: null, widthDots: null, lengthDots: null };
  return {
    tracking: trackingFromMediaType(c.mediaType), method: methodFromPrintMethod(c.printMethod),
    mode: modeFromPrintMode(c.printMode), widthDots: c.printWidth, lengthDots: c.labelLength,
  };
}

export function commandsForMedia(current: MediaChoices, next: MediaChoices): string[] {
  const out: string[] = [];
  if (next.tracking && next.tracking !== current.tracking) out.push(setMediaTracking(next.tracking));
  if (next.method && next.method !== current.method) out.push(setPrintMethod(next.method));
  if (next.mode && next.mode !== current.mode) out.push(setPrintMode(next.mode));
  if (next.widthDots !== null && next.lengthDots !== null
      && (next.widthDots !== current.widthDots || next.lengthDots !== current.lengthDots)) {
    out.push(setLabelSize(next.widthDots, next.lengthDots));
  }
  return out;
}

export function confirmMedia(c: PrinterConfiguration | null, next: MediaChoices) {
  if (!c) return { tracking: null, method: null, mode: null, size: null } as Record<'tracking' | 'method' | 'mode' | 'size', boolean | null>;
  return {
    tracking: next.tracking === null ? null : trackingFromMediaType(c.mediaType) === next.tracking,
    method: next.method === null ? null : methodFromPrintMethod(c.printMethod) === next.method,
    mode: next.mode === null ? null : modeFromPrintMode(c.printMode) === next.mode,
    size: next.widthDots === null || next.lengthDots === null ? null : c.printWidth === next.widthDots && c.labelLength === next.lengthDots,
  };
}

export interface QualityChoices { darkness: number | null; speed: number | null }

export function qualityFromConfig(c: PrinterConfiguration | null): QualityChoices {
  return { darkness: c?.darkness ?? null, speed: c?.printSpeed ?? null };
}

export function commandsForQuality(current: QualityChoices, next: QualityChoices): string[] {
  const out: string[] = [];
  if (next.darkness !== null && next.darkness !== current.darkness) out.push(setDarkness(next.darkness));
  if (next.speed !== null && next.speed !== current.speed) out.push(setPrintSpeed(next.speed));
  return out;
}

export function confirmQuality(c: PrinterConfiguration | null, next: QualityChoices) {
  return {
    darkness: next.darkness === null || c?.darkness == null ? null : Math.abs(c.darkness - next.darkness) < 0.5,
    speed: next.speed === null || c?.printSpeed == null ? null : c.printSpeed === next.speed,
  } as Record<'darkness' | 'speed', boolean | null>;
}
```

- [ ] **Step 4: `PrinterSetupModal.tsx`**

```tsx
// portal/src/components/printers/PrinterSetupModal.tsx
/**
 * Printers › Full printer setup — a stepped wizard (Identify › Media ›
 * Print quality › Save & verify) against the connected Zebra. Every
 * Apply sends only the changed commands, re-reads `^HH`, and marks each
 * value confirmed or "printer reports X". A Command log disclosure shows
 * the hook's log so support can see exactly what was sent.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type { LabelVocab } from '../../lib/api';
import { sizeMeta, vocabOfKind } from '../../lib/labels';
import { alignmentTestZpl, applyPrintSettings, readPrintSettings } from '../../lib/printLabels';
import type { ZebraPrinter } from '../../lib/useZebraPrinter';
import {
  CALIBRATE, FACTORY_DEFAULTS, PRINT_CONFIGURATION_LABEL, SAVE_SETTINGS, configurationQuery,
} from '../../labels/zebraCommands';
import {
  commandsForMedia, commandsForQuality, confirmMedia, confirmQuality, mediaChoicesFromConfig, qualityFromConfig,
  type MediaChoices, type QualityChoices,
} from '../../labels/zebraSetup';
import { parseConfiguration, type HostIdentification, type HostStatus, type PrinterConfiguration } from '../../labels/zebraUsb';
import ComboBox from '../ComboBox';
import { ChoiceCard } from '../reports/ReportOptionsLayout';
import PrinterHealth from './PrinterHealth';

type Step = 'identify' | 'media' | 'quality' | 'save';
const STEPS: { id: Step; label: string }[] = [
  { id: 'identify', label: 'Identify' }, { id: 'media', label: 'Media' }, { id: 'quality', label: 'Print quality' }, { id: 'save', label: 'Save & verify' },
];
const SETTLE_MS = 750;

interface Props {
  printer: Pick<ZebraPrinter, 'query' | 'send' | 'identify' | 'status' | 'log' | 'clearLog' | 'productName'>;
  vocab: LabelVocab[];
  identity: HostIdentification | null;
  onClose: () => void;
}

const CONFIG_ITEMS: { key: keyof PrinterConfiguration; label: string; fmt?: (v: number) => string }[] = [
  { key: 'darkness', label: 'Darkness' }, { key: 'printSpeed', label: 'Print speed', fmt: (v) => `${v} ips` },
  { key: 'printMode', label: 'Print mode' }, { key: 'mediaType', label: 'Media type' }, { key: 'printMethod', label: 'Print method' },
  { key: 'printWidth', label: 'Print width', fmt: (v) => `${v} dots` }, { key: 'labelLength', label: 'Label length', fmt: (v) => `${v} dots` },
  { key: 'firmware', label: 'Firmware' },
];

export default function PrinterSetupModal({ printer, vocab, identity: identityIn, onClose }: Props) {
  const [step, setStep] = useState<Step>('identify');
  const [identity, setIdentity] = useState(identityIn);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [config, setConfig] = useState<PrinterConfiguration | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [media, setMedia] = useState<MediaChoices>(mediaChoicesFromConfig(null));
  const [mediaResult, setMediaResult] = useState<ReturnType<typeof confirmMedia> | null>(null);
  const [quality, setQuality] = useState<QualityChoices>({ darkness: null, speed: null });
  const [qualityResult, setQualityResult] = useState<ReturnType<typeof confirmQuality> | null>(null);
  const [sizeKey, setSizeKey] = useState('');
  const [resetText, setResetText] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const dpi = identity?.dpi ?? 203;
  const sizes = useMemo(() => vocabOfKind(vocab, 'size'), [vocab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const readAll = async () => {
    setReading(true);
    setError('');
    try {
      const [id, st, cfgText] = [await printer.identify(), await printer.status(), await printer.query(configurationQuery())];
      if (id) setIdentity(id);
      setStatus(st);
      const cfg = parseConfiguration(cfgText);
      setConfig(cfg);
      if (!cfg) setError("Couldn't read the printer's configuration (^HH).");
      const m = mediaChoicesFromConfig(cfg);
      setMedia(m);
      setQuality(qualityFromConfig(cfg));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Printer read failed');
    } finally {
      setReading(false);
    }
  };
  useEffect(() => { void readAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const reread = async () => {
    const cfg = parseConfiguration(await printer.query(configurationQuery()));
    setConfig(cfg);
    return cfg;
  };

  const applyMedia = async () => {
    setBusy(true); setError(''); setMediaResult(null);
    try {
      const size = sizes.find((s) => s.key === sizeKey);
      const next: MediaChoices = size
        ? { ...media, widthDots: Math.round(sizeMeta(size).width_in * dpi), lengthDots: Math.round(sizeMeta(size).height_in * dpi) }
        : media;
      for (const cmd of commandsForMedia(mediaChoicesFromConfig(config), next)) await printer.send(cmd);
      await sleep(SETTLE_MS);
      const cfg = await reread();
      setMediaResult(confirmMedia(cfg, next));
      setMedia(next);
    } catch (err) { setError(err instanceof Error ? err.message : 'Apply failed'); } finally { setBusy(false); }
  };

  const applyQuality = async () => {
    setBusy(true); setError(''); setQualityResult(null);
    try {
      for (const cmd of commandsForQuality(qualityFromConfig(config), quality)) await printer.send(cmd);
      await sleep(SETTLE_MS);
      setQualityResult(confirmQuality(await reread(), quality));
    } catch (err) { setError(err instanceof Error ? err.message : 'Apply failed'); } finally { setBusy(false); }
  };

  const sendOne = async (cmd: string, done: string) => {
    setBusy(true); setError(''); setSaveNotice('');
    try { await printer.send(cmd); setSaveNotice(done); } catch (err) { setError(err instanceof Error ? err.message : 'Command failed'); } finally { setBusy(false); }
  };

  const printAlignment = async () => {
    const size = sizes.find((s) => s.key === (sizeKey || '4x2')) ?? sizes[0];
    if (!size) return;
    const { width_in, height_in } = sizeMeta(size);
    const zpl = applyPrintSettings(alignmentTestZpl(Math.round(width_in * dpi), Math.round(height_in * dpi), size.key, dpi), readPrintSettings(), { singleCopy: true });
    await sendOne(zpl, `Alignment test label (${size.key}) sent to printer`);
  };

  const confirmLine = (label: string, ok: boolean | null, reported: string | null) => ok === null ? null : (
    <span key={label} className={`chip ${ok ? 'c-green' : 'c-amber'}`}>{ok ? `${label} confirmed` : `${label}: printer reports ${reported ?? 'unknown'}`}</span>
  );

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const next = () => setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)].id);
  const back = () => setStep(STEPS[Math.max(stepIndex - 1, 0)].id);

  let body: ReactNode;
  if (step === 'identify') {
    body = (
      <>
        <PrinterHealth identity={identity} status={status} productName={printer.productName} />
        <div className="modal-section">Current configuration</div>
        {reading && !config ? <p className="page-hint">Reading the printer…</p> : config ? (
          <div className="zp-config-grid">
            {CONFIG_ITEMS.map((it) => {
              const v = config[it.key];
              const text = v === null || v === undefined ? '—' : typeof v === 'number' && it.fmt ? it.fmt(v) : String(v);
              return <div key={it.key} className="zp-config-item"><span className="cell-sub">{it.label}</span><span className="cell-top">{text}</span></div>;
            })}
          </div>
        ) : <p className="page-hint">No configuration read yet.</p>}
      </>
    );
  } else if (step === 'media') {
    body = (
      <>
        <div className="modal-section">Media tracking</div>
        <div className="zp-choices" role="radiogroup" aria-label="Media tracking">
          {([['W', 'Gap / notch', 'Die-cut labels with a gap or notch between them'], ['M', 'Black mark', 'Labels with a black mark on the back'], ['N', 'Continuous', 'Continuous stock, no gaps']] as const).map(([v, t, d]) => (
            <ChoiceCard key={v} title={t} description={d} selected={media.tracking === v} onSelect={() => setMedia({ ...media, tracking: v })} />
          ))}
        </div>
        <div className="modal-section">Print method</div>
        <div className="zp-choices" role="radiogroup" aria-label="Print method">
          {([['D', 'Direct thermal', 'Heat-sensitive labels, no ribbon'], ['T', 'Thermal transfer', 'Ribbon required']] as const).map(([v, t, d]) => (
            <ChoiceCard key={v} title={t} description={d} selected={media.method === v} onSelect={() => setMedia({ ...media, method: v })} />
          ))}
        </div>
        <div className="modal-section">Print mode</div>
        <div className="zp-choices" role="radiogroup" aria-label="Print mode">
          {([['T', 'Tear-off', 'Labels stop at the tear bar'], ['P', 'Peel', 'Backing peels away after each label'], ['C', 'Cutter', 'Each label is cut']] as const).map(([v, t, d]) => (
            <ChoiceCard key={v} title={t} description={d} selected={media.mode === v} onSelect={() => setMedia({ ...media, mode: v })} />
          ))}
        </div>
        <div className="modal-section">Label size</div>
        <ComboBox options={sizes.map((s) => ({ value: s.key, label: s.label }))} value={sizeKey} onChange={setSizeKey} placeholder="Keep the printer's current size…" clearable />
        <p className="page-hint">{sizeKey ? `Sets ^PW/^LL for ${sizes.find((s) => s.key === sizeKey)?.label} at ${dpi} DPI.` : `Current: ${media.widthDots ?? '—'} × ${media.lengthDots ?? '—'} dots.`}</p>
        <div className="zp-actions">
          <button type="button" className="mini-btn" disabled={busy} onClick={() => void sendOne(CALIBRATE, 'Calibration started — the printer feeds a few labels.')}>Calibrate media</button>
          <span className="cell-sub">Calibration feeds a few labels while the sensor learns the media.</span>
        </div>
        {mediaResult && (
          <div className="zp-chips">
            {confirmLine('Media tracking', mediaResult.tracking, config?.mediaType ?? null)}
            {confirmLine('Print method', mediaResult.method, config?.printMethod ?? null)}
            {confirmLine('Print mode', mediaResult.mode, config?.printMode ?? null)}
            {confirmLine('Label size', mediaResult.size, config ? `${config.printWidth ?? '—'} × ${config.labelLength ?? '—'}` : null)}
          </div>
        )}
      </>
    );
  } else if (step === 'quality') {
    body = (
      <>
        <div className="modal-section">Darkness</div>
        <div className="zp-range">
          <input type="range" min={0} max={30} step={1} aria-label="Darkness" value={quality.darkness ?? 10} onChange={(e) => setQuality({ ...quality, darkness: Number(e.target.value) })} />
          <span className="mono">{quality.darkness ?? '—'}</span>
        </div>
        <p className="page-hint">0–30. Higher prints darker and wears the head faster.</p>
        <div className="modal-section">Print speed</div>
        <div className="zp-range">
          <input type="range" min={2} max={14} step={1} aria-label="Print speed" value={quality.speed ?? 6} onChange={(e) => setQuality({ ...quality, speed: Number(e.target.value) })} />
          <span className="mono">{quality.speed ?? '—'} ips</span>
        </div>
        <p className="page-hint">2–14 inches per second. Slower is crisper on barcodes.</p>
        {qualityResult && (
          <div className="zp-chips">
            {confirmLine('Darkness', qualityResult.darkness, config?.darkness != null ? String(config.darkness) : null)}
            {confirmLine('Print speed', qualityResult.speed, config?.printSpeed != null ? `${config.printSpeed} ips` : null)}
          </div>
        )}
      </>
    );
  } else {
    body = (
      <>
        <p className="page-hint">Settings live in the printer's working memory until saved. Save to keep them across a power cycle.</p>
        <div className="zp-actions">
          <button type="button" className="btn-solid" disabled={busy} onClick={() => void sendOne(SAVE_SETTINGS, 'Settings saved to the printer.')}>Save to printer</button>
          <button type="button" className="mini-btn" disabled={busy} onClick={() => void sendOne(PRINT_CONFIGURATION_LABEL, 'Configuration label sent to printer.')}>Print configuration label</button>
          <button type="button" className="mini-btn" disabled={busy} onClick={() => void printAlignment()}>Print alignment test</button>
        </div>
        {saveNotice && <div className="zp-notice success" role="status"><p className="page-hint">{saveNotice}</p></div>}
        <div className="modal-section">Danger zone</div>
        <div className="zp-guard">
          <label htmlFor="zp-reset" className="cell-sub">Type RESET to confirm</label>
          <input id="zp-reset" aria-label="Type RESET to confirm" value={resetText} onChange={(e) => setResetText(e.target.value)} />
          <button type="button" className="mini-btn danger" disabled={busy || resetText !== 'RESET'}
                  onClick={() => { setResetText(''); void sendOne(FACTORY_DEFAULTS, 'Factory defaults restored — re-run Identify to see the new configuration.'); }}>Restore factory defaults</button>
        </div>
      </>
    );
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card zp-setup-card" role="dialog" aria-label="Full printer setup">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Printers</div>
            <h3>Full printer setup</h3>
            <p className="page-hint">Guided configuration for the connected Zebra printer. Each step sends the commands and reads the printer back to confirm.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="rgm-steps">
          {STEPS.map((s, i) => (
            <span key={s.id} style={{ display: 'contents' }}>
              {i > 0 && <span className="rgm-step-sep" />}
              <span className={`rgm-step ${step === s.id ? 'on' : ''} ${i < stepIndex ? 'done' : ''}`}>
                <span className="rgm-step-num">{i + 1}</span><span className="rgm-step-label">{s.label}</span>
              </span>
            </span>
          ))}
        </div>
        <div className="modal-body">
          <div className="zp-col">{body}</div>
          {error && <div className="zp-notice error" role="alert"><p className="page-hint">{error}</p></div>}
          <details className="zp-log">
            <summary className="cell-sub">Command log ({printer.log.length})</summary>
            <pre className="mono">{printer.log.map((e) => `${e.at.slice(11, 19)}  ${e.command}${e.response ? `\n          ← ${e.response.replace(/[\x02\x03]/g, '')}` : ''}`).join('\n')}</pre>
          </details>
        </div>
        <div className="modal-foot">
          {step === 'identify' && <button type="button" className="mini-btn" disabled={reading || busy} onClick={() => void readAll()}>Refresh</button>}
          {step !== 'identify' && <button type="button" className="mini-btn" disabled={busy} onClick={back}>Back</button>}
          {step === 'media' && <button type="button" className="btn-solid" disabled={busy || !config} onClick={() => void applyMedia()}>Apply</button>}
          {step === 'quality' && <button type="button" className="btn-solid" disabled={busy || !config} onClick={() => void applyQuality()}>Apply</button>}
          {step !== 'save' && <button type="button" className={step === 'identify' ? 'btn-solid' : 'mini-btn'} disabled={busy} onClick={next}>Next</button>}
          {step === 'save' && <button type="button" className="btn-solid" disabled={busy} onClick={onClose}>Done</button>}
        </div>
      </div>
    </div>
  );
}
```

`ChoiceCard`'s accessible name is its title, so `getByRole('radio', { name: /Gap \/ notch/ })` matches. The "Type RESET to confirm" input has both a `<label htmlFor>` and an `aria-label` (the guardrail is fine: it's not inside a list row).

- [ ] **Step 5: Run tests + guardrail + tsc** — `npx vitest run src/labels/zebraSetup.test.ts src/components/printers/PrinterSetupModal.test.tsx src/styles/listTypography.test.ts && npx tsc -b`. Timing: Apply sleeps 750 ms, so the `findByText(... confirmed)` assertions need `{}, { timeout: 3000 }` if the default 1 s races.

- [ ] **Step 6: Commit**

```bash
git add portal/src/labels/zebraSetup.ts portal/src/labels/zebraSetup.test.ts portal/src/components/printers/PrinterSetupModal.tsx portal/src/components/printers/PrinterSetupModal.test.tsx
git commit -m "feat(portal): Full printer setup wizard (identify, media, print quality, save & verify) with confirm-by-re-read

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The Printers page

**Files:**
- Rewrite: `portal/src/pages/Printers.tsx`
- Rewrite: `portal/src/pages/Printers.test.tsx`

**Interfaces:**
- Consumes everything above by exact name plus `useAuth().can('labels', 'add' | 'delete')`, `listLabelVocab`, `listLabelFonts`, `uploadLabelFont`, `deleteLabelFont`, `getLabelFontBytes`.
- Produces: the page. Brother tab untouched. `labelsNav.test.tsx` unchanged.

- [ ] **Step 1: Rewrite the test**

```tsx
// portal/src/pages/Printers.test.tsx
// @vitest-environment jsdom
/** Labels → Printers: the Zebra tab's printer card (connect, known printers,
 *  identity/health), the three tool rows gated on a connection, and the
 *  modals they open; the Brother tab stays a placeholder. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelVocab } from '../lib/api';

const api = vi.hoisted(() => ({ listLabelVocab: vi.fn(), listLabelFonts: vi.fn(), uploadLabelFont: vi.fn(), deleteLabelFont: vi.fn(), getLabelFontBytes: vi.fn() }));
vi.mock('../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../lib/api')>()), ...api }));

const printer = vi.hoisted(() => ({
  supported: true, connected: false, productName: null as string | null, notice: null as null | { type: string; message: string },
  clearNotice: vi.fn(), connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), connectTo: vi.fn(async () => undefined),
  send: vi.fn(async () => undefined), query: vi.fn(async () => ''), sendBytes: vi.fn(async () => undefined), waitForIdle: vi.fn(async () => undefined),
  identify: vi.fn(async () => ({ model: 'ZD421-203dpi ZPL', firmware: 'V92.21.16Z', dotsPerMm: 8, memory: '8192KB', dpi: 203 })),
  status: vi.fn(async () => ({ paperOut: true, paused: false, labelLength: 0, formatsQueued: 0, bufferFull: false, partialFormat: false, corruptRam: false, underTemp: false, overTemp: false, headOpen: false, ribbonOut: false, thermalTransfer: false, printMode: '0', labelWaiting: false, labelsRemaining: 0 })),
  knownDevices: vi.fn(async () => [] as unknown[]), log: [] as unknown[], clearLog: vi.fn(),
}));
vi.mock('../lib/useZebraPrinter', () => ({ useZebraPrinter: () => printer }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn() }) }));
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { default: Printers } = await import('./Printers');

const vocab: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: null },
];

beforeEach(() => {
  printer.connected = false; printer.productName = null; printer.notice = null;
  printer.knownDevices.mockResolvedValue([]);
  api.listLabelVocab.mockResolvedValue(vocab);
  api.listLabelFonts.mockResolvedValue([]);
});
afterEach(cleanup);

it('shows the three tools disconnected with gated actions, and Connect via USB', async () => {
  render(<Printers />);
  expect(screen.getByText('Test Label Alignment')).toBeTruthy();
  expect(screen.getByText('Install Fonts')).toBeTruthy();
  expect(screen.getByText('Full Printer Setup')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Print test label' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Start setup' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Manage fonts' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getAllByText('Connect a printer first').length).toBe(2);
  await userEvent.click(screen.getByRole('button', { name: 'Connect via USB' }));
  expect(printer.connect).toHaveBeenCalled();
});

it('lists known printers and connects to one', async () => {
  const dev = { productName: 'ZD621' };
  printer.knownDevices.mockResolvedValue([dev]);
  render(<Printers />);
  await userEvent.click(await screen.findByRole('button', { name: 'Connect ZD621' }));
  expect(printer.connectTo).toHaveBeenCalledWith(dev);
});

it('when connected, shows identity and health and enables the tools', async () => {
  printer.connected = true; printer.productName = 'ZD421';
  render(<Printers />);
  expect(await screen.findByText('ZD421-203dpi ZPL')).toBeTruthy();
  expect(screen.getByText('Paper out')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Print test label' }) as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() => expect(printer.status).toHaveBeenCalledTimes(2));
});

it('opens the three modals', async () => {
  printer.connected = true; printer.productName = 'ZD421';
  render(<Printers />);
  await screen.findByText('ZD421-203dpi ZPL');
  await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
  expect(screen.getByRole('dialog', { name: 'Test label alignment' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  await userEvent.click(screen.getByRole('button', { name: 'Manage fonts' }));
  expect(screen.getByRole('dialog', { name: 'Install fonts' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  await userEvent.click(screen.getByRole('button', { name: 'Start setup' }));
  expect(screen.getByRole('dialog', { name: 'Full printer setup' })).toBeTruthy();
});

it('unsupported browsers get an explanation instead of the connect button', () => {
  printer.supported = false;
  render(<Printers />);
  expect(screen.getByText('USB printing needs Chrome or Edge on a secure (https or localhost) address.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Connect via USB' })).toBeNull();
  printer.supported = true;
});

it('the Brother tab stays a placeholder', async () => {
  render(<Printers />);
  await userEvent.click(screen.getByRole('tab', { name: 'Brother Printers' }));
  expect(screen.getByText('Brother printer tools are coming soon.')).toBeTruthy();
  expect(screen.queryByText('Test Label Alignment')).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure** — the old page has no buttons.

- [ ] **Step 3: Rewrite `Printers.tsx`**

```tsx
// portal/src/pages/Printers.tsx
/**
 * Labels → Printers. Zebra tab: a printer card for the browser-connected
 * (WebUSB) Zebra — connect/disconnect, previously authorized printers,
 * identity (`~HI`) and health (`~HS`) chips — over the three tool rows
 * (Test Label Alignment / Install Fonts / Full Printer Setup) that open
 * their modals. Brother tab: placeholder. No printer registry (spec).
 */
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import {
  deleteLabelFont, getLabelFontBytes, listLabelFonts, listLabelVocab, uploadLabelFont,
  type LabelFont, type LabelVocab,
} from '../lib/api';
import { useZebraPrinter } from '../lib/useZebraPrinter';
import type { HostIdentification, HostStatus, UsbDeviceLike } from '../labels/zebraUsb';
import AlignmentTestModal from '../components/printers/AlignmentTestModal';
import InstallFontsModal from '../components/printers/InstallFontsModal';
import PrinterHealth from '../components/printers/PrinterHealth';
import PrinterSetupModal from '../components/printers/PrinterSetupModal';
import '../styles/access.css';
import '../styles/directory.css';
import '../styles/reports.css';   /* rgm-* modal header/steps, ChoiceCard */
import '../styles/labels.css';
import '../styles/printers.css';

type Tab = 'zebra' | 'brother';
const TABS: { id: Tab; label: string }[] = [{ id: 'zebra', label: 'Zebra Printers' }, { id: 'brother', label: 'Brother Printers' }];

type Tool = 'alignment' | 'fonts' | 'setup';
const ZEBRA_TOOLS: { key: Tool; title: string; description: string; action: string; needsPrinter: boolean }[] = [
  { key: 'alignment', title: 'Test Label Alignment', description: 'Print a calibration label and dial in offsets.', action: 'Print test label', needsPrinter: true },
  { key: 'fonts', title: 'Install Fonts', description: "Push the house label fonts to the printer's storage.", action: 'Manage fonts', needsPrinter: false },
  { key: 'setup', title: 'Full Printer Setup', description: 'Guided first-time configuration for a new Zebra printer.', action: 'Start setup', needsPrinter: true },
];

export default function Printers() {
  const [tab, setTab] = useState<Tab>('zebra');
  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Labels</div>
          <h1 className="page-title">Printers</h1>
          <p className="page-hint">Zebra and Brother label printers — configuration and tools for the printer connected to this computer.</p>
        </div>
      </div>
      <div className="subs-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="access-tab-panel">
        {tab === 'zebra' && <ZebraTab />}
        {tab === 'brother' && <div className="dir-empty">Brother printer tools are coming soon.</div>}
      </div>
    </div>
  );
}

function ZebraTab() {
  const printer = useZebraPrinter();
  const { can } = useAuth();
  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [fonts, setFonts] = useState<LabelFont[] | null>(null);
  const [identity, setIdentity] = useState<HostIdentification | null>(null);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [known, setKnown] = useState<UsbDeviceLike[]>([]);
  const [tool, setTool] = useState<Tool | null>(null);
  const [notice, setNotice] = useState<{ type: string; message: string } | null>(null);

  useEffect(() => {
    listLabelVocab().then(setVocab).catch(() => setNotice({ type: 'error', message: "Couldn't load label sizes." }));
    void printer.knownDevices().then(setKnown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (printer.notice) { setNotice(printer.notice); printer.clearNotice(); }
  }, [printer.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadFonts = useCallback(() => {
    listLabelFonts().then(setFonts).catch(() => setNotice({ type: 'error', message: "Couldn't load the font library." }));
  }, []);
  useEffect(() => { loadFonts(); }, [loadFonts]);

  const refreshStatus = useCallback(async () => {
    if (!printer.connected) { setIdentity(null); setStatus(null); return; }
    try {
      setIdentity(await printer.identify());
      setStatus(await printer.status());
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : "Couldn't read the printer." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printer.connected]);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const printZpl = async (zpl: string) => { await printer.send(zpl); };

  return (
    <>
      {notice && (
        <div className={`zp-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
          <p className="page-hint">{notice.message}</p>
          <button type="button" className="mini-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      <section className="zp-card" aria-label="Printer">
        <div className="zp-card-head">
          <div>
            <span className="eyebrow">Connected printer</span>
            <div className="modal-section">Printer</div>
          </div>
          <div className="zp-printer-actions">
            {printer.connected && <button type="button" className="mini-btn" onClick={() => void refreshStatus()}>Refresh status</button>}
            {!printer.supported ? null : printer.connected
              ? <button type="button" className="btn-ghost" onClick={() => void printer.disconnect()}>Disconnect</button>
              : <button type="button" className="btn-solid" onClick={() => void printer.connect()}>Connect via USB</button>}
          </div>
        </div>
        <div className="zp-printer-status">
          <span className={`dot ${printer.connected ? 'on' : 'off'}`} />
          <span className="cell-top">{printer.connected ? `Printer connected${printer.productName ? ` · ${printer.productName}` : ''}` : 'No printer connected'}</span>
        </div>
        {!printer.supported && <p className="page-hint">USB printing needs Chrome or Edge on a secure (https or localhost) address.</p>}
        {printer.connected && <PrinterHealth identity={identity} status={status} productName={printer.productName} />}
        {!printer.connected && known.length > 0 && (
          <div className="zp-known">
            <span className="cell-sub">Known printers:</span>
            {known.map((d, i) => (
              <button key={i} type="button" className="mini-btn" onClick={() => void printer.connectTo(d)}>Connect {d.productName || 'Zebra printer'}</button>
            ))}
          </div>
        )}
        <p className="page-hint">Requires a Zebra printer connected via USB. Make sure the printer is turned on before connecting.</p>
      </section>

      <div className="dir-list">
        {ZEBRA_TOOLS.map((t) => {
          const gated = t.needsPrinter && !printer.connected;
          return (
            <div key={t.key} className="dir-row">
              <div className="row-main zp-tool-row">
                <div className="cell">
                  <div className="cell-top"><b>{t.title}</b></div>
                  <div className="cell-sub">{t.description}</div>
                </div>
                <div className="cell zp-tool-action">
                  {gated && <span className="cell-sub">Connect a printer first</span>}
                  <button type="button" className="btn-solid" disabled={gated} onClick={() => setTool(t.key)}>{t.action}</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {tool === 'alignment' && <AlignmentTestModal vocab={vocab} printerDpi={identity?.dpi ?? null} onPrint={printZpl} onClose={() => setTool(null)} />}
      {tool === 'fonts' && (
        <InstallFontsModal printer={printer} fonts={fonts} canAdd={can('labels', 'add')} canDelete={can('labels', 'delete')}
                           onUpload={async (file, name) => { await uploadLabelFont(file, name); loadFonts(); }}
                           onDeleteFont={async (id) => { await deleteLabelFont(id); loadFonts(); }}
                           onFetchBytes={getLabelFontBytes} onClose={() => setTool(null)} />
      )}
      {tool === 'setup' && <PrinterSetupModal printer={printer} vocab={vocab} identity={identity} onClose={() => { setTool(null); void refreshStatus(); }} />}
    </>
  );
}
```

`can` comes from `useAuth()` (`can(resource, action)`); `.btn-ghost` is defined in `chrome.css`, already loaded by the shell.

- [ ] **Step 4: Run** — `npx vitest run src/pages/Printers.test.tsx src/layout/labelsNav.test.tsx src/styles/listTypography.test.ts && npx tsc -b`. The guardrail's exemption notes already name `Printers.tsx`'s `ZebraTab` rows (`cell-top > b`); the new markup keeps that shape.

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/Printers.tsx portal/src/pages/Printers.test.tsx
git commit -m "feat(portal): Printers page — Zebra printer card (connect, known printers, identity/health) and the three tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Full verification, docs, live check

- [ ] **Step 1: Suites + build.** Portal (worktree `portal/`): `npx vitest run && npm run build`. API (worktree `api/`, foreground, 600000 ms): `SS_TEST_DB=serversherpa_test_zebra PYTHONPATH=$PWD/src /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q -x -p no:cacheprovider`. Both green; `git checkout -- api/src/serversherpa/_dev_reload.py` if it churned.
- [ ] **Step 2: Dev DB migration.** After merge, the running API needs `alembic upgrade head` on the dev DB (`api/.venv/bin/alembic -c api/alembic.ini upgrade head` from the main checkout, or however the repo runs migrations — check `api/README`/Makefile) and a restart so `label_fonts` exists.
- [ ] **Step 3: Live check** (browser, signed in as claude-dev): `/labels/printers` shows the printer card, three tool rows with gated buttons, Manage fonts opens with an empty library; upload a small valid TTF (generate one only if Jimmy hasn't supplied `85620388.TTF` — any TTF from the system, e.g. `/System/Library/Fonts/Supplemental/Arial.ttf` renamed, works for the library path) → it lists with size and no usage; remove it. With no printer the alignment/setup buttons stay disabled. With a stubbed `navigator.usb` (a fake device object injected via the console is enough to reach the connected state) verify identity/health chips, the alignment modal preview, and the wizard's Identify step. A physical Zebra is the only way to verify prints, font installs, and calibration.
- [ ] **Step 4: Ledger + memory** (`.superpowers/sdd/progress.md`; memory file `zebra-printer-tools-feature`).
- [ ] **Step 5: Report** suites, live evidence, and what needs hardware.
