# Reports + Move Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Reports area (definitions + run history), a standalone `report-worker` that renders PDFs from a module registry, the full eight-section Move Report (WeasyPrint + the portal's own rack SVG via a Node script), storage of every PDF in Spaces attached to the initiative's Notes & Files, and a minimal in-app notification inbox (bell + toast) — per `docs/superpowers/specs/2026-09-09-reports-move-report-design.md`.

**Architecture:** Three new tables (`report_definitions`, `report_runs`, `notifications`). The API only inserts queued runs; `serversherpa report-worker` claims them (SKIP LOCKED), dispatches on `report_type` to an explicit registry, uploads the PDF, creates an initiative `Attachment`, and writes an inbox row when asked. The Move Report module is four pure steps (gather → compute → rack SVGs → Jinja2/WeasyPrint). Rack elevations are rendered by `node portal/dist-node/render-rack.js`, a Vite SSR build of the portal's `RackElevation` component. Portal: `/reports` with Available/History tabs, a three-state Generate modal, and a `NotificationsProvider` feeding the bell and a toast host.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic; Jinja2 + WeasyPrint; Node 20 + React `renderToStaticMarkup`; React + vitest (jsdom).

## Global Constraints

- Branch `reports` (cut from `admin-controls-cleanup`). Do NOT rebase or merge other branches.
- Report types: only `move_report`. Option keys (verbatim, all booleans): `summary`, `assets_by_source`, `assets_by_destination`, `size_weight`, `rail_usage`, `collisions`, `source_racks`, `destination_racks`. Defaults all `true`.
- Run statuses (verbatim): `queued`, `running`, `completed`, `failed`. `error` truncated to 2000 chars.
- Storage key: `reports/{initiative_id}/{run_id}.pdf`. Filename: `Move Report - {initiative name} - {YYYY-MM-DD HHMM}.pdf` (local time of the worker host, `datetime.now()`).
- Attachment on completion: `entity_type="initiative"`, `kind="document"`, `content_type="application/pdf"`, `uploaded_by=run.requested_by`.
- Notification kinds (verbatim): `report_ready`, `report_failed`. `link` = `/reports?tab=history&run={run_id}`. `payload = {"run_id": "<uuid>"}`.
- History gate (SQL predicate, never post-filtering): `(requested_by = actor) OR (requested_rank <= actor.max_rank)` AND initiative passes `scope_conditions("initiatives", …)`.
- `requested_rank` comes from `actor.access.max_rank` server-side only.
- Timeouts: `RUN_TIMEOUT_SECONDS = 300`, `RACK_RENDER_TIMEOUT_SECONDS = 30`, `STALE_MINUTES = 15`.
- Error codes (verbatim, `{"detail": {"code": …}}`): `definition_not_found`, `name_in_use` (409), `system_definition` (409), `run_not_found`, `initiative_not_found`, `not_ready` (409), `forbidden` (403), `invalid_options` (422 with `"problems": [...]`).
- Access: resource `reports` (global anchor only). Grants: `developer`/`founder`/`super_admin`/`admin` FULL; `staff` `view, add`; nothing for client/vendor/worker/external roles.
- Copy (verbatim): nav section `Reports`, item `Reports`; page eyebrow `Reports`, title `Reports`; tabs `Available`, `History`; modal title `Generate {definition name}`; step-3 buttons `Notify me when it's ready`, `Close`, `Download`, `Try again`; paused line `Paused for maintenance — will resume automatically`; notify toast `We'll let you know when it's ready`; completion note `Also saved to the initiative's Files`; empty-sections hint `Turn on at least one section`.
- Section copy (verbatim, title / description):
  `Summary` / `Move info, locations, load summary, collision summary`;
  `Asset List - By Source` / `Assets sorted by source rack and RU`;
  `Asset List - By Destination` / `Assets sorted by destination rack and RU`;
  `Size and Weight Report` / `Total RU, weight, per-model breakdown`;
  `Rail Usage Report` / `Rail types summary and model breakdown`;
  `Collision Report` / `Overlapping RU assignment details`;
  `Source Rack Elevations` / `Visual rack diagrams for source racks`;
  `Destination Rack Elevations` / `Visual rack diagrams for destination racks`.
- Poll cadences: modal 2 s; History tab 3 s while any listed run is queued/running; inbox 30 s + `visibilitychange`.
- API tests: from `api/`, `.venv/bin/python -m pytest -q <files>`. Portal tests: from `portal/`, `npx vitest run <files>`; type-check with `npx tsc --noEmit -p .`. Always FOREGROUND, one continuous call, timeout 600000ms — never background.
- Before any commit: `git checkout -- api/src/serversherpa/_dev_reload.py`. Stage only files you changed.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Test helpers: `from tests.test_sites_api import login` (returns auth headers for `alice@test.example.com` — the `seeded_user` staff fixture) and `from tests.test_status_values_write import _make` (`await _make(db, client, role, email)` → headers for a fresh user with that role).

## File map

API (`api/src/serversherpa/…`):
- `db/models.py` — `ReportDefinition`, `ReportRun`, `Notification` (Task 1)
- `migrations/versions/0046_reports_and_inbox.py` — tables, seed, grants (Task 1)
- `notifications/inbox.py` — `notify()` (Task 1)
- `api/routes/notifications.py` — inbox endpoints (Task 1)
- `access/resources.py`, `access/defaults.py` — `reports` resource + grants (Task 2)
- `reports/__init__.py`, `reports/registry.py` — `ReportModule` protocol, `ReportResult`, `REGISTRY` (Task 2)
- `reports/move_report/__init__.py` — module entry (Task 2 stub → Task 6 real)
- `api/routes/reports.py`, `api/schemas.py`, `api/app.py` — definitions + runs API (Tasks 2–3)
- `reports/move_report/gather.py`, `compute.py` (Task 4); `reports/rack_renderer.py`, `move_report/racks.py` (Task 5); `move_report/render.py`, `move_report/templates/move_report.html` (Task 6)
- `reports/jobs.py`, `reports/worker.py`, `cli.py`, `config.py`, `Procfile.dev`, `README.md`, `pyproject.toml` (Task 7)

Portal (`portal/src/…`):
- `components/initiatives/RackElevation.tsx` (extracted), `styles/rack-svg.css`, `reports/renderRack.tsx`, `vite.rack-renderer.config.ts`, `package.json` (Task 5)
- `lib/api.ts` (reports + inbox functions), `lib/reports.ts` (sections, sort) (Task 8)
- `layout/navSections.tsx`, `App.tsx`, `components/Topbar.tsx` CRUMBS, `pages/Reports.tsx`, `components/reports/EditDefinitionModal.tsx`, `styles/reports.css` (Task 8)
- `components/reports/GenerateReportModal.tsx`, History tab in `pages/Reports.tsx` (Task 9)
- `lib/notificationsContext.tsx`, `components/ToastHost.tsx`, `components/Topbar.tsx` bell, `layout/AppShell.tsx`, `App.tsx` (Task 10)

---

### Task 1: Tables, models, inbox `notify()`, inbox API

**Files:**
- Create: `api/migrations/versions/0046_reports_and_inbox.py`
- Modify: `api/src/serversherpa/db/models.py` (append after `LabelTemplateSite`, end of file)
- Create: `api/src/serversherpa/notifications/inbox.py`
- Modify: `api/src/serversherpa/api/schemas.py` (append after `NotificationRecipientOut`, ~line 1800)
- Modify: `api/src/serversherpa/api/routes/notifications.py` (append routes at end; add imports)
- Modify: `api/tests/conftest.py:118-124` (TRUNCATE list)
- Test: `api/tests/test_notifications_inbox.py` (new)

**Interfaces:**
- Produces: models `ReportDefinition`, `ReportRun`, `Notification` (columns exactly as in the spec's Data model); `serversherpa.notifications.inbox.notify(db, person_id, kind, title, *, body="", link=None, payload=None) -> Notification` (adds to the caller's session, does NOT commit); `GET /notifications/inbox?unread_only=false` → `{"unread_count": int, "items": [NotificationInboxItemOut]}`; `POST /notifications/inbox/{id}/read` → 204; `POST /notifications/inbox/read-all` → 204. Tasks 3, 7, 10 consume these.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_notifications_inbox.py`:

```python
"""In-app notification inbox: notify() rows, list + unread count, read,
read-all, and the own-rows-only rule."""

from uuid import uuid4

from sqlalchemy import select

from serversherpa.db.models import Notification
from serversherpa.notifications.inbox import notify

from tests.test_sites_api import login
from tests.test_status_values_write import _make


async def test_notify_adds_row_without_committing(db, seeded_user):
    n = await notify(db, seeded_user.id, "report_ready", "Move Report is ready",
                     body="NAP11", link="/reports?tab=history&run=abc",
                     payload={"run_id": "abc"})
    assert n.read_at is None
    await db.commit()
    row = await db.scalar(select(Notification).where(Notification.person_id == seeded_user.id))
    assert row.kind == "report_ready"
    assert row.payload == {"run_id": "abc"}
    assert row.body == "NAP11"


async def test_inbox_lists_newest_first_with_unread_count(client, db, seeded_user):
    hdrs = await login(client)
    await notify(db, seeded_user.id, "report_ready", "First")
    await notify(db, seeded_user.id, "report_failed", "Second", body="boom")
    await db.commit()
    resp = await client.get("/notifications/inbox", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["unread_count"] == 2
    assert [i["title"] for i in body["items"]] == ["Second", "First"]
    assert body["items"][0]["read_at"] is None
    assert body["items"][0]["link"] is None


async def test_inbox_is_per_person(client, db, seeded_user):
    other = await _make(db, client, "staff", "bob@test.example.com")
    await notify(db, seeded_user.id, "report_ready", "Alice only")
    await db.commit()
    resp = await client.get("/notifications/inbox", headers=other)
    assert resp.json() == {"unread_count": 0, "items": []}


async def test_mark_read_and_read_all(client, db, seeded_user):
    hdrs = await login(client)
    a = await notify(db, seeded_user.id, "report_ready", "A")
    await notify(db, seeded_user.id, "report_ready", "B")
    await db.commit()
    resp = await client.post(f"/notifications/inbox/{a.id}/read", headers=hdrs)
    assert resp.status_code == 204
    body = (await client.get("/notifications/inbox", headers=hdrs)).json()
    assert body["unread_count"] == 1
    assert (await client.get("/notifications/inbox?unread_only=true",
                             headers=hdrs)).json()["items"][0]["title"] == "B"
    assert (await client.post("/notifications/inbox/read-all", headers=hdrs)).status_code == 204
    assert (await client.get("/notifications/inbox", headers=hdrs)).json()["unread_count"] == 0


async def test_mark_read_rejects_other_persons_row(client, db, seeded_user):
    other = await _make(db, client, "staff", "bob@test.example.com")
    a = await notify(db, seeded_user.id, "report_ready", "A")
    await db.commit()
    assert (await client.post(f"/notifications/inbox/{a.id}/read", headers=other)).status_code == 404
    assert (await client.post(f"/notifications/inbox/{uuid4()}/read", headers=other)).status_code == 404
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_notifications_inbox.py`
Expected: ImportError on `serversherpa.notifications.inbox`.

- [ ] **Step 3: Migration** — `api/migrations/versions/0046_reports_and_inbox.py`:

```python
"""Reports framework (definitions + runs) and the in-app notification inbox.

Seeds the system "Move Report" definition and the `reports` resource grants
(admin FULL; staff view+add; developer/founder/super_admin FULL).

Revision ID: 0046
Revises: 0045
Create Date: 2026-09-09
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import CITEXT, JSONB, UUID

revision: str = "0046"
down_revision: str | None = "0045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FULL = ("view", "add", "change", "delete")
GRANTS = {
    "developer": FULL, "founder": FULL, "super_admin": FULL, "admin": FULL,
    "staff": ("view", "add"),
}
MOVE_REPORT_DEFAULTS = (
    '{"summary": true, "assets_by_source": true, "assets_by_destination": true, '
    '"size_weight": true, "rail_usage": true, "collisions": true, '
    '"source_racks": true, "destination_racks": true}'
)


def upgrade() -> None:
    op.create_table(
        "report_definitions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", CITEXT(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("report_type", sa.Text(), nullable=False),
        sa.Column("options", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("people.id")),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("report_definitions_name_live_idx", "report_definitions",
                    ["name"], unique=True,
                    postgresql_where=sa.text("archived_at IS NULL"))
    op.create_table(
        "report_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("definition_id", UUID(as_uuid=True),
                  sa.ForeignKey("report_definitions.id"), nullable=False),
        sa.Column("report_type", sa.Text(), nullable=False),
        sa.Column("initiative_id", UUID(as_uuid=True),
                  sa.ForeignKey("initiatives.id"), nullable=False),
        sa.Column("options", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("error", sa.Text()),
        sa.Column("requested_by", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=False),
        sa.Column("requested_rank", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("notify", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("storage_key", sa.Text()),
        sa.Column("attachment_id", UUID(as_uuid=True), sa.ForeignKey("attachments.id")),
        sa.Column("filename", sa.Text()),
        sa.Column("size_bytes", sa.BigInteger()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("report_runs_status_created_idx", "report_runs", ["status", "created_at"])
    op.create_index("report_runs_initiative_idx", "report_runs", ["initiative_id"])
    op.create_index("report_runs_requester_idx", "report_runs", ["requested_by", "created_at"])
    op.create_table(
        "notifications",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("person_id", UUID(as_uuid=True), sa.ForeignKey("people.id"), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("link", sa.Text()),
        sa.Column("payload", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("read_at", sa.DateTime(timezone=True)),
    )
    op.create_index("notifications_person_idx", "notifications",
                    ["person_id", "read_at", "created_at"])

    conn = op.get_bind()
    conn.execute(sa.text(
        "INSERT INTO report_definitions (name, description, report_type, options, is_system) "
        "VALUES ('Move Report', 'The full move report: summary, asset lists, "
        "size/weight, rails, collisions and rack elevations.', 'move_report', "
        f"'{MOVE_REPORT_DEFAULTS}'::jsonb, true)"))
    for role, actions in GRANTS.items():
        for action in actions:
            conn.execute(sa.text(
                "INSERT INTO role_permissions (role, resource, action) "
                "VALUES (:r, 'reports', :a) ON CONFLICT DO NOTHING"),
                {"r": role, "a": action})


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM role_permissions WHERE resource = 'reports'"))
    op.drop_table("notifications")
    op.drop_table("report_runs")
    op.drop_table("report_definitions")
```

- [ ] **Step 4: Models** — append to `api/src/serversherpa/db/models.py`:

```python
class ReportDefinition(Base):
    """The Reports page's Available tab: a named report type + default
    section options. System rows are seeded and cannot be deleted."""
    __tablename__ = "report_definitions"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    name: Mapped[str] = mapped_column(CITEXT)
    description: Mapped[str] = mapped_column(server_default="")
    report_type: Mapped[str]
    options: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    is_system: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("people.id"))
    archived_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class ReportRun(Base):
    """One generation of a report: queued by the API, executed by the
    report-worker, stored in Spaces + attached to the initiative."""
    __tablename__ = "report_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    definition_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("report_definitions.id"))
    report_type: Mapped[str]
    initiative_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("initiatives.id"))
    options: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    status: Mapped[str] = mapped_column(server_default="queued")
    error: Mapped[str | None]
    requested_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    requested_rank: Mapped[int] = mapped_column(Integer, server_default="0")
    notify: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    storage_key: Mapped[str | None]
    attachment_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("attachments.id"))
    filename: Mapped[str | None]
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    started_at: Mapped[datetime | None]
    finished_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))


class Notification(Base):
    """Per-person in-app inbox row. Written only via notifications/inbox.py
    notify(); future channels (email…) fan out from that function."""
    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    person_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("people.id"))
    kind: Mapped[str]
    title: Mapped[str]
    body: Mapped[str] = mapped_column(server_default="")
    link: Mapped[str | None]
    payload: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
    read_at: Mapped[datetime | None]
```

- [ ] **Step 5: `notify()`** — `api/src/serversherpa/notifications/inbox.py`:

```python
"""The in-app inbox writer. `notify()` is the ONLY code path that creates
Notification rows; when email/SMS delivery arrives it fans out from here
and the table shape stays. Adds to the caller's session — never commits —
so a notification can't outlive a rolled-back mutation."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification


async def notify(db: AsyncSession, person_id: uuid.UUID, kind: str, title: str, *,
                 body: str = "", link: str | None = None,
                 payload: dict | None = None) -> Notification:
    row = Notification(person_id=person_id, kind=kind, title=title, body=body,
                       link=link, payload=payload or {})
    db.add(row)
    await db.flush()
    return row
```

- [ ] **Step 6: Schemas** — append to `api/src/serversherpa/api/schemas.py` after `NotificationRecipientOut`:

```python
class NotificationInboxItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: str
    title: str
    body: str
    link: str | None = None
    payload: dict
    created_at: datetime
    read_at: datetime | None = None


class NotificationInboxOut(BaseModel):
    unread_count: int
    items: list[NotificationInboxItemOut]
```

- [ ] **Step 7: Routes** — append to `api/src/serversherpa/api/routes/notifications.py` (add `CurrentUser` to the deps import, `Notification` to the models import, the two schemas to the schemas import, and `Response` from fastapi):

```python
# ── in-app inbox (any signed-in person; no resource permission) ──────

INBOX_LIMIT = 50


@router.get("/inbox", response_model=NotificationInboxOut)
async def inbox(user: CurrentUser, db: DbSession,
                unread_only: bool = False) -> NotificationInboxOut:
    base = select(Notification).where(Notification.person_id == user.person.id)
    unread = await db.scalar(
        select(func.count()).select_from(Notification).where(
            Notification.person_id == user.person.id, Notification.read_at.is_(None)))
    q = base.order_by(Notification.created_at.desc()).limit(INBOX_LIMIT)
    if unread_only:
        q = q.where(Notification.read_at.is_(None))
    items = (await db.scalars(q)).all()
    return NotificationInboxOut(unread_count=int(unread or 0), items=items)


@router.post("/inbox/{notification_id}/read", status_code=204)
async def inbox_mark_read(notification_id: uuid.UUID, user: CurrentUser,
                          db: DbSession) -> Response:
    row = await db.scalar(select(Notification).where(
        Notification.id == notification_id,
        Notification.person_id == user.person.id))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "notification_not_found"})
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
        await db.commit()
    return Response(status_code=204)


@router.post("/inbox/read-all", status_code=204)
async def inbox_mark_all_read(user: CurrentUser, db: DbSession) -> Response:
    rows = (await db.scalars(select(Notification).where(
        Notification.person_id == user.person.id,
        Notification.read_at.is_(None)))).all()
    now = datetime.now(UTC)
    for row in rows:
        row.read_at = now
    await db.commit()
    return Response(status_code=204)
```

- [ ] **Step 8: conftest TRUNCATE** — in `api/tests/conftest.py` add `report_runs, report_definitions, notifications, ` to the TRUNCATE list (before `"initiative_links, …"`). Note `report_definitions` is truncated too, so tests that need the seeded "Move Report" row must create it (Task 2's `_definition` helper does).

- [ ] **Step 9: Migrate + run tests**

Run: `cd api && .venv/bin/alembic upgrade head && .venv/bin/python -m pytest -q tests/test_notifications_inbox.py tests/test_notification_groups_api.py`
Expected: all pass (the conftest runs `alembic upgrade head` on the test DB itself).

- [ ] **Step 10: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/migrations/versions/0046_reports_and_inbox.py api/src/serversherpa/db/models.py api/src/serversherpa/notifications/inbox.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/notifications.py api/tests/conftest.py api/tests/test_notifications_inbox.py
git commit -m "feat(reports): report_definitions/report_runs/notifications tables, notify(), inbox API"
```

---

### Task 2: `reports` resource, module registry, definitions API

**Files:**
- Modify: `api/src/serversherpa/access/resources.py` (add a `Resource` after `labels`)
- Modify: `api/src/serversherpa/access/defaults.py` (`_ALL`, `admin`, `staff`)
- Create: `api/src/serversherpa/reports/__init__.py` (empty), `api/src/serversherpa/reports/registry.py`, `api/src/serversherpa/reports/move_report/__init__.py`
- Modify: `api/src/serversherpa/api/schemas.py` (append a `# ── reports ──` block at the end)
- Create: `api/src/serversherpa/api/routes/reports.py`
- Modify: `api/src/serversherpa/api/app.py` (import + `include_router` after `labels`)
- Test: `api/tests/test_reports_api.py` (new)

**Interfaces:**
- Produces: `serversherpa.reports.registry`: `ReportResult(pdf: bytes, filename: str)` dataclass; `ReportModule` Protocol with `report_type: str`, `default_options() -> dict`, `validate_options(options: dict) -> dict` (raises `OptionsError(problems: list[str])`), `async build(db, run) -> ReportResult`; `registry() -> dict[str, ReportModule]` (lazy); `get_module(report_type) -> ReportModule` (unknown → `ValueError`). `move_report` module in `reports/move_report/__init__.py` implements the protocol (`build` raises `NotImplementedError` until Task 6). Routes: `GET /reports/definitions`, `POST /reports/definitions/{id}/clone`, `PATCH /reports/definitions/{id}`, `DELETE /reports/definitions/{id}`. Schemas `ReportDefinitionOut`, `ReportDefinitionUpdateIn`.

- [ ] **Step 1: Write the failing tests** — `api/tests/test_reports_api.py`:

```python
"""Reports API: definitions (list/clone/patch/delete + system guard) and,
from Task 3, runs (create/list/get/download/notify + the history gate)."""

from uuid import uuid4

from sqlalchemy import select

from serversherpa.db.models import (
    AuditLog, Initiative, ReportDefinition, ReportRun,
)

from tests.test_sites_api import login
from tests.test_status_values_write import _make

ALL_ON = {"summary": True, "assets_by_source": True, "assets_by_destination": True,
          "size_weight": True, "rail_usage": True, "collisions": True,
          "source_racks": True, "destination_racks": True}


async def _definition(db, *, name="Move Report", is_system=True, options=None):
    d = ReportDefinition(name=name, description="d", report_type="move_report",
                         options=options or ALL_ON, is_system=is_system)
    db.add(d)
    await db.commit()
    return d


async def _initiative(db, *, name=None, client_id=None, archived=False):
    from datetime import UTC, datetime
    ini = Initiative(name=name or f"Move {uuid4().hex[:6]}", initiative_type="move",
                     status="planned", client_id=client_id,
                     archived_at=datetime.now(UTC) if archived else None)
    db.add(ini)
    await db.commit()
    return ini


# ── definitions ────────────────────────────────────────────────────

async def test_list_definitions_requires_reports_view(client, db, seeded_user):
    await _definition(db)
    worker = await _make(db, client, "worker", "w@test.example.com")
    assert (await client.get("/reports/definitions", headers=worker)).status_code == 403
    staff = await login(client)
    resp = await client.get("/reports/definitions", headers=staff)
    assert resp.status_code == 200, resp.text
    [d] = resp.json()
    assert d["name"] == "Move Report" and d["is_system"] is True
    assert d["report_type"] == "move_report" and d["options"] == ALL_ON


async def test_clone_copies_options_and_audits(client, db, seeded_user):
    src = await _definition(db, options={**ALL_ON, "collisions": False})
    hdrs = await login(client)                      # staff has reports:add
    resp = await client.post(f"/reports/definitions/{src.id}/clone", headers=hdrs)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Move Report (copy)" and body["is_system"] is False
    assert body["options"]["collisions"] is False
    assert await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "report_definition", AuditLog.action == "clone")) is not None


async def test_patch_validates_options_and_rejects_duplicate_name(client, db, seeded_user):
    d = await _definition(db)
    other = await _definition(db, name="Other", is_system=False)
    admin = await _make(db, client, "admin", "a@test.example.com")
    resp = await client.patch(f"/reports/definitions/{d.id}", headers=admin,
                              json={"options": {"summary": False}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["options"] == {**ALL_ON, "summary": False}   # missing keys defaulted
    resp = await client.patch(f"/reports/definitions/{d.id}", headers=admin,
                              json={"options": {"bogus": True}})
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_options"
    resp = await client.patch(f"/reports/definitions/{other.id}", headers=admin,
                              json={"name": "move report"})           # citext clash
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "name_in_use"
    staff = await login(client)                                        # no reports:change
    assert (await client.patch(f"/reports/definitions/{d.id}", headers=staff,
                               json={"name": "x"})).status_code == 403


async def test_delete_is_soft_and_refuses_system_rows(client, db, seeded_user):
    system = await _definition(db)
    custom = await _definition(db, name="Custom", is_system=False)
    admin = await _make(db, client, "admin", "a@test.example.com")
    resp = await client.delete(f"/reports/definitions/{system.id}", headers=admin)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "system_definition"
    assert (await client.delete(f"/reports/definitions/{custom.id}", headers=admin)).status_code == 204
    names = [d["name"] for d in (await client.get("/reports/definitions", headers=admin)).json()]
    assert names == ["Move Report"]
    await db.refresh(custom)
    assert custom.archived_at is not None
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_reports_api.py`
Expected: 404s / import errors — routes don't exist.

- [ ] **Step 3: Resource + defaults** — in `api/src/serversherpa/access/resources.py`, after the `labels` `Resource(...)`:

```python
    Resource("reports", "Reports", routes=("/reports",),
             visible_to=frozenset({"global"})),
```

In `api/src/serversherpa/access/defaults.py`: add `"reports"` to `_ALL` (after `"labels"`); in the `"admin"` dict add `"reports": FULL,`; in the `"staff"` dict add `"reports": ("view", "add"),`.

- [ ] **Step 4: Registry + module stub** — `api/src/serversherpa/reports/registry.py`:

```python
"""Explicit registry of report modules keyed by `report_type`. Explicit
(not glob-discovered like V2) so a typo is an import error, not a silent
404 at runtime."""

from dataclasses import dataclass
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportRun


@dataclass(frozen=True)
class ReportResult:
    pdf: bytes
    filename: str


class OptionsError(ValueError):
    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


class ReportModule(Protocol):
    report_type: str

    def default_options(self) -> dict: ...
    def validate_options(self, options: dict) -> dict: ...
    async def build(self, db: AsyncSession, run: ReportRun) -> ReportResult: ...


_REGISTRY: dict[str, ReportModule] | None = None


def registry() -> dict[str, ReportModule]:
    """Lazy so report modules may import this module's types without a
    circular import at package load."""
    global _REGISTRY
    if _REGISTRY is None:
        from serversherpa.reports import move_report
        _REGISTRY = {move_report.report_type: move_report}      # type: ignore[dict-item]
    return _REGISTRY


def get_module(report_type: str) -> ReportModule:
    try:
        return registry()[report_type]
    except KeyError:
        raise ValueError(f"unknown report type {report_type!r}") from None
```

`api/src/serversherpa/reports/move_report/__init__.py` (Task 6 replaces `build`):

```python
"""Move Report — the V2 comprehensive move report, server-side."""

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportRun
from serversherpa.reports.registry import OptionsError, ReportResult

report_type = "move_report"

SECTION_KEYS = ("summary", "assets_by_source", "assets_by_destination", "size_weight",
                "rail_usage", "collisions", "source_racks", "destination_racks")


def default_options() -> dict:
    return {k: True for k in SECTION_KEYS}


def validate_options(options: dict) -> dict:
    """Unknown keys and non-bool values are problems; missing keys default
    to True. Returns the normalized dict (every key present)."""
    problems = [f"unknown option {k!r}" for k in options if k not in SECTION_KEYS]
    problems += [f"option {k!r} must be true/false" for k, v in options.items()
                 if k in SECTION_KEYS and not isinstance(v, bool)]
    if problems:
        raise OptionsError(problems)
    return {**default_options(), **options}


async def build(db: AsyncSession, run: ReportRun) -> ReportResult:
    raise NotImplementedError("move_report.build lands in Task 6")
```

- [ ] **Step 5: Schemas** — append to `api/src/serversherpa/api/schemas.py`:

```python
# ── reports ───────────────────────────────────────────────────────

class ReportDefinitionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str
    report_type: str
    options: dict
    is_system: bool
    updated_at: datetime


class ReportDefinitionUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = Field(None, max_length=1000)
    options: dict | None = None
```

- [ ] **Step 6: Router** — `api/src/serversherpa/api/routes/reports.py`:

```python
"""Reports: definitions (the Available tab) and runs (History + the
Generate modal). Reads gate on reports:view; clone/generate on
reports:add; edit on reports:change; delete on reports:delete."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import ReportDefinitionOut, ReportDefinitionUpdateIn
from serversherpa.db.models import ReportDefinition
from serversherpa.reports.registry import OptionsError, get_module
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/reports", tags=["reports"])

DEFINITION_FIELDS = ["name", "description", "options"]


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _definition(db: DbSession, definition_id: uuid.UUID) -> ReportDefinition:
    d = await db.get(ReportDefinition, definition_id)
    if d is None or d.archived_at is not None:
        raise _err(404, "definition_not_found")
    return d


async def _name_taken(db: DbSession, name: str, *, exclude: uuid.UUID | None) -> bool:
    q = select(ReportDefinition.id).where(ReportDefinition.name == name,
                                          ReportDefinition.archived_at.is_(None))
    if exclude is not None:
        q = q.where(ReportDefinition.id != exclude)
    return (await db.scalar(q)) is not None


def _validated_options(report_type: str, options: dict) -> dict:
    try:
        return get_module(report_type).validate_options(options)
    except OptionsError as exc:
        raise _err(422, "invalid_options", problems=exc.problems) from None


@router.get("/definitions", response_model=list[ReportDefinitionOut])
async def list_definitions(
    db: DbSession, _actor: AuthContext = require_permission("reports", "view"),
) -> list[ReportDefinitionOut]:
    rows = await db.scalars(select(ReportDefinition)
                            .where(ReportDefinition.archived_at.is_(None))
                            .order_by(ReportDefinition.is_system.desc(), ReportDefinition.name))
    return list(rows)


@router.post("/definitions/{definition_id}/clone", response_model=ReportDefinitionOut,
             status_code=201)
async def clone_definition(
    definition_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("reports", "add"),
) -> ReportDefinitionOut:
    src = await _definition(db, definition_id)
    name = f"{src.name} (copy)"
    n = 2
    while await _name_taken(db, name, exclude=None):
        name = f"{src.name} (copy {n})"
        n += 1
    d = ReportDefinition(name=name, description=src.description,
                         report_type=src.report_type, options=dict(src.options),
                         is_system=False, created_by=actor.person.id)
    db.add(d)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="report_definition",
          entity_id=str(d.id), action="clone",
          changes={"source_id": {"from": None, "to": str(src.id)},
                   "name": {"from": None, "to": name}})
    await db.commit()
    await db.refresh(d)
    return d


@router.patch("/definitions/{definition_id}", response_model=ReportDefinitionOut)
async def update_definition(
    definition_id: uuid.UUID, body: ReportDefinitionUpdateIn, db: DbSession,
    actor: AuthContext = require_permission("reports", "change"),
) -> ReportDefinitionOut:
    d = await _definition(db, definition_id)
    before = snapshot(d, DEFINITION_FIELDS)
    patch = body.model_dump(exclude_unset=True)
    if "name" in patch:
        patch["name"] = patch["name"].strip()
        if await _name_taken(db, patch["name"], exclude=d.id):
            raise _err(409, "name_in_use")
    if "options" in patch:
        patch["options"] = _validated_options(d.report_type, patch["options"])
    for k, v in patch.items():
        setattr(d, k, v)
    d.updated_at = datetime.now(UTC)
    changes = diff(before, snapshot(d, DEFINITION_FIELDS))
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="report_definition",
              entity_id=str(d.id), action="update", changes=changes)
    await db.commit()
    await db.refresh(d)
    return d


@router.delete("/definitions/{definition_id}", status_code=204)
async def delete_definition(
    definition_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("reports", "delete"),
) -> Response:
    d = await _definition(db, definition_id)
    if d.is_system:
        raise _err(409, "system_definition")
    d.archived_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="report_definition",
          entity_id=str(d.id), action="delete",
          changes={"name": {"from": d.name, "to": None}})
    await db.commit()
    return Response(status_code=204)
```

In `api/src/serversherpa/api/app.py` add `reports` to the `from serversherpa.api.routes import (...)` list and `app.include_router(reports.router)` after `labels`.

- [ ] **Step 7: Run tests**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_reports_api.py tests/test_access_api.py`
Expected: all pass. (`test_access_api` covers the resource registry — if it asserts an exact resource list, add `reports` there.)

- [ ] **Step 8: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/access api/src/serversherpa/reports api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/reports.py api/src/serversherpa/api/app.py api/tests/test_reports_api.py
git commit -m "feat(reports): reports resource, module registry, definitions API"
```

---

### Task 3: Runs API with the history gate

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (append after `ReportDefinitionUpdateIn`)
- Modify: `api/src/serversherpa/api/routes/reports.py` (append routes; extend imports)
- Test: `api/tests/test_reports_api.py` (append)

**Interfaces:**
- Consumes: Task 1 models; Task 2 `get_module`, `_validated_options`.
- Produces: `POST /reports/runs` (body `ReportRunCreateIn{definition_id, initiative_id, options, notify}`) → 201 `ReportRunOut`; `GET /reports/runs?status=&report_type=&initiative_id=&before=&limit=` → `list[ReportRunOut]`; `GET /reports/runs/{id}` → `ReportRunOut`; `GET /reports/runs/{id}/download` → `{"url": str}`; `PATCH /reports/runs/{id}` (body `{notify: bool}`) → `ReportRunOut`. `ReportRunOut` fields: id, definition_id, definition_name, report_type, initiative_id, initiative_name, options, status, error, requested_by, requested_by_name, requested_rank, notify, filename, size_bytes, started_at, finished_at, created_at.

- [ ] **Step 1: Write the failing tests** — append to `api/tests/test_reports_api.py`:

```python
# ── runs ───────────────────────────────────────────────────────────

async def _run_payload(d, ini, **extra):
    return {"definition_id": str(d.id), "initiative_id": str(ini.id),
            "options": ALL_ON, "notify": False, **extra}


async def test_create_run_queues_with_requester_rank(client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs,
                             json=await _run_payload(d, ini, options={"collisions": False}))
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "queued" and body["report_type"] == "move_report"
    assert body["options"] == {**ALL_ON, "collisions": False}
    assert body["definition_name"] == "Move Report"
    assert body["initiative_name"] == ini.name
    assert body["requested_by_name"] == "Alice Anderson"
    run = await db.get(ReportRun, body["id"])
    assert run.requested_rank > 0                       # staff rank, captured server-side
    assert await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "report_run", AuditLog.action == "create")) is not None


async def test_create_run_rejects_bad_options_and_hidden_initiatives(client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    hdrs = await login(client)
    resp = await client.post("/reports/runs", headers=hdrs,
                             json=await _run_payload(d, ini, options={"nope": True}))
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_options"
    archived = await _initiative(db, archived=True)
    resp = await client.post("/reports/runs", headers=hdrs, json=await _run_payload(d, archived))
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "initiative_not_found"
    resp = await client.post("/reports/runs", headers=hdrs,
                             json={**await _run_payload(d, ini), "definition_id": str(uuid4())})
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "definition_not_found"


async def test_history_gate_hides_higher_rank_runs_but_shows_own(client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    admin = await _make(db, client, "admin", "a@test.example.com")
    staff = await login(client)
    admin_run = (await client.post("/reports/runs", headers=admin,
                                   json=await _run_payload(d, ini))).json()
    staff_run = (await client.post("/reports/runs", headers=staff,
                                   json=await _run_payload(d, ini))).json()
    seen = [r["id"] for r in (await client.get("/reports/runs", headers=staff)).json()]
    assert seen == [staff_run["id"]]                    # own run yes, admin's no
    seen = [r["id"] for r in (await client.get("/reports/runs", headers=admin)).json()]
    assert seen == [staff_run["id"], admin_run["id"]]  # newest first, lower rank visible
    assert (await client.get(f"/reports/runs/{admin_run['id']}", headers=staff)).status_code == 404
    assert (await client.get(f"/reports/runs/{admin_run['id']}", headers=admin)).status_code == 200


async def test_history_list_filters_and_cursor(client, db, seeded_user):
    d = await _definition(db)
    a = await _initiative(db, name="A move")
    b = await _initiative(db, name="B move")
    hdrs = await login(client)
    for ini in (a, b, b):
        await client.post("/reports/runs", headers=hdrs, json=await _run_payload(d, ini))
    only_b = (await client.get(f"/reports/runs?initiative_id={b.id}", headers=hdrs)).json()
    assert len(only_b) == 2
    page1 = (await client.get("/reports/runs?limit=2", headers=hdrs)).json()
    assert len(page1) == 2
    page2 = (await client.get(f"/reports/runs?limit=2&before={page1[-1]['created_at']}",
                              headers=hdrs)).json()
    assert len(page2) == 1 and page2[0]["initiative_name"] == "A move"
    assert (await client.get("/reports/runs?status=completed", headers=hdrs)).json() == []


async def test_download_requires_completion_then_presigns(client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    hdrs = await login(client)
    run = (await client.post("/reports/runs", headers=hdrs, json=await _run_payload(d, ini))).json()
    resp = await client.get(f"/reports/runs/{run['id']}/download", headers=hdrs)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_ready"
    row = await db.get(ReportRun, run["id"])
    row.status = "completed"
    row.storage_key = f"reports/{ini.id}/{row.id}.pdf"
    row.filename = "Move Report - X - 2026-09-09 1200.pdf"
    await db.commit()
    resp = await client.get(f"/reports/runs/{run['id']}/download", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert row.storage_key in resp.json()["url"]
    assert "Move%20Report" in resp.json()["url"] or "Move Report" in resp.json()["url"]


async def test_notify_patch_is_requester_only(client, db, seeded_user):
    d = await _definition(db)
    ini = await _initiative(db)
    staff = await login(client)
    admin = await _make(db, client, "admin", "a@test.example.com")
    run = (await client.post("/reports/runs", headers=staff, json=await _run_payload(d, ini))).json()
    resp = await client.patch(f"/reports/runs/{run['id']}", headers=staff, json={"notify": True})
    assert resp.status_code == 200 and resp.json()["notify"] is True
    resp = await client.patch(f"/reports/runs/{run['id']}", headers=admin, json={"notify": False})
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "forbidden"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_reports_api.py -k "run or history or download or notify"`
Expected: 404/405 — routes missing.

- [ ] **Step 3: Schemas** — append to `api/src/serversherpa/api/schemas.py`:

```python
class ReportRunCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    definition_id: uuid.UUID
    initiative_id: uuid.UUID
    options: dict = Field(default_factory=dict)
    notify: bool = False


class ReportRunNotifyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    notify: bool


class ReportRunOut(BaseModel):
    id: uuid.UUID
    definition_id: uuid.UUID
    definition_name: str
    report_type: str
    initiative_id: uuid.UUID
    initiative_name: str
    options: dict
    status: str
    error: str | None = None
    requested_by: uuid.UUID
    requested_by_name: str
    requested_rank: int
    notify: bool
    filename: str | None = None
    size_bytes: int | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_at: datetime


class ReportDownloadOut(BaseModel):
    url: str
```

- [ ] **Step 4: Routes** — append to `api/src/serversherpa/api/routes/reports.py`. Extend the imports: `from sqlalchemy import or_, select`; add `Initiative, Person, ReportRun` to the models import; add `ReportDownloadOut, ReportRunCreateIn, ReportRunNotifyIn, ReportRunOut` to the schemas import; add `from serversherpa.access.scope import scope_conditions` and `from serversherpa.services.storage import presign_get`.

```python
# ── runs ───────────────────────────────────────────────────────────

RUNS_DEFAULT_LIMIT = 100
RUNS_MAX_LIMIT = 500


def _run_out(run: ReportRun, definition_name: str, initiative_name: str,
             first: str, last: str) -> ReportRunOut:
    return ReportRunOut(
        id=run.id, definition_id=run.definition_id, definition_name=definition_name,
        report_type=run.report_type, initiative_id=run.initiative_id,
        initiative_name=initiative_name, options=run.options, status=run.status,
        error=run.error, requested_by=run.requested_by,
        requested_by_name=f"{first} {last}".strip(), requested_rank=run.requested_rank,
        notify=run.notify, filename=run.filename, size_bytes=run.size_bytes,
        started_at=run.started_at, finished_at=run.finished_at, created_at=run.created_at)


def _visible_runs(actor: AuthContext):
    """The history gate as a SQL predicate: own runs always; otherwise only
    runs requested at or below the actor's rank; and the initiative must be
    in the actor's scope."""
    q = (select(ReportRun, ReportDefinition.name, Initiative.name,
                Person.first_name, Person.last_name)
         .join(ReportDefinition, ReportDefinition.id == ReportRun.definition_id)
         .join(Initiative, Initiative.id == ReportRun.initiative_id)
         .join(Person, Person.id == ReportRun.requested_by)
         .where(or_(ReportRun.requested_by == actor.person.id,
                    ReportRun.requested_rank <= actor.access.max_rank)))
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        q = q.where(cond)
    return q


async def _visible_run(db: DbSession, run_id: uuid.UUID, actor: AuthContext) -> ReportRunOut:
    row = (await db.execute(_visible_runs(actor).where(ReportRun.id == run_id))).first()
    if row is None:
        raise _err(404, "run_not_found")
    return _run_out(*row)


@router.post("/runs", response_model=ReportRunOut, status_code=201)
async def create_run(
    body: ReportRunCreateIn, db: DbSession,
    actor: AuthContext = require_permission("reports", "add"),
) -> ReportRunOut:
    d = await _definition(db, body.definition_id)
    ini = await db.get(Initiative, body.initiative_id)
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if ini is None or ini.archived_at is not None or (
            cond is not None and await db.scalar(
                select(Initiative.id).where(Initiative.id == ini.id, cond)) is None):
        raise _err(404, "initiative_not_found")
    options = _validated_options(d.report_type, body.options)
    run = ReportRun(definition_id=d.id, report_type=d.report_type, initiative_id=ini.id,
                    options=options, requested_by=actor.person.id,
                    requested_rank=actor.access.max_rank, notify=body.notify)
    db.add(run)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="report_run", entity_id=str(run.id),
          action="create", changes={"definition": {"from": None, "to": d.name},
                                    "initiative_id": {"from": None, "to": str(ini.id)}})
    await db.commit()
    return await _visible_run(db, run.id, actor)


@router.get("/runs", response_model=list[ReportRunOut])
async def list_runs(
    db: DbSession, status: str | None = None, report_type: str | None = None,
    initiative_id: uuid.UUID | None = None, before: datetime | None = None,
    limit: int = RUNS_DEFAULT_LIMIT,
    actor: AuthContext = require_permission("reports", "view"),
) -> list[ReportRunOut]:
    q = _visible_runs(actor)
    if status is not None:
        q = q.where(ReportRun.status == status)
    if report_type is not None:
        q = q.where(ReportRun.report_type == report_type)
    if initiative_id is not None:
        q = q.where(ReportRun.initiative_id == initiative_id)
    if before is not None:
        q = q.where(ReportRun.created_at < before)
    q = q.order_by(ReportRun.created_at.desc()).limit(max(1, min(limit, RUNS_MAX_LIMIT)))
    return [_run_out(*row) for row in (await db.execute(q)).all()]


@router.get("/runs/{run_id}", response_model=ReportRunOut)
async def get_run(
    run_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("reports", "view"),
) -> ReportRunOut:
    return await _visible_run(db, run_id, actor)


@router.get("/runs/{run_id}/download", response_model=ReportDownloadOut)
async def download_run(
    run_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("reports", "view"),
) -> ReportDownloadOut:
    out = await _visible_run(db, run_id, actor)
    run = await db.get(ReportRun, run_id)
    if out.status != "completed" or not run.storage_key:
        raise _err(409, "not_ready")
    url = presign_get(run.storage_key, download_filename=run.filename)
    assert url is not None
    return ReportDownloadOut(url=url)


@router.patch("/runs/{run_id}", response_model=ReportRunOut)
async def set_run_notify(
    run_id: uuid.UUID, body: ReportRunNotifyIn, db: DbSession,
    actor: AuthContext = require_permission("reports", "view"),
) -> ReportRunOut:
    await _visible_run(db, run_id, actor)
    run = await db.get(ReportRun, run_id)
    if run.requested_by != actor.person.id:
        raise _err(403, "forbidden")
    run.notify = body.notify
    await db.commit()
    return await _visible_run(db, run_id, actor)
```

- [ ] **Step 5: Run tests**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_reports_api.py`
Expected: all pass. If the presigned URL test's filename assertion is brittle on your MinIO signer, assert only that `row.storage_key in url`.

- [ ] **Step 6: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/reports.py api/tests/test_reports_api.py
git commit -m "feat(reports): runs API — create/list/get/download/notify with the rank+scope history gate"
```

---

### Task 4: Move Report gather + compute (pure)

**Files:**
- Create: `api/src/serversherpa/reports/move_report/gather.py`
- Create: `api/src/serversherpa/reports/move_report/compute.py`
- Test: `api/tests/test_move_report_compute.py` (new), `api/tests/test_move_report_gather.py` (new)

**Interfaces:**
- Produces: `gather.MoveAsset` dataclass (fields below), `gather.MoveData` dataclass, `async gather.gather(db, initiative_id) -> MoveData` (raises `gather.InitiativeUnavailable` when missing/archived), `MoveAsset.to_row() -> dict` (the JSON the Node renderer consumes); `compute.load_summary(assets) -> LoadSummary`, `compute.rail_summary(assets) -> RailSummary`, `compute.collisions(assets) -> CollisionReport`, `compute.sorted_by_side(assets, side) -> list[MoveAsset]`. Task 6 consumes all of these.

- [ ] **Step 1: Write the failing compute tests** — `api/tests/test_move_report_compute.py`:

```python
"""Pure move-report calculations, pinning the V2 semantics (load/rail/
collision reports) on fixtures — no DB."""

from decimal import Decimal

from serversherpa.reports.move_report.compute import (
    collisions, load_summary, rail_summary, sorted_by_side,
)
from serversherpa.reports.move_report.gather import MoveAsset


def _asset(**kw) -> MoveAsset:
    base = dict(row_id="r", asset_id="a", name="web-01", serial="SN1", make="Dell",
                model="R740", ru_size=2, weight_lbs=Decimal("50"), weight_kg=None,
                length_in=None, width_in=None, height_in=None, rail_type="Sliding",
                priority_wave=None, source_rack=None, source_ru=None,
                source_verified=None, source_position=None, destination_rack=None,
                destination_ru=None, destination_verified=None,
                destination_position=None)
    base.update(kw)
    return MoveAsset(**base)


def test_load_summary_totals_and_kg_fallback():
    assets = [
        _asset(row_id="1", ru_size=2, weight_lbs=Decimal("50")),
        _asset(row_id="2", ru_size=None, weight_lbs=None, weight_kg=Decimal("10")),
        _asset(row_id="3", make="HPE", model="DL380", ru_size=1, weight_lbs=None, weight_kg=None),
    ]
    s = load_summary(assets)
    assert s.total_assets == 3
    assert s.total_ru == 4                              # 2 + default 1 + 1
    assert round(s.total_weight_lbs, 2) == 72.05        # 50 + 10kg→22.05
    assert round(s.total_weight_kg, 2) == 32.68
    assert [(m.make, m.model, m.count, m.total_ru) for m in s.models] == [
        ("Dell", "R740", 2, 3), ("HPE", "DL380", 1, 1)]
    assert s.models[0].dimensions == "—"


def test_load_summary_dimensions_string():
    s = load_summary([_asset(length_in=Decimal("28.5"), width_in=Decimal("17.1"),
                             height_in=Decimal("3.4"))])
    assert s.models[0].dimensions == "28.5 × 17.1 × 3.4 in"


def test_rail_summary_counts_and_na():
    assets = [_asset(row_id="1"), _asset(row_id="2"),
              _asset(row_id="3", make="HPE", model="DL380", rail_type=None)]
    r = rail_summary(assets)
    assert [(x.rail_type, x.count) for x in r.rail_types] == [("Sliding", 2), ("N/A", 1)]
    assert [(m.make, m.model, m.count, m.rail_type) for m in r.models] == [
        ("Dell", "R740", 2, "Sliding"), ("HPE", "DL380", 1, "N/A")]


def test_collisions_overlap_partial_slot_and_none():
    a = _asset(row_id="a", name="a", ru_size=2, destination_rack="R1", destination_ru=10)
    b = _asset(row_id="b", name="b", ru_size=1, destination_rack="R1", destination_ru=11)   # overlaps a's top RU
    c = _asset(row_id="c", name="c", ru_size=1, destination_rack="R1", destination_ru=20.1)
    d = _asset(row_id="d", name="d", ru_size=1, destination_rack="R1", destination_ru=20.1)  # same slot
    e = _asset(row_id="e", name="e", ru_size=1, destination_rack="R2", destination_ru=10)    # other rack
    f = _asset(row_id="f", name="f", ru_size=1, destination_rack=None, destination_ru=10)    # no rack
    g = _asset(row_id="g", name="g", ru_size=4, destination_rack="R1", destination_ru=30)
    h = _asset(row_id="h", name="h", ru_size=1, destination_rack="R1", destination_ru=33)   # partial overlap at g's top
    rep = collisions([a, b, c, d, e, f, g, h])
    assert rep.assets_checked == 7                      # f has no rack
    kinds = {(x.asset_a.name, x.asset_b.name): x.collision_type for x in rep.items}
    assert kinds == {("a", "b"): "ru_overlap", ("c", "d"): "ru_and_slot_conflict",
                     ("g", "h"): "ru_overlap"}
    ab = next(x for x in rep.items if x.asset_a.name == "a")
    assert ab.rack == "R1" and ab.overlapping_rus == [11]
    assert rep.collision_count == 3 and rep.assets_flagged == 6


def test_collisions_slot_conflict_without_overlap_is_impossible_but_zero_slot_ignored():
    # slot 0 (integer RU) is never a "slot conflict" — plain overlap only
    a = _asset(row_id="a", name="a", destination_rack="R1", destination_ru=5)
    b = _asset(row_id="b", name="b", destination_rack="R1", destination_ru=5)
    [x] = collisions([a, b]).items
    assert x.collision_type == "ru_overlap" and x.slot_conflict is None


def test_sorted_by_side_orders_rack_then_ru_nulls_last():
    rows = [_asset(row_id="1", source_rack="B", source_ru=3),
            _asset(row_id="2", source_rack="A", source_ru=10),
            _asset(row_id="3", source_rack="A", source_ru=2),
            _asset(row_id="4", source_rack=None, source_ru=None)]
    assert [r.row_id for r in sorted_by_side(rows, "source")] == ["3", "2", "1", "4"]
```

- [ ] **Step 2: Write the failing gather test** — `api/tests/test_move_report_gather.py`:

```python
"""gather() pulls an initiative + its asset roster into plain dataclasses."""

from decimal import Decimal

import pytest

from serversherpa.db.models import (
    Asset, AssetModel, Client, Initiative, InitiativeAsset, Site,
)
from serversherpa.reports.move_report.gather import InitiativeUnavailable, gather


async def test_gather_builds_move_data(db):
    client = Client(name="Acme")
    src = Site(name="DC-A", status="active")
    dst = Site(name="DC-B", status="active")
    db.add_all([client, src, dst])
    await db.flush()
    ini = Initiative(name="NAP11", initiative_type="move", status="planned",
                     client_id=client.id, origin_site_id=src.id, destination_site_id=dst.id)
    model = AssetModel(make="Dell", model="R740", ru_size=2, weight_lbs=Decimal("50"),
                       rail_type="Sliding")
    db.add_all([ini, model])
    await db.flush()
    asset = Asset(serial_number="SN1", name="web-01", model_id=model.id)
    db.add(asset)
    await db.flush()
    db.add(InitiativeAsset(initiative_id=ini.id, asset_id=asset.id, priority_wave="W1",
                           source_rack="R1", source_ru=Decimal("10"), source_position="front",
                           destination_rack="D1", destination_ru=Decimal("20.1")))
    await db.commit()

    data = await gather(db, ini.id)
    assert data.name == "NAP11" and data.client_name == "Acme"
    assert data.origin_site.name == "DC-A" and data.destination_site.name == "DC-B"
    [a] = data.assets
    assert (a.name, a.serial, a.make, a.model, a.ru_size, a.rail_type) == (
        "web-01", "SN1", "Dell", "R740", 2, "Sliding")
    assert a.source_ru == 10.0 and a.destination_ru == 20.1
    row = a.to_row()
    assert row["source_rack"] == "R1" and row["asset"]["ru_size"] == 2
    assert row["asset"]["name"] == "web-01" and row["destination_ru"] == 20.1


async def test_gather_rejects_missing_or_archived(db):
    from datetime import UTC, datetime
    from uuid import uuid4
    with pytest.raises(InitiativeUnavailable):
        await gather(db, uuid4())
    ini = Initiative(name="Old", initiative_type="move", status="completed",
                     archived_at=datetime.now(UTC))
    db.add(ini)
    await db.commit()
    with pytest.raises(InitiativeUnavailable):
        await gather(db, ini.id)
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_move_report_compute.py tests/test_move_report_gather.py`
Expected: ImportError.

- [ ] **Step 4: gather.py**

```python
"""Step 1 of the Move Report: read the initiative + its asset roster into
plain dataclasses. Nothing downstream touches the ORM."""

import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Asset, AssetModel, Client, Initiative, InitiativeAsset, Site, StatusValue,
)


class InitiativeUnavailable(Exception):
    """The initiative is gone or archived — the run fails with this reason."""


def _f(v: Decimal | None) -> float | None:
    return None if v is None else float(v)


@dataclass(frozen=True)
class MoveAsset:
    row_id: str
    asset_id: str
    name: str | None
    serial: str | None
    make: str | None
    model: str | None
    ru_size: int | None
    weight_lbs: Decimal | None
    weight_kg: Decimal | None
    length_in: Decimal | None
    width_in: Decimal | None
    height_in: Decimal | None
    rail_type: str | None
    priority_wave: str | None
    source_rack: str | None
    source_ru: float | None
    source_verified: bool | None
    source_position: str | None
    destination_rack: str | None
    destination_ru: float | None
    destination_verified: bool | None
    destination_position: str | None

    @property
    def label(self) -> str:
        return self.name or self.serial or "—"

    @property
    def make_model(self) -> str:
        return " ".join(p for p in (self.make, self.model) if p) or "—"

    def to_row(self) -> dict:
        """The subset of the portal's InitiativeAssetRow that rackLayout()
        reads — fed to the Node rack renderer as JSON."""
        return {
            "id": self.row_id,
            "source_rack": self.source_rack, "source_ru": self.source_ru,
            "source_verified": self.source_verified, "source_position": self.source_position,
            "destination_rack": self.destination_rack, "destination_ru": self.destination_ru,
            "destination_verified": self.destination_verified,
            "destination_position": self.destination_position,
            "asset": {"name": self.name, "serial_number": self.serial,
                      "ru_size": self.ru_size, "model_make": self.make,
                      "model_name": self.model},
        }


@dataclass(frozen=True)
class SiteInfo:
    name: str
    address: str


@dataclass(frozen=True)
class MoveData:
    id: str
    name: str
    initiative_type: str
    type_label: str
    status: str
    status_label: str
    client_name: str | None
    scheduled_start: datetime | None
    scheduled_end: datetime | None
    origin_site: SiteInfo | None
    destination_site: SiteInfo | None
    assets: list[MoveAsset]


def _site_info(site: Site | None) -> SiteInfo | None:
    if site is None:
        return None
    city_region = ", ".join(p for p in (site.city, site.region) if p)
    parts = [site.address_line1, site.address_line2,
             " ".join(p for p in (city_region, site.postal_code) if p)]
    return SiteInfo(name=site.name, address="\n".join(p for p in parts if p))


async def gather(db: AsyncSession, initiative_id: uuid.UUID) -> MoveData:
    ini = await db.get(Initiative, initiative_id)
    if ini is None or ini.archived_at is not None:
        raise InitiativeUnavailable(str(initiative_id))
    labels = {(s.record_type, s.key): s.label for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type.in_(("initiative", "initiative_type"))))}
    client = await db.get(Client, ini.client_id) if ini.client_id else None
    origin = await db.get(Site, ini.origin_site_id) if ini.origin_site_id else None
    dest = await db.get(Site, ini.destination_site_id) if ini.destination_site_id else None

    rows = (await db.execute(
        select(InitiativeAsset, Asset, AssetModel)
        .join(Asset, Asset.id == InitiativeAsset.asset_id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .where(InitiativeAsset.initiative_id == initiative_id)
        .order_by(Asset.name.nullslast(), Asset.serial_number))).all()
    assets = [MoveAsset(
        row_id=str(ia.id), asset_id=str(a.id), name=a.name, serial=a.serial_number,
        make=m.make if m else None, model=m.model if m else None,
        ru_size=m.ru_size if m else None,
        weight_lbs=m.weight_lbs if m else None, weight_kg=m.weight_kg if m else None,
        length_in=m.length_in if m else None, width_in=m.width_in if m else None,
        height_in=m.height_in if m else None, rail_type=m.rail_type if m else None,
        priority_wave=ia.priority_wave,
        source_rack=ia.source_rack, source_ru=_f(ia.source_ru),
        source_verified=ia.source_verified, source_position=ia.source_position,
        destination_rack=ia.destination_rack, destination_ru=_f(ia.destination_ru),
        destination_verified=ia.destination_verified,
        destination_position=ia.destination_position,
    ) for ia, a, m in rows]

    return MoveData(
        id=str(ini.id), name=ini.name, initiative_type=ini.initiative_type,
        type_label=labels.get(("initiative_type", ini.initiative_type), ini.initiative_type),
        status=ini.status, status_label=labels.get(("initiative", ini.status), ini.status),
        client_name=client.name if client else None,
        scheduled_start=ini.scheduled_start, scheduled_end=ini.scheduled_end,
        origin_site=_site_info(origin), destination_site=_site_info(dest), assets=assets)
```

(`Site` columns used: `address_line1`, `address_line2`, `city`, `region`, `postal_code` — verified in `db/models.py`.)

- [ ] **Step 5: compute.py**

```python
"""Step 2 of the Move Report: the V2 load / rail / collision calculations
as pure functions over MoveAsset lists."""

from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from itertools import combinations
from math import floor

from serversherpa.reports.move_report.gather import MoveAsset

LBS_PER_KG = 2.20462


def _ru(a: MoveAsset) -> int:
    return a.ru_size if a.ru_size and a.ru_size > 0 else 1


def _weight_lbs(a: MoveAsset) -> float:
    if a.weight_lbs is not None:
        return float(a.weight_lbs)
    if a.weight_kg is not None:
        return float(a.weight_kg) * LBS_PER_KG
    return 0.0


def _dims(a: MoveAsset) -> str:
    if a.length_in is None or a.width_in is None or a.height_in is None:
        return "—"
    fmt = lambda d: f"{Decimal(d).normalize():f}"      # noqa: E731
    return f"{fmt(a.length_in)} × {fmt(a.width_in)} × {fmt(a.height_in)} in"


def _model_key(a: MoveAsset) -> tuple[str, str]:
    return (a.make or "", a.model or "")


@dataclass(frozen=True)
class ModelLoad:
    make: str | None
    model: str | None
    count: int
    ru_size: int
    total_ru: int
    weight_per_unit_lbs: float
    total_weight_lbs: float
    total_weight_kg: float
    dimensions: str


@dataclass(frozen=True)
class LoadSummary:
    total_assets: int
    total_ru: int
    total_weight_lbs: float
    total_weight_kg: float
    models: list[ModelLoad]


def load_summary(assets: list[MoveAsset]) -> LoadSummary:
    groups: dict[tuple[str, str], list[MoveAsset]] = defaultdict(list)
    for a in assets:
        groups[_model_key(a)].append(a)
    models = []
    for key in sorted(groups):
        rows = groups[key]
        first = rows[0]
        lbs = sum(_weight_lbs(r) for r in rows)
        models.append(ModelLoad(
            make=first.make, model=first.model, count=len(rows), ru_size=_ru(first),
            total_ru=sum(_ru(r) for r in rows), weight_per_unit_lbs=_weight_lbs(first),
            total_weight_lbs=lbs, total_weight_kg=lbs / LBS_PER_KG, dimensions=_dims(first)))
    total_lbs = sum(_weight_lbs(a) for a in assets)
    return LoadSummary(total_assets=len(assets), total_ru=sum(_ru(a) for a in assets),
                       total_weight_lbs=total_lbs, total_weight_kg=total_lbs / LBS_PER_KG,
                       models=models)


@dataclass(frozen=True)
class RailTypeCount:
    rail_type: str
    count: int


@dataclass(frozen=True)
class ModelRail:
    make: str | None
    model: str | None
    count: int
    rail_type: str
    ru_size: int


@dataclass(frozen=True)
class RailSummary:
    total_assets: int
    rail_types: list[RailTypeCount]
    models: list[ModelRail]


def rail_summary(assets: list[MoveAsset]) -> RailSummary:
    groups: dict[tuple[str, str], list[MoveAsset]] = defaultdict(list)
    for a in assets:
        groups[_model_key(a)].append(a)
    counts: dict[str, int] = defaultdict(int)
    models = []
    for key in sorted(groups):
        rows = groups[key]
        rail = rows[0].rail_type or "N/A"
        counts[rail] += len(rows)
        models.append(ModelRail(make=rows[0].make, model=rows[0].model, count=len(rows),
                                rail_type=rail, ru_size=_ru(rows[0])))
    rail_types = sorted((RailTypeCount(k, v) for k, v in counts.items()),
                        key=lambda x: (-x.count, x.rail_type))
    return RailSummary(total_assets=len(assets), rail_types=rail_types, models=models)


@dataclass(frozen=True)
class Placement:
    asset: MoveAsset
    base: int
    slot: int
    occupied: frozenset[int]

    @property
    def name(self) -> str:
        return self.asset.label


@dataclass(frozen=True)
class Collision:
    rack: str
    collision_type: str            # ru_overlap | slot_conflict | ru_and_slot_conflict
    overlapping_rus: list[int]
    slot_conflict: int | None
    asset_a: Placement
    asset_b: Placement


@dataclass(frozen=True)
class CollisionReport:
    items: list[Collision] = field(default_factory=list)
    assets_checked: int = 0

    @property
    def collision_count(self) -> int:
        return len(self.items)

    @property
    def assets_flagged(self) -> int:
        return len({p.asset.row_id for c in self.items for p in (c.asset_a, c.asset_b)})


def _placement(a: MoveAsset) -> Placement:
    raw = float(a.destination_ru)                      # caller guarantees not None
    base = floor(raw)
    slot = round((raw - base) * 10)
    return Placement(asset=a, base=base, slot=slot,
                     occupied=frozenset(range(base, base + _ru(a))))


def collisions(assets: list[MoveAsset]) -> CollisionReport:
    """Destination-side only (V2 semantics): pairwise within a rack, RU
    overlap and/or same-base same-non-zero-slot."""
    racks: dict[str, list[Placement]] = defaultdict(list)
    checked = 0
    for a in assets:
        if a.destination_rack and a.destination_ru is not None:
            racks[a.destination_rack].append(_placement(a))
            checked += 1
    items: list[Collision] = []
    for rack in sorted(racks):
        placed = sorted(racks[rack], key=lambda p: (p.base, p.slot, p.name))
        for pa, pb in combinations(placed, 2):
            overlap = pa.occupied & pb.occupied
            slot_hit = pa.base == pb.base and pa.slot == pb.slot and pa.slot > 0
            if not overlap and not slot_hit:
                continue
            kind = ("ru_and_slot_conflict" if overlap and slot_hit
                    else "slot_conflict" if slot_hit else "ru_overlap")
            items.append(Collision(
                rack=rack, collision_type=kind,
                overlapping_rus=sorted(overlap) if overlap else [pa.base],
                slot_conflict=pa.slot if slot_hit else None, asset_a=pa, asset_b=pb))
    return CollisionReport(items=items, assets_checked=checked)


def sorted_by_side(assets: list[MoveAsset], side: str) -> list[MoveAsset]:
    """Asset list ordering for the by-source / by-destination tables: rack,
    then RU, with unracked rows last (then by label)."""
    rack = (lambda a: a.source_rack) if side == "source" else (lambda a: a.destination_rack)
    ru = (lambda a: a.source_ru) if side == "source" else (lambda a: a.destination_ru)
    return sorted(assets, key=lambda a: (rack(a) is None, rack(a) or "",
                                         ru(a) is None, ru(a) or 0.0, a.label))
```

- [ ] **Step 6: Run tests**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_move_report_compute.py tests/test_move_report_gather.py`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/reports/move_report/gather.py api/src/serversherpa/reports/move_report/compute.py api/tests/test_move_report_compute.py api/tests/test_move_report_gather.py
git commit -m "feat(reports): move report gather + load/rail/collision compute (V2 semantics, pure)"
```

---

### Task 5: Rack renderer — extract `RackElevation`, Node SSR script, Python wrapper

**Files:**
- Create: `portal/src/components/initiatives/RackElevation.tsx` (moved out of `RackViewModal.tsx` lines 30–336: constants, `assignLanes`, `clusterOverlappingBlocks`, `laneGeometry`, `rackLabel`, `isRearPosition`, `DisplayBlock`, `ghostBlocksFor`, `TooltipRow`, `tooltipRows`, `yForRu`, `ruTop`, and the `RackElevation` component)
- Modify: `portal/src/components/initiatives/RackViewModal.tsx` (import from `./RackElevation`; re-export the helpers so the existing tests keep importing from `./RackViewModal`)
- Create: `portal/src/styles/rack-svg.css` (move `initiatives.css` lines 459–498, the `.rack-svg` … `.rack-block-label-unverified` rules); add `@import './rack-svg.css';` as the FIRST line of `portal/src/styles/initiatives.css`
- Create: `portal/src/reports/renderRack.tsx`, `portal/vite.rack-renderer.config.ts`
- Modify: `portal/package.json` scripts
- Test: `portal/src/reports/renderRack.test.tsx` (new)
- Create: `api/src/serversherpa/reports/rack_renderer.py`, `api/src/serversherpa/reports/move_report/racks.py`
- Modify: `api/src/serversherpa/config.py` (two settings)
- Test: `api/tests/test_rack_renderer.py` (new)

**Interfaces:**
- Produces (portal): `RackElevation` props `{heading, ariaLabel, blocks, onHoverBlock?, onLeaveBlock?}` (hover handlers now OPTIONAL); `renderRackSvg(input: {rackName, side, rows}) => string` exported from `src/reports/renderRack.tsx`; `npm run build:rack-renderer` → `portal/dist-node/render-rack.js` (ESM, self-contained, reads JSON on stdin, writes markup on stdout).
- Produces (api): settings `report_rack_renderer: str = ""` (empty → `<repo>/portal/dist-node/render-rack.js`), `report_node_bin: str = "node"`; `rack_renderer.RackRendererUnavailable`; `async rack_renderer.render(rows: list[dict], rack_name: str, side: str) -> str`; `racks.RackSvg(rack_name: str, svg: str, assets: list[MoveAsset])`; `async racks.rack_svgs(assets, side, renderer=rack_renderer.render) -> list[RackSvg]`.

- [ ] **Step 1: Failing portal test** — `portal/src/reports/renderRack.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { renderRackSvg } from './renderRack';

const row = (over: Record<string, unknown>) => ({
  id: 'r1', source_rack: 'R1', source_ru: 10, source_verified: true, source_position: null,
  destination_rack: null, destination_ru: null, destination_verified: null,
  destination_position: null,
  asset: { name: 'web-01', serial_number: 'SN1', ru_size: 2, model_make: 'Dell', model_name: 'R740' },
  ...over,
});

describe('renderRackSvg', () => {
  it('renders a FRONT elevation with the block label, RU numbers and inline styles', () => {
    const out = renderRackSvg({ rackName: 'R1', side: 'source', rows: [row({})] });
    expect(out).toContain('<svg');
    expect(out).toContain('web-01');
    expect(out).toContain('>54<');
    expect(out).toContain('FRONT');
    expect(out).not.toContain('REAR');
    expect(out).toContain('<style>');
    expect(out).toContain('.rack-faceplate-verified');
  });
  it('adds a REAR elevation only when a rear-positioned asset exists', () => {
    const out = renderRackSvg({ rackName: 'R1', side: 'source', rows: [
      row({}), row({ id: 'r2', source_ru: 20, source_position: 'rear',
                     asset: { name: 'pdu-1', serial_number: null, ru_size: 1, model_make: null, model_name: null } }),
    ] });
    expect(out).toContain('REAR');
    expect(out).toContain('pdu-1');
  });
  it('ignores rows on other racks or the other side', () => {
    const out = renderRackSvg({ rackName: 'R1', side: 'destination', rows: [row({})] });
    expect(out).toContain('No assets recorded at this rack');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd portal && npx vitest run src/reports/renderRack.test.tsx`
Expected: cannot resolve `./renderRack`.

- [ ] **Step 3: Extract `RackElevation`** — create `portal/src/components/initiatives/RackElevation.tsx` containing everything from `RackViewModal.tsx` lines 30–336 verbatim (constants through the `RackElevation` function), with these changes only:
  - `import type { RackBlock } from '../../lib/initiatives';` at the top (drop the React hooks import — the component uses none).
  - `export function RackElevation(...)` (was module-private) and make `onHoverBlock` / `onLeaveBlock` optional: `onHoverBlock?: (block: DisplayBlock, e: React.MouseEvent<SVGGElement>) => void; onLeaveBlock?: () => void;`, and guard the handlers: `onMouseEnter={onHoverBlock ? (e) => onHoverBlock(b, e) : undefined} onMouseLeave={onLeaveBlock}`.
  - Export `RU_COUNT` and `FACEPLATE_USABLE_WIDTH`.

  In `RackViewModal.tsx` delete lines 30–336 and add:

```tsx
import {
  FACEPLATE_USABLE_WIDTH, RackElevation, ghostBlocksFor, isRearPosition, tooltipRows,
} from './RackElevation';
import type { DisplayBlock } from './RackElevation';

export {
  FACEPLATE_USABLE_WIDTH, assignLanes, ghostBlocksFor, isRearPosition, laneGeometry,
  rackLabel, tooltipRows,
} from './RackElevation';
export type { DisplayBlock, LaneRect, TooltipRow } from './RackElevation';
```

  Keep `HoverState` in the modal (it's the only user). Run `npx vitest run src/components/initiatives` — both rack test files must still pass unchanged.

- [ ] **Step 4: Split the rack CSS** — move the `.rack-svg` … `.rack-block-label-unverified` rules (initiatives.css ~459–498) into `portal/src/styles/rack-svg.css` verbatim, and put `@import './rack-svg.css';` as the first line of `initiatives.css`.

- [ ] **Step 5: The renderer entry** — `portal/src/reports/renderRack.tsx`:

```tsx
/**
 * Server-side rack elevation renderer for the report-worker. Reuses the
 * portal's RackElevation + rackLayout verbatim so PDFs draw the exact rack
 * the modal draws. Built by `npm run build:rack-renderer` into
 * dist-node/render-rack.js; the Python side pipes
 * {rackName, side, rows} as JSON on stdin and reads markup on stdout.
 */
import { renderToStaticMarkup } from 'react-dom/server';

import { RackElevation, ghostBlocksFor, isRearPosition } from '../components/initiatives/RackElevation';
import type { DisplayBlock } from '../components/initiatives/RackElevation';
import { rackLayout } from '../lib/initiatives';
import type { InitiativeAssetRow } from '../lib/api';
import rackCss from '../styles/rack-svg.css?raw';

// Minimal Node ambient types — the portal has no @types/node, and this is
// the only file that runs under Node.
declare const process: {
  argv: string[];
  stdin: AsyncIterable<string> & { setEncoding(encoding: string): void };
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  exit(code: number): never;
};

export interface RenderRackInput {
  rackName: string;
  side: 'source' | 'destination';
  rows: InitiativeAssetRow[];
}

export function renderRackSvg(input: RenderRackInput): string {
  const blocks = rackLayout(input.rows, input.rackName, input.side);
  const front = blocks.filter((b) => !isRearPosition(b.position));
  const rear = blocks.filter((b) => isRearPosition(b.position));
  const frontDisplay: DisplayBlock[] = [...front, ...ghostBlocksFor(rear)];
  const rearDisplay: DisplayBlock[] = [...rear, ...ghostBlocksFor(front)];
  const sideLabel = input.side === 'source' ? 'Source' : 'Destination';
  const markup = renderToStaticMarkup(
    <div className="rack-elevations">
      <RackElevation heading="FRONT" blocks={frontDisplay}
                     ariaLabel={`Rack ${input.rackName} — ${sideLabel} — front elevation`} />
      {rear.length > 0 && (
        <RackElevation heading="REAR" blocks={rearDisplay}
                       ariaLabel={`Rack ${input.rackName} — ${sideLabel} — rear elevation`} />
      )}
    </div>,
  );
  return `<style>${rackCss}</style>${markup}`;
}

async function main(): Promise<void> {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw) as RenderRackInput;
  process.stdout.write(renderRackSvg(input));
}

// Only run as a CLI when executed directly (node dist-node/render-rack.js),
// not when imported by tests.
if (typeof process !== 'undefined' && process.argv[1]
    && /render-rack\.js$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`render-rack: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
```

  `?raw` CSS imports are typed by `tsconfig.json`'s `"types": ["vite/client"]` — nothing to add. `process` is NOT typed (no `@types/node`); the ambient `declare const process` block below covers exactly what the script uses. Create `portal/.gitignore` with the single line `dist-node/` (the portal has no `.gitignore` yet; the root one covers `dist`).

- [ ] **Step 6: Build config + scripts** — `portal/vite.rack-renderer.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// SSR library build of the rack renderer: one self-contained ESM file
// (React + ReactDOMServer bundled) that Node 20 can run with no
// node_modules next to it.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-node',
    emptyOutDir: true,
    ssr: 'src/reports/renderRack.tsx',
    target: 'node20',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'render-rack.js', format: 'es' } },
  },
  ssr: { noExternal: true },
});
```

  In `portal/package.json` scripts: `"build:rack-renderer": "vite build -c vite.rack-renderer.config.ts"` and change `"build"` to `"tsc -b && vite build && npm run build:rack-renderer"`. Add `dist-node/` to `portal/.gitignore` (create the line if the file lacks it).

  Smoke it: `cd portal && npm run build:rack-renderer && echo '{"rackName":"R1","side":"source","rows":[]}' | node dist-node/render-rack.js | head -c 200` — expect `<style>` then `<div class="rack-elevations">`.

- [ ] **Step 7: Run portal tests + typecheck**

Run: `cd portal && npx vitest run src/reports src/components/initiatives && npx tsc --noEmit -p .`
Expected: pass, clean.

- [ ] **Step 8: Failing Python test** — `api/tests/test_rack_renderer.py`:

```python
"""Subprocess wrapper around the Node rack renderer: happy path against a
stub script, and every failure mode mapped to RackRendererUnavailable."""

import sys

import pytest

from serversherpa.reports import rack_renderer
from serversherpa.reports.rack_renderer import RackRendererUnavailable, render

OK = "import sys, json; d=json.load(sys.stdin); print('<svg>' + d['rackName'] + '</svg>', end='')"


def _script(tmp_path, body: str):
    p = tmp_path / "render-rack.js"
    p.write_text(body)
    return str(p)


@pytest.fixture
def python_as_node(monkeypatch):
    """Run the 'script' with python instead of node so the test needs no
    Node toolchain: `python -c <script contents>` via a tiny shim."""
    shim = ("import sys, runpy; sys.argv = sys.argv[1:]; "
            "exec(open(sys.argv[0]).read())")
    monkeypatch.setattr(rack_renderer, "_command",
                        lambda script: [sys.executable, "-c", shim, script])


async def test_render_pipes_json_and_returns_stdout(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(rack_renderer, "_script_path", lambda: _script(tmp_path, OK))
    out = await render([{"id": "r1"}], "R7", "source")
    assert out == "<svg>R7</svg>"


async def test_missing_script_is_unavailable(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(rack_renderer, "_script_path", lambda: str(tmp_path / "nope.js"))
    with pytest.raises(RackRendererUnavailable, match="not found"):
        await render([], "R1", "source")


async def test_nonzero_exit_surfaces_stderr(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(rack_renderer, "_script_path",
                        lambda: _script(tmp_path, "import sys; sys.stderr.write('kaboom'); sys.exit(2)"))
    with pytest.raises(RackRendererUnavailable, match="kaboom"):
        await render([], "R1", "source")


async def test_timeout_is_unavailable(tmp_path, monkeypatch, python_as_node):
    monkeypatch.setattr(rack_renderer, "_script_path",
                        lambda: _script(tmp_path, "import time; time.sleep(5)"))
    monkeypatch.setattr(rack_renderer, "RACK_RENDER_TIMEOUT_SECONDS", 0.2)
    with pytest.raises(RackRendererUnavailable, match="timed out"):
        await render([], "R1", "source")
```

- [ ] **Step 9: Settings + wrapper** — in `api/src/serversherpa/config.py` add after the `# ── AI assistant` block:

```python
    # ── Reports ────────────────────────────────────────────
    # Node script that renders rack elevations (portal's RackElevation, SSR).
    # Empty = <repo>/portal/dist-node/render-rack.js.
    report_rack_renderer: str = ""
    report_node_bin: str = "node"
```

  `api/src/serversherpa/reports/rack_renderer.py`:

```python
"""Rack elevations for PDFs come from the PORTAL's own SVG component, run
under Node (portal/dist-node/render-rack.js — see portal/src/reports/
renderRack.tsx). One subprocess per rack; every failure is
RackRendererUnavailable so the run fails loudly instead of shipping a PDF
with silently missing sections."""

import asyncio
import json
import os
from pathlib import Path

from serversherpa.config import get_settings

RACK_RENDER_TIMEOUT_SECONDS = 30.0


class RackRendererUnavailable(Exception):
    pass


def _script_path() -> str:
    configured = get_settings().report_rack_renderer
    if configured:
        return configured
    repo_root = Path(__file__).resolve().parents[4]      # …/api/src/serversherpa/reports → repo
    return str(repo_root / "portal" / "dist-node" / "render-rack.js")


def _command(script: str) -> list[str]:
    return [get_settings().report_node_bin, script]


async def render(rows: list[dict], rack_name: str, side: str) -> str:
    script = _script_path()
    if not os.path.exists(script):
        raise RackRendererUnavailable(f"renderer script not found: {script}")
    payload = json.dumps({"rackName": rack_name, "side": side, "rows": rows}).encode()
    try:
        proc = await asyncio.create_subprocess_exec(
            *_command(script), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except OSError as exc:
        raise RackRendererUnavailable(f"cannot start renderer: {exc}") from exc
    try:
        out, err = await asyncio.wait_for(proc.communicate(payload),
                                          timeout=RACK_RENDER_TIMEOUT_SECONDS)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise RackRendererUnavailable(
            f"renderer timed out after {RACK_RENDER_TIMEOUT_SECONDS:g}s for rack {rack_name}") from None
    if proc.returncode != 0:
        raise RackRendererUnavailable(
            f"renderer exited {proc.returncode} for rack {rack_name}: "
            f"{err.decode(errors='replace').strip()[:500]}")
    return out.decode()
```

  `api/src/serversherpa/reports/move_report/racks.py`:

```python
"""Step 3 of the Move Report: one SVG per rack on the requested side."""

from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from serversherpa.reports import rack_renderer
from serversherpa.reports.move_report.gather import MoveAsset

Renderer = Callable[[list[dict], str, str], Awaitable[str]]


@dataclass(frozen=True)
class RackSvg:
    rack_name: str
    svg: str
    assets: list[MoveAsset]        # racked on this side, sorted by RU desc (top of rack first)


def racks_on(assets: list[MoveAsset], side: str) -> dict[str, list[MoveAsset]]:
    rack = (lambda a: a.source_rack) if side == "source" else (lambda a: a.destination_rack)
    ru = (lambda a: a.source_ru) if side == "source" else (lambda a: a.destination_ru)
    groups: dict[str, list[MoveAsset]] = defaultdict(list)
    for a in assets:
        if rack(a) and ru(a) is not None:
            groups[rack(a)].append(a)
    return {name: sorted(rows, key=lambda a: -(ru(a) or 0)) for name, rows in sorted(groups.items())}


async def rack_svgs(assets: list[MoveAsset], side: str,
                    renderer: Renderer = rack_renderer.render) -> list[RackSvg]:
    out = []
    for name, rows in racks_on(assets, side).items():
        svg = await renderer([a.to_row() for a in assets], name, side)
        out.append(RackSvg(rack_name=name, svg=svg, assets=rows))
    return out
```

- [ ] **Step 10: Run Python tests**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_rack_renderer.py`
Expected: 4 pass.

- [ ] **Step 11: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add portal/src/components/initiatives/RackElevation.tsx portal/src/components/initiatives/RackViewModal.tsx portal/src/styles/rack-svg.css portal/src/styles/initiatives.css portal/src/reports portal/vite.rack-renderer.config.ts portal/package.json portal/.gitignore api/src/serversherpa/config.py api/src/serversherpa/reports/rack_renderer.py api/src/serversherpa/reports/move_report/racks.py api/tests/test_rack_renderer.py
git commit -m "feat(reports): rack renderer — RackElevation extracted, Node SSR script, Python subprocess wrapper"
```

---

### Task 6: Move Report template + WeasyPrint render + `build()`

**Files:**
- Modify: `api/pyproject.toml` (dependencies: add `"jinja2>=3.1"`, `"weasyprint>=62"`)
- Create: `api/src/serversherpa/reports/move_report/templates/move_report.html`
- Create: `api/src/serversherpa/reports/move_report/render.py`
- Modify: `api/src/serversherpa/reports/move_report/__init__.py` (real `build`)
- Modify: `README.md` (dev setup: WeasyPrint system libs)
- Test: `api/tests/test_move_report_render.py` (new)

**Interfaces:**
- Consumes: Task 4 `gather`, `compute`; Task 5 `racks.rack_svgs`.
- Produces: `render.ReportContext` dataclass; `render.build_context(data, options, *, source_racks, destination_racks, generated_by, generated_at) -> ReportContext`; `render.render_html(ctx) -> str`; `render.render_pdf(html) -> bytes` (runs WeasyPrint in a thread); `move_report.build(db, run, *, renderer=rack_renderer.render) -> ReportResult` (the `renderer` kwarg exists so worker tests can inject a fake).

- [ ] **Step 1: Install deps**

Add to `api/pyproject.toml` `dependencies`: `"jinja2>=3.1",` and `"weasyprint>=62",`. Then `cd api && .venv/bin/pip install -e ".[dev]"`. If WeasyPrint fails to import (`OSError: cannot load library 'gobject-2.0'`), install the system libs: macOS `brew install pango`; Debian/Ubuntu `apt-get install -y libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libgdk-pixbuf-2.0-0`. Add that exact line to README.md's "Development setup" under step 3 (API) as a comment: `# WeasyPrint (PDF reports) needs Pango: brew install pango  (Debian: apt-get install -y libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libgdk-pixbuf-2.0-0)`. On macOS with Homebrew, if the import still fails, `export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` — add that as a second README comment line.

- [ ] **Step 2: Failing render tests** — `api/tests/test_move_report_render.py`:

```python
"""Jinja2 template: each section toggles independently; WeasyPrint smoke
test produces a real PDF."""

from datetime import UTC, datetime
from decimal import Decimal

from serversherpa.reports.move_report.gather import MoveAsset, MoveData, SiteInfo
from serversherpa.reports.move_report.racks import RackSvg
from serversherpa.reports.move_report.render import (
    build_context, render_html, render_pdf,
)

ALL_ON = {"summary": True, "assets_by_source": True, "assets_by_destination": True,
          "size_weight": True, "rail_usage": True, "collisions": True,
          "source_racks": True, "destination_racks": True}
HEADINGS = {"summary": "Summary", "assets_by_source": "Asset List - By Source",
            "assets_by_destination": "Asset List - By Destination",
            "size_weight": "Size and Weight Report", "rail_usage": "Rail Usage Report",
            "collisions": "Collision Report", "source_racks": "Source Rack Elevations",
            "destination_racks": "Destination Rack Elevations"}


def _asset(i, **kw):
    base = dict(row_id=f"r{i}", asset_id=f"a{i}", name=f"web-0{i}", serial=f"SN{i}",
                make="Dell", model="R740", ru_size=2, weight_lbs=Decimal("50"), weight_kg=None,
                length_in=None, width_in=None, height_in=None, rail_type="Sliding",
                priority_wave="W1", source_rack="R1", source_ru=float(10 + 2 * i),
                source_verified=True, source_position=None, destination_rack="D1",
                destination_ru=20.0, destination_verified=False, destination_position=None)
    base.update(kw)
    return MoveAsset(**base)


def _data(assets=None):
    return MoveData(id="i1", name="NAP11 move", initiative_type="move", type_label="Move",
                    status="planned", status_label="Planned", client_name="Acme",
                    scheduled_start=datetime(2026, 10, 1, tzinfo=UTC), scheduled_end=None,
                    origin_site=SiteInfo("DC-A", "1 Main St\nAustin, TX 78701"),
                    destination_site=SiteInfo("DC-B", ""),
                    assets=assets if assets is not None else [_asset(1), _asset(2)])


def _ctx(options=ALL_ON, assets=None, racks=None):
    racks = racks or []
    return build_context(_data(assets), options, source_racks=racks, destination_racks=racks,
                         generated_by="Alice Anderson",
                         generated_at=datetime(2026, 9, 9, 14, 30, tzinfo=UTC))


def test_all_sections_render_with_data():
    svg = RackSvg("R1", "<svg><text>web-01</text></svg>", [_asset(1)])
    html = render_html(_ctx(racks=[svg]))
    for heading in HEADINGS.values():
        assert heading in html
    assert "NAP11 move" in html and "Acme" in html and "1 Main St" in html
    assert "web-01" in html and "Sliding" in html
    assert "ru_overlap" in html or "RU overlap" in html          # both at D1 RU 20 collide
    assert html.count("<svg>") == 2                              # source + destination rack
    assert "Generated 2026-09-09" in html and "Alice Anderson" in html


def test_each_section_can_be_turned_off_independently():
    for key, heading in HEADINGS.items():
        html = render_html(_ctx({**ALL_ON, key: False}))
        assert heading not in html, key
        others = [h for k, h in HEADINGS.items() if k != key and k not in ("source_racks", "destination_racks")]
        for h in others:
            assert h in html


def test_no_assets_still_renders_summary_note():
    html = render_html(_ctx(assets=[]))
    assert "No assets on this move" in html


def test_collision_section_says_none_when_clean():
    html = render_html(_ctx(assets=[_asset(1, destination_ru=20.0), _asset(2, destination_ru=30.0)]))
    assert "No collisions" in html


def test_render_pdf_smoke():
    pdf = render_pdf(render_html(_ctx()))
    assert pdf[:5] == b"%PDF-"
    assert pdf.count(b"/Type /Page") >= 1
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_move_report_render.py`
Expected: ImportError on `render`.

- [ ] **Step 4: Template** — `api/src/serversherpa/reports/move_report/templates/move_report.html`:

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>{{ ctx.title }}</title>
<style>
  @page { size: Letter portrait; margin: 16mm 14mm 18mm 14mm;
          @top-center { content: "{{ ctx.data.name }} — Move Report"; font: 9pt sans-serif; color: #555; }
          @bottom-left { content: "Generated {{ ctx.generated_stamp }} by {{ ctx.generated_by }}"; font: 8pt sans-serif; color: #555; }
          @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt sans-serif; color: #555; } }
  body { font: 10pt/1.35 Helvetica, Arial, sans-serif; color: #111; }
  h1 { font-size: 20pt; text-align: center; text-transform: uppercase; margin: 0 0 2mm; }
  .subtitle { text-align: center; color: #555; margin-bottom: 8mm; }
  h2 { font-size: 13pt; border-bottom: 1.5px solid #111; padding-bottom: 1mm; margin: 0 0 4mm; }
  section { page-break-before: always; }
  section.first { page-break-before: auto; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; font-size: 8.5pt; }
  th, td { border: 0.5px solid #999; padding: 1.2mm 1.6mm; text-align: left; vertical-align: top; }
  th { background: #eee; font-weight: bold; }
  td.num, th.num { text-align: right; }
  tr { page-break-inside: avoid; }
  .cards { display: flex; gap: 6mm; margin-bottom: 5mm; }
  .card { flex: 1; border: 0.5px solid #999; padding: 3mm; }
  .card .label { font-size: 8pt; text-transform: uppercase; color: #555; }
  .card .name { font-weight: bold; font-size: 11pt; }
  .kv { display: grid; grid-template-columns: 38mm 1fr; row-gap: 1mm; margin-bottom: 5mm; }
  .kv div:nth-child(odd) { color: #555; }
  .totals { display: flex; gap: 6mm; margin-bottom: 5mm; }
  .totals .t { border: 0.5px solid #999; padding: 2mm 3mm; min-width: 30mm; }
  .totals .t b { display: block; font-size: 13pt; }
  .rack-page { display: flex; gap: 8mm; align-items: flex-start; }
  .rack-page .elev { width: 62mm; flex: none; }
  .rack-page .elev svg { width: 100%; height: auto; }
  .rack-page .list { flex: 1; }
  .rack-elevations { display: flex; gap: 6mm; }
  .rack-elevation-heading { text-align: center; font-size: 8pt; font-weight: bold; letter-spacing: .08em; margin-bottom: 1mm; }
  .note { color: #555; font-style: italic; }
  pre.addr { font: inherit; margin: 0; white-space: pre-line; }
</style>
</head>
<body>
<h1>{{ ctx.data.name }}</h1>
<div class="subtitle">Move Report · {{ ctx.data.type_label }} · {{ ctx.data.status_label }}</div>

{% if ctx.options.summary %}
<section class="first">
  <h2>Summary</h2>
  <div class="kv">
    <div>Initiative</div><div>{{ ctx.data.name }}</div>
    <div>Type / Status</div><div>{{ ctx.data.type_label }} / {{ ctx.data.status_label }}</div>
    <div>Client</div><div>{{ ctx.data.client_name or "—" }}</div>
    <div>Scheduled</div><div>{{ ctx.scheduled }}</div>
  </div>
  <div class="cards">
    <div class="card"><div class="label">Origin</div>
      <div class="name">{{ ctx.data.origin_site.name if ctx.data.origin_site else "—" }}</div>
      <pre class="addr">{{ ctx.data.origin_site.address if ctx.data.origin_site else "" }}</pre></div>
    <div class="card"><div class="label">Destination</div>
      <div class="name">{{ ctx.data.destination_site.name if ctx.data.destination_site else "—" }}</div>
      <pre class="addr">{{ ctx.data.destination_site.address if ctx.data.destination_site else "" }}</pre></div>
  </div>
  {% if not ctx.data.assets %}<p class="note">No assets on this move.</p>{% endif %}
  <div class="totals">
    <div class="t">Assets<b>{{ ctx.load.total_assets }}</b></div>
    <div class="t">Total RU<b>{{ ctx.load.total_ru }}</b></div>
    <div class="t">Weight<b>{{ "%.1f"|format(ctx.load.total_weight_lbs) }} lb</b>{{ "%.1f"|format(ctx.load.total_weight_kg) }} kg</div>
    <div class="t">Collisions<b>{{ ctx.collisions.collision_count }}</b>{{ ctx.collisions.assets_flagged }} assets flagged</div>
  </div>
</section>
{% endif %}

{% macro asset_table(rows) -%}
<table>
  <thead><tr><th>Serial</th><th>Name</th><th>Make</th><th>Model</th><th>Src Rack</th>
    <th class="num">Src RU</th><th>Dest Rack</th><th class="num">Dest RU</th><th>Wave</th></tr></thead>
  <tbody>
  {% for a in rows %}
  <tr><td>{{ a.serial or "—" }}</td><td>{{ a.name or "—" }}</td><td>{{ a.make or "—" }}</td>
    <td>{{ a.model or "—" }}</td><td>{{ a.source_rack or "—" }}</td>
    <td class="num">{{ ctx.ru(a.source_ru) }}</td><td>{{ a.destination_rack or "—" }}</td>
    <td class="num">{{ ctx.ru(a.destination_ru) }}</td><td>{{ a.priority_wave or "—" }}</td></tr>
  {% else %}<tr><td colspan="9" class="note">No assets on this move.</td></tr>{% endfor %}
  </tbody>
</table>
{%- endmacro %}

{% if ctx.options.assets_by_source %}
<section><h2>Asset List - By Source</h2>{{ asset_table(ctx.by_source) }}</section>
{% endif %}
{% if ctx.options.assets_by_destination %}
<section><h2>Asset List - By Destination</h2>{{ asset_table(ctx.by_destination) }}</section>
{% endif %}

{% if ctx.options.size_weight %}
<section>
  <h2>Size and Weight Report</h2>
  <div class="totals">
    <div class="t">Assets<b>{{ ctx.load.total_assets }}</b></div>
    <div class="t">Total RU<b>{{ ctx.load.total_ru }}</b></div>
    <div class="t">Total weight<b>{{ "%.1f"|format(ctx.load.total_weight_lbs) }} lb</b>{{ "%.1f"|format(ctx.load.total_weight_kg) }} kg</div>
  </div>
  <table>
    <thead><tr><th>Make/Model</th><th class="num">Count</th><th class="num">RU Size</th>
      <th class="num">Total RU</th><th class="num">Weight (lb)</th><th>Dimensions</th></tr></thead>
    <tbody>{% for m in ctx.load.models %}
    <tr><td>{{ (m.make or "") ~ " " ~ (m.model or "") }}</td><td class="num">{{ m.count }}</td>
      <td class="num">{{ m.ru_size }}</td><td class="num">{{ m.total_ru }}</td>
      <td class="num">{{ "%.1f"|format(m.weight_per_unit_lbs) }} × {{ m.count }} = {{ "%.1f"|format(m.total_weight_lbs) }}</td>
      <td>{{ m.dimensions }}</td></tr>
    {% endfor %}</tbody>
  </table>
</section>
{% endif %}

{% if ctx.options.rail_usage %}
<section>
  <h2>Rail Usage Report</h2>
  <table><thead><tr><th>Rail Type</th><th class="num">Count</th></tr></thead>
    <tbody>{% for r in ctx.rails.rail_types %}<tr><td>{{ r.rail_type }}</td><td class="num">{{ r.count }}</td></tr>{% endfor %}</tbody></table>
  <table><thead><tr><th>Make/Model</th><th class="num">Count</th><th>Rail Type</th><th class="num">RU Size</th></tr></thead>
    <tbody>{% for m in ctx.rails.models %}
    <tr><td>{{ (m.make or "") ~ " " ~ (m.model or "") }}</td><td class="num">{{ m.count }}</td><td>{{ m.rail_type }}</td><td class="num">{{ m.ru_size }}</td></tr>
    {% endfor %}</tbody></table>
</section>
{% endif %}

{% if ctx.options.collisions %}
<section>
  <h2>Collision Report</h2>
  <p>{{ ctx.collisions.assets_checked }} assets with destination assignments checked ·
     {{ ctx.collisions.collision_count }} collisions · {{ ctx.collisions.assets_flagged }} assets flagged</p>
  {% if ctx.collisions.items %}
  <table>
    <thead><tr><th>Rack</th><th>Type</th><th>Overlapping RUs</th><th>Asset A</th><th>Asset B</th></tr></thead>
    <tbody>{% for c in ctx.collisions.items %}
    <tr><td>{{ c.rack }}</td><td>{{ ctx.collision_label(c.collision_type) }}</td>
      <td>{{ c.overlapping_rus|join(", ") }}{% if c.slot_conflict %} (slot {{ c.slot_conflict }}){% endif %}</td>
      <td>{{ c.asset_a.name }}<br><small>{{ c.asset_a.asset.serial or "" }} · {{ c.asset_a.asset.make_model }} · RU {{ ctx.ru(c.asset_a.asset.destination_ru) }} × {{ c.asset_a.asset.ru_size or 1 }}U</small></td>
      <td>{{ c.asset_b.name }}<br><small>{{ c.asset_b.asset.serial or "" }} · {{ c.asset_b.asset.make_model }} · RU {{ ctx.ru(c.asset_b.asset.destination_ru) }} × {{ c.asset_b.asset.ru_size or 1 }}U</small></td></tr>
    {% endfor %}</tbody>
  </table>
  {% else %}<p class="note">No collisions.</p>{% endif %}
</section>
{% endif %}

{% macro rack_pages(heading, racks, side) -%}
{% for r in racks %}
<section>
  <h2>{{ heading }} — Rack {{ r.rack_name }}</h2>
  <div class="rack-page">
    <div class="elev">{{ r.svg|safe }}</div>
    <div class="list">
      <table><thead><tr><th>Name</th><th>Serial</th><th class="num">RU</th><th>Wave</th></tr></thead>
        <tbody>{% for a in r.assets %}
        <tr><td>{{ a.label }}</td><td>{{ a.serial or "—" }}</td>
          <td class="num">{{ ctx.ru(a.source_ru if side == "source" else a.destination_ru) }}</td>
          <td>{{ a.priority_wave or "—" }}</td></tr>
        {% endfor %}</tbody></table>
    </div>
  </div>
</section>
{% else %}
<section><h2>{{ heading }}</h2><p class="note">No racked assets on this side.</p></section>
{% endfor %}
{%- endmacro %}

{% if ctx.options.source_racks %}{{ rack_pages("Source Rack Elevations", ctx.source_racks, "source") }}{% endif %}
{% if ctx.options.destination_racks %}{{ rack_pages("Destination Rack Elevations", ctx.destination_racks, "destination") }}{% endif %}
</body>
</html>
```

- [ ] **Step 5: render.py**

```python
"""Step 4 of the Move Report: Jinja2 → HTML → WeasyPrint → PDF bytes."""

import asyncio
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from serversherpa.reports.move_report.compute import (
    CollisionReport, LoadSummary, RailSummary, collisions, load_summary, rail_summary,
    sorted_by_side,
)
from serversherpa.reports.move_report.gather import MoveAsset, MoveData
from serversherpa.reports.move_report.racks import RackSvg

_ENV = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"),
                   autoescape=select_autoescape(["html"]), trim_blocks=True, lstrip_blocks=True)

COLLISION_LABELS = {"ru_overlap": "RU overlap", "slot_conflict": "Slot conflict",
                    "ru_and_slot_conflict": "RU overlap + slot conflict"}


@dataclass
class ReportContext:
    data: MoveData
    options: dict
    load: LoadSummary
    rails: RailSummary
    collisions: CollisionReport
    by_source: list[MoveAsset]
    by_destination: list[MoveAsset]
    source_racks: list[RackSvg]
    destination_racks: list[RackSvg]
    generated_by: str
    generated_at: datetime

    @property
    def title(self) -> str:
        return f"Move Report — {self.data.name}"

    @property
    def generated_stamp(self) -> str:
        return self.generated_at.strftime("%Y-%m-%d %H:%M")

    @property
    def scheduled(self) -> str:
        fmt = lambda d: d.strftime("%Y-%m-%d") if d else None            # noqa: E731
        start, end = fmt(self.data.scheduled_start), fmt(self.data.scheduled_end)
        return f"{start} → {end}" if start and end else (start or end or "—")

    @staticmethod
    def ru(value: float | None) -> str:
        if value is None:
            return "—"
        return str(int(value)) if float(value).is_integer() else f"{value:g}"

    @staticmethod
    def collision_label(kind: str) -> str:
        return COLLISION_LABELS.get(kind, kind)


def build_context(data: MoveData, options: dict, *, source_racks: list[RackSvg],
                  destination_racks: list[RackSvg], generated_by: str,
                  generated_at: datetime) -> ReportContext:
    """Sections that are off are skipped at compute time (empty results),
    not merely hidden in the template."""
    empty_load = LoadSummary(0, 0, 0.0, 0.0, [])
    need_load = options.get("summary") or options.get("size_weight")
    need_coll = options.get("summary") or options.get("collisions")
    return ReportContext(
        data=data, options=options,
        load=load_summary(data.assets) if need_load else empty_load,
        rails=rail_summary(data.assets) if options.get("rail_usage") else RailSummary(0, [], []),
        collisions=collisions(data.assets) if need_coll else CollisionReport(),
        by_source=sorted_by_side(data.assets, "source") if options.get("assets_by_source") else [],
        by_destination=(sorted_by_side(data.assets, "destination")
                        if options.get("assets_by_destination") else []),
        source_racks=source_racks if options.get("source_racks") else [],
        destination_racks=destination_racks if options.get("destination_racks") else [],
        generated_by=generated_by, generated_at=generated_at)


def render_html(ctx: ReportContext) -> str:
    return _ENV.get_template("move_report.html").render(ctx=ctx)


def _pdf(html: str) -> bytes:
    from weasyprint import HTML            # slow import; keep it off module load
    return HTML(string=html).write_pdf()


async def render_pdf_async(html: str) -> bytes:
    return await asyncio.to_thread(_pdf, html)


def render_pdf(html: str) -> bytes:
    return _pdf(html)
```

- [ ] **Step 6: Real `build()`** — replace the stub in `api/src/serversherpa/reports/move_report/__init__.py`:

```python
async def build(db: AsyncSession, run: ReportRun, *,
                renderer: Renderer = rack_renderer.render) -> ReportResult:
    """gather → compute (inside build_context) → rack SVGs → HTML → PDF."""
    options = validate_options(run.options or {})
    data = await gather(db, run.initiative_id)
    requester = await db.get(Person, run.requested_by)
    generated_by = (f"{requester.first_name} {requester.last_name}".strip()
                    if requester else "ServerSherpa")
    src = await rack_svgs(data.assets, "source", renderer) if options["source_racks"] else []
    dst = (await rack_svgs(data.assets, "destination", renderer)
           if options["destination_racks"] else [])
    now = datetime.now()
    ctx = build_context(data, options, source_racks=src, destination_racks=dst,
                        generated_by=generated_by, generated_at=now)
    pdf = await render_pdf_async(render_html(ctx))
    safe_name = re.sub(r'[\\/:*?"<>|]+', "-", data.name).strip() or "initiative"
    filename = f"Move Report - {safe_name} - {now:%Y-%m-%d %H%M}.pdf"
    return ReportResult(pdf=pdf, filename=filename)
```

  with imports added at the top of that file: `import re`, `from datetime import datetime`, `from serversherpa.db.models import Person, ReportRun`, `from serversherpa.reports import rack_renderer`, `from serversherpa.reports.move_report.gather import gather`, `from serversherpa.reports.move_report.racks import Renderer, rack_svgs`, `from serversherpa.reports.move_report.render import build_context, render_html, render_pdf_async`. (`Renderer` is the callable alias from `racks.py`.)

- [ ] **Step 7: Run tests**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_move_report_render.py tests/test_move_report_compute.py tests/test_reports_api.py`
Expected: all pass. If the PDF smoke test fails on missing Pango, fix the environment per Step 1 — do not skip the test.

- [ ] **Step 8: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/pyproject.toml README.md api/src/serversherpa/reports/move_report api/tests/test_move_report_render.py
git commit -m "feat(reports): move report template, WeasyPrint render, build()"
```

---

### Task 7: `report-worker` — jobs, loop, CLI, Procfile

**Files:**
- Create: `api/src/serversherpa/reports/jobs.py`, `api/src/serversherpa/reports/worker.py`
- Modify: `api/src/serversherpa/cli.py` (new `report_worker` command + process fn, after `import_worker`)
- Modify: `Procfile.dev` (add `reportsvc` line)
- Test: `api/tests/test_report_worker.py` (new)

**Interfaces:**
- Consumes: Task 1 models + `notify()`; Task 2 `get_module`; Task 5 `RackRendererUnavailable`; `serversherpa.system.admin_config.poll_workers_paused`; `serversherpa.system.registry.start_heartbeat`; `serversherpa.services.storage.put_object`.
- Produces: `jobs.claim_next(db) -> ReportRun | None`, `jobs.requeue_stale(db) -> int`, `jobs.STALE_MINUTES = 15`; `worker.process_run(db, run, *, renderer=None)`, `worker.run_once(sessionmaker, *, renderer=None) -> bool`, `worker.run_forever(poll_seconds=2.0)`, `worker.RUN_TIMEOUT_SECONDS = 300`; CLI `serversherpa report-worker [--poll-seconds] [--once] [--reload]`; process name `report-worker`, kind `worker`.

- [ ] **Step 1: Failing tests** — `api/tests/test_report_worker.py`:

```python
"""report-worker: claim → build → upload → attach → notify, plus every
failure path, stale re-queue, pause, and the loop surviving DB blips.
The module's build is faked so no Node/WeasyPrint is needed here."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Attachment, Initiative, Notification, Person, ReportDefinition, ReportRun, SystemProcess,
)
from serversherpa.reports import worker
from serversherpa.reports.jobs import STALE_MINUTES, claim_next, requeue_stale
from serversherpa.reports.registry import ReportResult
from serversherpa.services.storage import get_object

ALL_ON = {"summary": True, "assets_by_source": True, "assets_by_destination": True,
          "size_weight": True, "rail_usage": True, "collisions": True,
          "source_racks": True, "destination_racks": True}


async def _run(db, *, notify=False, status="queued", started_at=None):
    person = Person(first_name="Rae", last_name="Requester")
    d = ReportDefinition(name="Move Report", report_type="move_report", options=ALL_ON,
                         is_system=True)
    ini = Initiative(name="NAP11", initiative_type="move", status="planned")
    db.add_all([person, d, ini])
    await db.flush()
    run = ReportRun(definition_id=d.id, report_type="move_report", initiative_id=ini.id,
                    options=ALL_ON, requested_by=person.id, requested_rank=40, notify=notify,
                    status=status, started_at=started_at)
    db.add(run)
    await db.commit()
    return run.id, person.id, ini.id


class FakeModule:
    report_type = "move_report"

    def __init__(self, *, fail: Exception | None = None, slow: float = 0):
        self.fail, self.slow = fail, slow

    def default_options(self):
        return ALL_ON

    def validate_options(self, o):
        return {**ALL_ON, **o}

    async def build(self, db, run, *, renderer=None):
        if self.slow:
            await asyncio.sleep(self.slow)
        if self.fail:
            raise self.fail
        return ReportResult(pdf=b"%PDF-1.4 fake", filename="Move Report - NAP11 - 2026-09-09 1200.pdf")


async def test_claim_next_oldest_first_and_requeue_stale(db):
    r1, *_ = await _run(db)
    r2, *_ = await _run(db)
    claimed = await claim_next(db)
    assert claimed.id == r1 and claimed.status == "running" and claimed.started_at is not None
    assert (await claim_next(db)).id == r2
    assert await claim_next(db) is None
    stale = await db.get(ReportRun, r1)
    stale.started_at = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES + 1)
    await db.commit()
    assert await requeue_stale(db) == 1
    await db.refresh(stale)
    assert stale.status == "queued" and stale.started_at is None
    fresh = await db.get(ReportRun, r2)
    assert fresh.status == "running"                    # not stale — untouched


async def test_run_once_completes_uploads_attaches_and_notifies(db, monkeypatch):
    monkeypatch.setattr(worker, "get_module", lambda t: FakeModule())
    run_id, person_id, ini_id = await _run(db, notify=True)
    assert await worker.run_once(get_sessionmaker()) is True
    run = await db.get(ReportRun, run_id)
    assert run.status == "completed" and run.finished_at is not None
    assert run.storage_key == f"reports/{ini_id}/{run_id}.pdf"
    assert run.filename.startswith("Move Report - NAP11") and run.size_bytes == len(b"%PDF-1.4 fake")
    assert await get_object(run.storage_key) == b"%PDF-1.4 fake"
    att = await db.get(Attachment, run.attachment_id)
    assert (att.entity_type, str(att.entity_id), att.kind, att.content_type,
            att.uploaded_by, att.filename) == (
        "initiative", str(ini_id), "document", "application/pdf", person_id, run.filename)
    n = await db.scalar(select(Notification).where(Notification.person_id == person_id))
    assert n.kind == "report_ready" and n.title == "Move Report is ready" and n.body == "NAP11"
    assert n.link == f"/reports?tab=history&run={run_id}" and n.payload == {"run_id": str(run_id)}


async def test_run_once_without_notify_writes_no_inbox_row(db, monkeypatch):
    monkeypatch.setattr(worker, "get_module", lambda t: FakeModule())
    await _run(db, notify=False)
    await worker.run_once(get_sessionmaker())
    assert await db.scalar(select(Notification)) is None


async def test_build_failure_marks_failed_and_notifies(db, monkeypatch):
    from serversherpa.reports.rack_renderer import RackRendererUnavailable
    monkeypatch.setattr(worker, "get_module",
                        lambda t: FakeModule(fail=RackRendererUnavailable("renderer script not found: x")))
    run_id, person_id, _ = await _run(db, notify=True)
    await worker.run_once(get_sessionmaker())
    run = await db.get(ReportRun, run_id)
    assert run.status == "failed" and run.attachment_id is None
    assert run.error.startswith("rack renderer unavailable: renderer script not found")
    n = await db.scalar(select(Notification).where(Notification.person_id == person_id))
    assert n.kind == "report_failed" and n.body == run.error


async def test_initiative_unavailable_and_timeout(db, monkeypatch):
    from serversherpa.reports.move_report.gather import InitiativeUnavailable
    monkeypatch.setattr(worker, "get_module", lambda t: FakeModule(fail=InitiativeUnavailable("x")))
    run_id, *_ = await _run(db)
    await worker.run_once(get_sessionmaker())
    assert (await db.get(ReportRun, run_id)).error == "initiative_unavailable"
    monkeypatch.setattr(worker, "get_module", lambda t: FakeModule(slow=1.0))
    monkeypatch.setattr(worker, "RUN_TIMEOUT_SECONDS", 0.1)
    run_id, *_ = await _run(db)
    await worker.run_once(get_sessionmaker())
    run = await db.get(ReportRun, run_id)
    assert run.status == "failed" and "timed out" in run.error


async def test_run_forever_heartbeats_idles_when_paused_and_survives_claim_blip(db, monkeypatch, caplog):
    monkeypatch.setattr("serversherpa.system.db_logging.install", lambda name: None)
    calls = {"n": 0}

    async def flaky_claim(session):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("db blip")
        return None

    monkeypatch.setattr(worker, "claim_next", flaky_claim)
    task = asyncio.create_task(worker.run_forever(poll_seconds=0.05))
    try:
        for _ in range(80):
            await asyncio.sleep(0.05)
            row = await db.scalar(select(SystemProcess).where(SystemProcess.name == "report-worker"))
            if row is not None and calls["n"] >= 3:
                break
        assert row is not None and row.kind == "worker"
        assert not task.done()                          # the blip did not kill the loop
        assert calls["n"] >= 3
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_report_worker.py`
Expected: ImportError.

- [ ] **Step 3: jobs.py**

```python
"""report_runs queue helpers — same shape as imports/jobs.py: the table is
the queue, workers claim with FOR UPDATE SKIP LOCKED."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import ReportRun

STALE_MINUTES = 15


async def claim_next(db: AsyncSession) -> ReportRun | None:
    run = await db.scalar(
        select(ReportRun).where(ReportRun.status == "queued")
        .order_by(ReportRun.created_at).limit(1).with_for_update(skip_locked=True))
    if run is None:
        return None
    run.status = "running"
    run.started_at = datetime.now(UTC)
    await db.commit()
    return run


async def requeue_stale(db: AsyncSession) -> int:
    """A worker crashed mid-run: runs still 'running' past STALE_MINUTES go
    back to the queue. Re-running is safe — nothing is written until the
    PDF is complete."""
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    runs = (await db.scalars(
        select(ReportRun).where(ReportRun.status == "running", ReportRun.started_at < cutoff)
        .with_for_update(skip_locked=True))).all()
    for run in runs:
        run.status = "queued"
        run.started_at = None
    await db.commit()
    return len(runs)
```

- [ ] **Step 4: worker.py**

```python
"""The report worker loop (`serversherpa report-worker`) — a separate
process from the API. Claims queued report_runs, renders the PDF through
the module registry, uploads it, attaches it to the initiative, and
writes an inbox row when asked. A bad run never kills the loop; a DB blip
on the claim is swallowed and logged once (same rule as the pause check
and the heartbeat: a DB blip must never kill the host process)."""

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Attachment, Initiative, ReportDefinition, ReportRun
from serversherpa.notifications.inbox import notify
from serversherpa.reports.jobs import claim_next, requeue_stale
from serversherpa.reports.move_report.gather import InitiativeUnavailable
from serversherpa.reports.rack_renderer import RackRendererUnavailable
from serversherpa.reports.registry import get_module
from serversherpa.services.storage import put_object

logger = logging.getLogger("serversherpa.reports.worker")

RUN_TIMEOUT_SECONDS = 300.0
ERROR_MAX = 2000


def _finish(run: ReportRun, status: str, error: str | None = None) -> None:
    run.status = status
    run.error = error[:ERROR_MAX] if error else None
    run.finished_at = datetime.now(UTC)


async def _notify(db: AsyncSession, run: ReportRun, definition_name: str,
                  initiative_name: str) -> None:
    await db.refresh(run, ["notify"])          # a "notify me" click mid-run counts
    if not run.notify:
        return
    link = f"/reports?tab=history&run={run.id}"
    payload = {"run_id": str(run.id)}
    if run.status == "completed":
        await notify(db, run.requested_by, "report_ready", f"{definition_name} is ready",
                     body=initiative_name, link=link, payload=payload)
    else:
        await notify(db, run.requested_by, "report_failed", f"{definition_name} failed",
                     body=run.error or "unknown error", link=link, payload=payload)


async def process_run(db: AsyncSession, run: ReportRun, *, renderer=None) -> None:
    """Run one claimed (status='running') run to a terminal status."""
    definition = await db.get(ReportDefinition, run.definition_id)
    initiative = await db.get(Initiative, run.initiative_id)
    definition_name = definition.name if definition else run.report_type
    initiative_name = initiative.name if initiative else "?"
    try:
        module = get_module(run.report_type)
        kwargs = {"renderer": renderer} if renderer is not None else {}
        result = await asyncio.wait_for(module.build(db, run, **kwargs), RUN_TIMEOUT_SECONDS)
        key = f"reports/{run.initiative_id}/{run.id}.pdf"
        await put_object(key, result.pdf, "application/pdf")
        attachment = Attachment(
            entity_type="initiative", entity_id=run.initiative_id, kind="document",
            storage_key=key, filename=result.filename, content_type="application/pdf",
            size_bytes=len(result.pdf), uploaded_by=run.requested_by)
        db.add(attachment)
        await db.flush()
        run.storage_key = key
        run.attachment_id = attachment.id
        run.filename = result.filename
        run.size_bytes = len(result.pdf)
        _finish(run, "completed")
    except InitiativeUnavailable:
        _finish(run, "failed", "initiative_unavailable")
    except RackRendererUnavailable as exc:
        _finish(run, "failed", f"rack renderer unavailable: {exc}")
    except TimeoutError:
        _finish(run, "failed", f"timed out after {RUN_TIMEOUT_SECONDS:g}s")
    except Exception as exc:                                    # run must terminate
        logger.exception("run %s failed: %s", run.id, exc)
        _finish(run, "failed", f"{type(exc).__name__}: {exc}")
    await _notify(db, run, definition_name, initiative_name)
    await db.commit()


async def run_once(sessionmaker, *, renderer=None) -> bool:
    """Claim and process at most one run. False when the queue is empty."""
    async with sessionmaker() as db:
        run = await claim_next(db)
        if run is None:
            return False
        logger.info("claimed run %s (%s)", run.id, run.report_type)
        try:
            await process_run(db, run, renderer=renderer)
        except Exception as exc:                                # e.g. commit failed
            logger.exception("run %s crashed in worker: %s", run.id, exc)
            await db.rollback()
            _finish(run, "failed", f"worker_error: {exc}")
            await db.commit()
        logger.info("run %s finished status=%s", run.id, run.status)
        return True


async def run_forever(poll_seconds: float = 2.0) -> None:
    from serversherpa.db.engine import get_sessionmaker
    from serversherpa.system.admin_config import poll_workers_paused
    from serversherpa.system.db_logging import install
    from serversherpa.system.registry import start_heartbeat

    install("report-worker")
    pause_state = {"paused": False}
    check_state: dict = {}
    claim_state = {"failed": False}
    heartbeat = start_heartbeat("report-worker", "worker", meta_fn=lambda: dict(pause_state))
    maker = get_sessionmaker()
    try:
        try:
            async with maker() as db:
                requeued = await requeue_stale(db)
                if requeued:
                    logger.info("re-queued %d stale run(s)", requeued)
        except Exception:
            logger.warning("could not re-queue stale runs at startup", exc_info=True)
        logger.info("report worker online — watching the queue")
        while True:
            if await poll_workers_paused(maker, check_state):
                if not pause_state["paused"]:
                    logger.info("paused by read-only maintenance mode")
                pause_state["paused"] = True
                await asyncio.sleep(poll_seconds)
                continue
            if pause_state["paused"]:
                logger.info("resumed")
            pause_state["paused"] = False
            try:
                worked = await run_once(maker)
                claim_state["failed"] = False
            except Exception:
                if not claim_state["failed"]:
                    logger.warning("could not poll the report queue — retrying", exc_info=True)
                claim_state["failed"] = True
                worked = False
            if not worked:
                await asyncio.sleep(poll_seconds)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
```

- [ ] **Step 5: CLI + Procfile** — in `api/src/serversherpa/cli.py`, after the `import_worker` command:

```python
def _run_report_worker_process(poll_seconds: float) -> None:
    """Reload-mode child entry point (see _run_worker_process)."""

    async def _run() -> None:
        from serversherpa.reports import worker

        await worker.run_forever(poll_seconds)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


@app.command()
def report_worker(
    poll_seconds: float = typer.Option(2.0, help="Idle sleep between queue polls"),
    once: bool = typer.Option(False, help="Process at most one run, then exit"),
    reload: bool = typer.Option(
        False, help="Dev mode: restart the worker whenever api/src changes"),
) -> None:
    """Run the report worker — renders queued report_runs into PDFs, stores
    them in Spaces, attaches them to the initiative, and notifies."""

    if reload and once:
        typer.secho("--once cannot be combined with --reload", fg="red")
        raise typer.Exit(code=1)
    if reload:
        import watchfiles

        src_dir = Path(__file__).resolve().parents[1]
        typer.secho(f"[report-worker] dev reload — watching {src_dir}", fg="cyan")
        watchfiles.run_process(src_dir, target=_run_report_worker_process,
                               args=(poll_seconds,))
        return

    async def _run() -> None:
        from serversherpa.db.engine import get_sessionmaker
        from serversherpa.reports import worker

        if once:
            worked = await worker.run_once(get_sessionmaker())
            typer.secho("processed 1 run" if worked else "queue empty",
                        fg="green" if worked else "yellow")
        else:
            await worker.run_forever(poll_seconds)
        await dispose_engine()

    asyncio.run(_run())
```

  `Procfile.dev`: add `reportsvc: api/.venv/bin/serversherpa report-worker --reload` after `scanmatch`.

- [ ] **Step 6: Run tests**

Run: `cd api && .venv/bin/python -m pytest -q tests/test_report_worker.py tests/test_system_admin_api.py`
Expected: all pass. Then a manual end-to-end with the real module: `cd portal && npm run build:rack-renderer`, then queue a run via the API against the dev DB (or a `test_reports_api` run left in the test DB) and `cd api && .venv/bin/serversherpa report-worker --once` → `processed 1 run`; confirm the run row is `completed` and the PDF opens from MinIO (`http://localhost:9001`).

- [ ] **Step 7: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add api/src/serversherpa/reports/jobs.py api/src/serversherpa/reports/worker.py api/src/serversherpa/cli.py Procfile.dev api/tests/test_report_worker.py
git commit -m "feat(reports): report-worker — claim/build/upload/attach/notify loop, CLI, Procfile"
```

---

### Task 8: Portal — API client, nav, Reports page (Available tab + Edit/Clone/Delete)

**Files:**
- Modify: `portal/src/lib/api.ts` (append a `// ── reports ──` block and a `// ── inbox ──` block at the end)
- Create: `portal/src/lib/reports.ts`
- Modify: `portal/src/layout/navSections.tsx` (new section after `Labels`)
- Modify: `portal/src/App.tsx` (import + route after the labels routes)
- Modify: `portal/src/components/Topbar.tsx` (CRUMBS: `'/reports': ['Reports', 'Reports']`; QUICK list entry `{ label: 'Reports', to: '/reports' }`)
- Create: `portal/src/pages/Reports.tsx`, `portal/src/components/reports/EditDefinitionModal.tsx`, `portal/src/styles/reports.css`
- Test: `portal/src/layout/reportsNav.test.tsx`, `portal/src/lib/reports.test.ts`, `portal/src/pages/Reports.test.tsx` (new)

**Interfaces:**
- Produces (`lib/api.ts`): types `ReportDefinition {id, name, description, report_type, options: Record<string, boolean>, is_system, updated_at}`, `ReportRun {id, definition_id, definition_name, report_type, initiative_id, initiative_name, options, status: 'queued'|'running'|'completed'|'failed', error, requested_by, requested_by_name, requested_rank, notify, filename, size_bytes, started_at, finished_at, created_at}`, `InboxItem {id, kind, title, body, link, payload: Record<string, unknown>, created_at, read_at}`, `Inbox {unread_count, items: InboxItem[]}`; functions `listReportDefinitions()`, `cloneReportDefinition(id)`, `updateReportDefinition(id, patch)`, `deleteReportDefinition(id)`, `createReportRun(body: {definition_id, initiative_id, options, notify})`, `listReportRuns(params?: {status?, report_type?, initiative_id?, before?, limit?})`, `getReportRun(id)`, `getReportRunDownloadUrl(id) → Promise<string>`, `setReportRunNotify(id, notify)`, `listInbox(unreadOnly?)`, `markInboxRead(id)`, `markAllInboxRead()`.
- Produces (`lib/reports.ts`): `MOVE_REPORT_SECTIONS: {key, title, description}[]` (the eight, verbatim copy from Global Constraints), `sectionCount(options)`, `sortInitiativesForPicker(items)`, `STATUS_GROUP_ORDER`.
- Produces: `Reports` page at `/reports` with `?tab=available|history`; `EditDefinitionModal` props `{definition, onClose, onSaved}`.

- [ ] **Step 1: Failing tests**

`portal/src/layout/reportsNav.test.tsx`:

```tsx
// @vitest-environment jsdom
import { expect, it } from 'vitest';

import { NAV_SECTIONS } from './navSections';

it('Reports sits right after Labels, one item gated on reports', () => {
  const labels = NAV_SECTIONS.map((s) => s.label);
  expect(labels.indexOf('Reports')).toBe(labels.indexOf('Labels') + 1);
  const section = NAV_SECTIONS[labels.indexOf('Reports')];
  expect(section.items.map((i) => [i.to, i.label, i.resource])).toEqual([
    ['/reports', 'Reports', 'reports'],
  ]);
});
```

`portal/src/lib/reports.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { InitiativeItem } from './api';
import { MOVE_REPORT_SECTIONS, sectionCount, sortInitiativesForPicker } from './reports';

const ini = (name: string, status: string, archived = false) => ({
  name, status, archived_at: archived ? '2026-01-01T00:00:00Z' : null,
} as InitiativeItem);

describe('reports helpers', () => {
  it('lists the eight sections in V2 order', () => {
    expect(MOVE_REPORT_SECTIONS.map((s) => s.key)).toEqual([
      'summary', 'assets_by_source', 'assets_by_destination', 'size_weight',
      'rail_usage', 'collisions', 'source_racks', 'destination_racks',
    ]);
    expect(MOVE_REPORT_SECTIONS[1].description).toBe('Assets sorted by source rack and RU');
  });
  it('counts enabled sections', () => {
    expect(sectionCount({ summary: true, collisions: false })).toBe(1);
  });
  it('sorts in_progress, scheduled, planned first, then on_hold, then the rest; name within group; no archived', () => {
    const out = sortInitiativesForPicker([
      ini('Zeta', 'completed'), ini('Beta', 'planned'), ini('Alpha', 'in_progress'),
      ini('Gamma', 'scheduled'), ini('Held', 'on_hold'), ini('Old', 'planned', true),
      ini('Anna', 'planned'), ini('Cancelled', 'cancelled'),
    ]);
    expect(out.map((i) => i.name)).toEqual([
      'Alpha', 'Gamma', 'Anna', 'Beta', 'Held', 'Cancelled', 'Zeta',
    ]);
  });
});
```

`portal/src/pages/Reports.test.tsx` (Available tab; History assertions arrive in Task 9):

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ReportDefinition, ReportRun, UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => ({ can: (_r: string, _a?: string) => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can, godMode: false,
    preferences: { accent: 'blue', theme: 'dark', density: 'comfortable', motion: true,
      notif: { critical: true, email: true, maint: true, digest: true }, list_prefs: {} } satisfies UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: { read_only: false, read_only_message: '', workers_paused: false, banner: null }, refresh: vi.fn() }),
}));
const api = vi.hoisted(() => ({
  listReportDefinitions: vi.fn(), cloneReportDefinition: vi.fn(), updateReportDefinition: vi.fn(),
  deleteReportDefinition: vi.fn(), listReportRuns: vi.fn(), getReportRun: vi.fn(),
  getReportRunDownloadUrl: vi.fn(), createReportRun: vi.fn(), setReportRunNotify: vi.fn(),
  listInitiatives: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

const DEFS: ReportDefinition[] = [
  { id: 'd1', name: 'Move Report', description: 'The full move report', report_type: 'move_report',
    options: { summary: true, assets_by_source: true, assets_by_destination: true, size_weight: true,
      rail_usage: true, collisions: true, source_racks: true, destination_racks: true },
    is_system: true, updated_at: '2026-09-09T10:00:00Z' },
  { id: 'd2', name: 'Racks only', description: '', report_type: 'move_report',
    options: { summary: false, assets_by_source: false, assets_by_destination: false, size_weight: false,
      rail_usage: false, collisions: false, source_racks: true, destination_racks: true },
    is_system: false, updated_at: '2026-09-09T11:00:00Z' },
];
const RUNS: ReportRun[] = [];

const { default: Reports } = await import('./Reports');

function renderPage(path = '/reports') {
  return render(<MemoryRouter initialEntries={[path]}><Reports /></MemoryRouter>);
}

beforeEach(() => {
  auth.can = () => true;
  api.listReportDefinitions.mockResolvedValue(DEFS);
  api.listReportRuns.mockResolvedValue(RUNS);
  api.listInitiatives.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('lists definitions with section counts and a System badge', async () => {
  renderPage();
  await screen.findByText('Move Report');
  expect(screen.getByText('Racks only')).toBeTruthy();
  expect(screen.getAllByText('8 of 8')[0]).toBeTruthy();
  expect(screen.getByText('2 of 8')).toBeTruthy();
  expect(screen.getAllByText('System')).toHaveLength(1);
});

it('row actions: Generate always; Edit/Clone/Delete by permission; Delete hidden on system rows', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Move Report');
  const triggers = screen.getAllByRole('button', { name: /actions/i });
  await user.click(triggers[0]);                           // Move Report (system)
  expect(screen.getByText('Generate')).toBeTruthy();
  expect(screen.getByText('Edit')).toBeTruthy();
  expect(screen.getByText('Clone')).toBeTruthy();
  expect(screen.queryByText('Delete')).toBeNull();
  await user.keyboard('{Escape}');
  await user.click(triggers[1]);                           // Racks only (custom)
  expect(screen.getByText('Delete')).toBeTruthy();
});

it('hides Edit/Clone/Delete without change/delete; Generate needs add', async () => {
  auth.can = (_r, a) => a === 'view' || a === 'add';
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Move Report');
  await user.click(screen.getAllByRole('button', { name: /actions/i })[1]);
  expect(screen.getByText('Generate')).toBeTruthy();
  expect(screen.queryByText('Edit')).toBeNull();
  expect(screen.queryByText('Clone')).toBeNull();
  expect(screen.queryByText('Delete')).toBeNull();
});

it('clone calls the API and reloads', async () => {
  const user = userEvent.setup();
  api.cloneReportDefinition.mockResolvedValue({ ...DEFS[1], id: 'd3', name: 'Racks only (copy)' });
  renderPage();
  await screen.findByText('Racks only');
  await user.click(screen.getAllByRole('button', { name: /actions/i })[1]);
  await user.click(screen.getByText('Clone'));
  await waitFor(() => expect(api.cloneReportDefinition).toHaveBeenCalledWith('d2'));
  expect(api.listReportDefinitions).toHaveBeenCalledTimes(2);
});

it('edit modal saves name and toggled defaults', async () => {
  const user = userEvent.setup();
  api.updateReportDefinition.mockResolvedValue({ ...DEFS[1], name: 'Racks!' });
  renderPage();
  await screen.findByText('Racks only');
  await user.click(screen.getAllByRole('button', { name: /actions/i })[1]);
  await user.click(screen.getByText('Edit'));
  const name = screen.getByLabelText('Name');
  await user.clear(name);
  await user.type(name, 'Racks!');
  await user.click(screen.getByLabelText(/^Summary/));    // turn summary on
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateReportDefinition).toHaveBeenCalledWith('d2', {
    name: 'Racks!', description: '',
    options: { ...DEFS[1].options, summary: true },
  }));
});

it('delete confirms then calls the API', async () => {
  const user = userEvent.setup();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.deleteReportDefinition.mockResolvedValue(undefined);
  renderPage();
  await screen.findByText('Racks only');
  await user.click(screen.getAllByRole('button', { name: /actions/i })[1]);
  await user.click(screen.getByText('Delete'));
  await waitFor(() => expect(api.deleteReportDefinition).toHaveBeenCalledWith('d2'));
});

it('tab query switches to History', async () => {
  renderPage('/reports?tab=history');
  await waitFor(() => expect(api.listReportRuns).toHaveBeenCalled());
  expect(screen.getByRole('tab', { name: /History/ }).className).toContain('on');
});
```

  (`RowActionsMenu`'s trigger button: check its `aria-label`/`title` in `components/hardware/RowActionsMenu.tsx` — the tests use `/actions/i`; if the trigger's accessible name differs, use that.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd portal && npx vitest run src/layout/reportsNav.test.tsx src/lib/reports.test.ts src/pages/Reports.test.tsx`
Expected: module-not-found failures.

- [ ] **Step 3: `lib/api.ts` additions** — append:

```ts
// ── reports ─────────────────────────────────────────────────────────

export type ReportRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ReportDefinition {
  id: string; name: string; description: string; report_type: string;
  options: Record<string, boolean>; is_system: boolean; updated_at: string;
}

export interface ReportRun {
  id: string; definition_id: string; definition_name: string; report_type: string;
  initiative_id: string; initiative_name: string; options: Record<string, boolean>;
  status: ReportRunStatus; error: string | null;
  requested_by: string; requested_by_name: string; requested_rank: number; notify: boolean;
  filename: string | null; size_bytes: number | null;
  started_at: string | null; finished_at: string | null; created_at: string;
}

export async function listReportDefinitions(): Promise<ReportDefinition[]> {
  const resp = await apiFetch('/reports/definitions');
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function cloneReportDefinition(id: string): Promise<ReportDefinition> {
  const resp = await apiFetch(`/reports/definitions/${id}/clone`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function updateReportDefinition(
  id: string, patch: { name?: string; description?: string; options?: Record<string, boolean> },
): Promise<ReportDefinition> {
  const resp = await apiFetch(`/reports/definitions/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function deleteReportDefinition(id: string): Promise<void> {
  const resp = await apiFetch(`/reports/definitions/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function createReportRun(body: {
  definition_id: string; initiative_id: string; options: Record<string, boolean>; notify: boolean;
}): Promise<ReportRun> {
  const resp = await apiFetch('/reports/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listReportRuns(params: {
  status?: ReportRunStatus; report_type?: string; initiative_id?: string;
  before?: string; limit?: number;
} = {}): Promise<ReportRun[]> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) qs.set(k, String(v)); });
  const resp = await apiFetch(`/reports/runs${qs.size ? `?${qs}` : ''}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getReportRun(id: string): Promise<ReportRun> {
  const resp = await apiFetch(`/reports/runs/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function getReportRunDownloadUrl(id: string): Promise<string> {
  const resp = await apiFetch(`/reports/runs/${id}/download`);
  if (!resp.ok) throw await errorFrom(resp);
  return (await resp.json() as { url: string }).url;
}

export async function setReportRunNotify(id: string, notify: boolean): Promise<ReportRun> {
  const resp = await apiFetch(`/reports/runs/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notify }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

// ── in-app inbox ────────────────────────────────────────────────────

export interface InboxItem {
  id: string; kind: string; title: string; body: string; link: string | null;
  payload: Record<string, unknown>; created_at: string; read_at: string | null;
}
export interface Inbox { unread_count: number; items: InboxItem[] }

export async function listInbox(unreadOnly = false): Promise<Inbox> {
  const resp = await apiFetch(`/notifications/inbox${unreadOnly ? '?unread_only=true' : ''}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function markInboxRead(id: string): Promise<void> {
  const resp = await apiFetch(`/notifications/inbox/${id}/read`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}

export async function markAllInboxRead(): Promise<void> {
  const resp = await apiFetch('/notifications/inbox/read-all', { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}
```

- [ ] **Step 4: `lib/reports.ts`**

```ts
/** Reports helpers shared by the page and the Generate modal. */
import type { InitiativeItem } from './api';

export interface ReportSection { key: string; title: string; description: string }

export const MOVE_REPORT_SECTIONS: ReportSection[] = [
  { key: 'summary', title: 'Summary', description: 'Move info, locations, load summary, collision summary' },
  { key: 'assets_by_source', title: 'Asset List - By Source', description: 'Assets sorted by source rack and RU' },
  { key: 'assets_by_destination', title: 'Asset List - By Destination', description: 'Assets sorted by destination rack and RU' },
  { key: 'size_weight', title: 'Size and Weight Report', description: 'Total RU, weight, per-model breakdown' },
  { key: 'rail_usage', title: 'Rail Usage Report', description: 'Rail types summary and model breakdown' },
  { key: 'collisions', title: 'Collision Report', description: 'Overlapping RU assignment details' },
  { key: 'source_racks', title: 'Source Rack Elevations', description: 'Visual rack diagrams for source racks' },
  { key: 'destination_racks', title: 'Destination Rack Elevations', description: 'Visual rack diagrams for destination racks' },
];

export function sectionCount(options: Record<string, boolean>): number {
  return MOVE_REPORT_SECTIONS.filter((s) => options[s.key]).length;
}

/** Seeded status_values keys for record_type=initiative, in picker order.
 *  Anything unknown sorts after `cancelled`. */
export const STATUS_GROUP_ORDER = ['in_progress', 'scheduled', 'planned', 'on_hold', 'completed', 'cancelled'];

export function sortInitiativesForPicker(items: InitiativeItem[]): InitiativeItem[] {
  const rank = (s: string) => {
    const i = STATUS_GROUP_ORDER.indexOf(s);
    return i === -1 ? STATUS_GROUP_ORDER.length : i;
  };
  return items
    .filter((i) => !i.archived_at)
    .sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name));
}

export function formatBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 5: Nav, route, crumbs** — in `navSections.tsx` insert after the `Labels` section object:

```tsx
  {
    label: 'Reports',
    items: [
      {
        to: '/reports',
        label: 'Reports',
        resource: 'reports',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <path d="M14 3v6h6" />
            <path d="M8 13h8M8 17h5" />
          </svg>
        ),
      },
    ],
  },
```

  `App.tsx`: `import Reports from './pages/Reports';` and, after the `/labels/printers` route: `<Route path="/reports" element={<ProtectedRoute resource="reports"><Reports /></ProtectedRoute>} />`.
  `Topbar.tsx`: add `'/reports': ['Reports', 'Reports'],` to `CRUMBS` and `{ label: 'Reports', to: '/reports' },` to the quick-links list after the Printers entry.

- [ ] **Step 6: `EditDefinitionModal.tsx`**

```tsx
/** Edit a report definition's name, description and default sections. */
import { useState } from 'react';

import { Switch } from '../Switch';
import { ApiError, updateReportDefinition } from '../../lib/api';
import type { ReportDefinition } from '../../lib/api';
import { MOVE_REPORT_SECTIONS } from '../../lib/reports';

export default function EditDefinitionModal({ definition, onClose, onSaved }: {
  definition: ReportDefinition;
  onClose: () => void;
  onSaved: (d: ReportDefinition) => void;
}) {
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description);
  const [options, setOptions] = useState<Record<string, boolean>>({ ...definition.options });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!name.trim()) { setError('Enter a name.'); return; }
    setSaving(true);
    setError('');
    try {
      const d = await updateReportDefinition(definition.id, {
        name: name.trim(), description, options,
      });
      onSaved(d);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'name_in_use'
        ? 'A report with that name already exists.'
        : err instanceof ApiError ? err.message : "Couldn't save.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card">
        <div className="modal-head">
          <h3>Edit {definition.name}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>Name</span>
            <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Description</span>
            <input aria-label="Description" value={description}
                   onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="modal-section">Default sections</div>
          <div className="report-sections">
            {MOVE_REPORT_SECTIONS.map((s) => (
              <label key={s.key} className="report-section-row">
                <Switch checked={!!options[s.key]}
                        onChange={(v) => setOptions((o) => ({ ...o, [s.key]: v }))} />
                <span className="report-section-text">
                  <span className="report-section-title">{s.title}</span>
                  <span className="report-section-desc">{s.description}</span>
                </span>
              </label>
            ))}
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-solid" onClick={() => void save()} disabled={saving}>Save</button>
        </div>
      </div>
    </div>
  );
}
```

  (`getByLabelText(/^Summary/)` resolves through the `<label>` wrapping the Switch's checkbox — the label's text is the title followed by the description, hence the prefix regex.)

- [ ] **Step 7: `styles/reports.css`**

```css
/* Reports page + Generate/Edit modals */
.reports-modal-card { width: min(640px, 94vw); }
.report-sections { display: flex; flex-direction: column; }
.report-section-row {
  display: flex; align-items: center; gap: 14px; padding: 10px 0;
  border-bottom: 1px solid var(--line); cursor: pointer;
}
.report-section-row:last-child { border-bottom: 0; }
.report-section-text { display: flex; flex-direction: column; gap: 2px; }
.report-section-title { font-weight: 600; }
.report-section-desc { font-size: 12px; color: var(--text-muted); }
.report-section-actions { display: flex; gap: 14px; margin-top: 8px; }
.report-section-actions button { background: none; border: 0; color: var(--accent); cursor: pointer; padding: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

/* initiative picker (Generate modal step 1) */
.ini-picker { display: flex; flex-direction: column; gap: 8px; }
.ini-picker-tools { display: flex; gap: 8px; }
.ini-picker-tools input { flex: 1; }
.ini-picker-list { max-height: 46vh; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
.ini-picker-row {
  display: grid; grid-template-columns: 22px 1.6fr 1fr 0.8fr 1fr; gap: 10px; align-items: center;
  padding: 8px 10px; border-bottom: 1px solid var(--line); cursor: pointer;
}
.ini-picker-row:last-child { border-bottom: 0; }
.ini-picker-row.on { background: rgba(var(--accent-rgb), 0.08); }
.ini-picker-empty { padding: 18px; color: var(--text-muted); text-align: center; }

/* progress (step 3) */
.report-progress { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px 0; text-align: center; }
.report-progress .spinner { width: 28px; height: 28px; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.report-progress .elapsed { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.report-progress .err { color: var(--red); white-space: pre-wrap; }
```

  (Use the existing CSS variables from `portal-theme.css`; if `--line`, `--text-muted`, `--red` are named differently there, substitute the real names — check with `grep -n "^  --" portal/src/styles/portal-theme.css | head -40`.)

- [ ] **Step 8: `pages/Reports.tsx`** (Available tab complete; History tab is a stub component replaced in Task 9)

```tsx
/**
 * /reports — two tabs: Available (report definitions; Generate / Edit /
 * Clone / Delete per row) and History (report runs; Task 9). Standard
 * directory list scaffolding, same as LabelTemplates.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  ApiError, cloneReportDefinition, deleteReportDefinition, listReportDefinitions,
  type ReportDefinition,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../lib/columnMenu';
import {
  ColumnsButton, applyColumnOrder, moveKey, useReorderDrag, useSearchHaystacks,
  visibleColumnsFor, type ColumnDef,
} from '../lib/listTools';
import { sectionCount } from '../lib/reports';
import { VirtualRows } from '../lib/virtualRows';
import { RowActionsMenu } from '../components/hardware/RowActionsMenu';
import EditDefinitionModal from '../components/reports/EditDefinitionModal';
import GenerateReportModal from '../components/reports/GenerateReportModal';
import HistoryTab from '../components/reports/HistoryTab';
import '../styles/directory.css';
import '../styles/reports.css';

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.6fr', default: true },
  { key: 'report_type', label: 'Type', width: '1fr', default: true },
  { key: 'description', label: 'Description', width: '2fr', default: true },
  { key: 'sections', label: 'Sections', width: '0.8fr', default: true },
  { key: 'updated_at', label: 'Updated', width: '1fr', default: true },
  { key: 'is_system', label: 'Kind', width: '0.7fr', default: true },
];
const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));
const TYPE_LABELS: Record<string, string> = { move_report: 'Move Report' };
const TOTAL_SECTIONS = 8;

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? err.message || `Request failed (${err.code}).` : "Couldn't complete that action.";

type Tab = 'available' | 'history';

export default function Reports() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'history' ? 'history' : 'available';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    next.delete('run');
    setParams(next, { replace: true });
  };
  const canAdd = can('reports', 'add');
  const canChange = can('reports', 'change');
  const canDelete = can('reports', 'delete');

  const [defs, setDefs] = useState<ReportDefinition[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ReportDefinition | null>(null);
  const [generating, setGenerating] = useState<ReportDefinition | null>(null);
  const [runCount, setRunCount] = useState<number | null>(null);

  const {
    visibleCols, setVisibleCols, sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters, colOrder, setColOrder,
  } = usePersistentListState(
    'reports-definitions', { visible: DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      setDefs(await listReportDefinitions());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? "You don't have access to reports." : "Couldn't load reports.");
    }
  };
  useEffect(() => { void load(); }, []);

  const cellText: CellText<ReportDefinition> = (d, key) => {
    switch (key) {
      case 'report_type': return TYPE_LABELS[d.report_type] ?? d.report_type;
      case 'description': return d.description;
      case 'sections': return `${sectionCount(d.options)} of ${TOTAL_SECTIONS}`;
      case 'updated_at': return d.updated_at;
      case 'is_system': return d.is_system ? 'System' : 'Custom';
      default: return d.name;
    }
  };
  const sortValue = (d: ReportDefinition, key: string): string | number =>
    key === 'sections' ? sectionCount(d.options) : cellText(d, key).toLowerCase();
  const haystack = useSearchHaystacks(defs, (d) =>
    `${d.name} ${d.description} ${cellText(d, 'report_type')}`.toLowerCase());

  const visible = useMemo(() => {
    if (!defs) return [];
    const q = query.trim().toLowerCase();
    return defs
      .filter((d) => passesColumnFilters(d, filters, cellText) && (!q || haystack(d).includes(q)))
      .sort((a, b) => {
        const va = sortValue(a, sortKey), vb = sortValue(b, sortKey);
        return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defs, filters, query, sortKey, sortDir, haystack]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;
  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 100px` };

  const clone = async (d: ReportDefinition) => {
    setError('');
    try { await cloneReportDefinition(d.id); await load(); } catch (err) { setError(msgFor(err)); }
  };
  const remove = async (d: ReportDefinition) => {
    if (!window.confirm(`Delete "${d.name}"? Past runs keep their PDFs.`)) return;
    setError('');
    try { await deleteReportDefinition(d.id); await load(); } catch (err) { setError(msgFor(err)); }
  };

  const cellFor = (d: ReportDefinition, key: string) => {
    switch (key) {
      case 'name': return <span className="cell-primary">{d.name}</span>;
      case 'description': return <span>{d.description || '—'}</span>;
      case 'updated_at': return <span>{new Date(d.updated_at).toLocaleDateString()}</span>;
      case 'is_system': return d.is_system ? <span className="chip c-slate">System</span> : <span className="cell-sub">—</span>;
      default: return <span>{cellText(d, key)}</span>;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Reports</div>
          <h1 className="page-title">Reports</h1>
          <p className="page-hint">Generate PDF reports and review what has been generated.</p>
        </div>
      </div>

      <div className="segmented" role="tablist">
        <button role="tab" className={tab === 'available' ? 'on' : ''} onClick={() => setTab('available')}>
          Available <span className="n">{defs?.length ?? 0}</span>
        </button>
        <button role="tab" className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
          History {runCount != null && <span className="n">{runCount}</span>}
        </button>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>{defs ? "Couldn't complete that action" : 'Cannot load reports'}</b>{error}
        </div>
      )}

      {tab === 'history' && (
        <HistoryTab highlightRunId={params.get('run')} onCount={setRunCount} />
      )}

      {tab === 'available' && defs && (
        <>
          <div className="dir-toolbar">
            <div className="toolbar-right">
              <div className="dir-search" style={{ marginLeft: 0 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <input placeholder="Filter this list…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <span className="result-count">{visible.length} of {defs.length} shown</span>
              <FilterSummaryChip filters={filters} onClear={clearFilters} />
              <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                             onReorder={setColOrder} />
            </div>
          </div>
          <div className="dir-list">
            <div className="list-head" style={grid}>
              {shownCols.map((c) => (
                <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                      {...headerDrag.dragProps(c.key)}>
                  <button className="sortable" onClick={() => toggleSort(c.key)}>{c.label} {caret(c.key)}</button>
                  <ColumnMenu colKey={c.key} label={c.label} allRows={defs} filters={filters}
                              text={cellText} filter={filters[c.key]} onFilter={setFilter}
                              sortDir={sortKey === c.key ? sortDir : null}
                              onSort={(dir) => setSort(c.key, dir)} />
                </span>
              ))}
              <span />
            </div>
            {visible.length === 0 && (
              <div className="dir-empty">
                <b>No matches</b>Try a different filter.
                <EmptyClearFilters filters={filters} onClear={clearFilters} />
              </div>
            )}
            <VirtualRows rows={visible} renderRow={(d, vp) => (
              <div key={d.id} className="dir-row" {...vp} style={vp?.style}>
                <div className="row-main" style={grid}>
                  {shownCols.map((c) => <div className="cell" key={c.key}>{cellFor(d, c.key)}</div>)}
                  <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <RowActionsMenu actions={[
                      ...(canAdd ? [{ key: 'generate', label: 'Generate', onSelect: () => setGenerating(d) }] : []),
                      ...(canChange ? [{ key: 'edit', label: 'Edit', onSelect: () => setEditing(d) }] : []),
                      ...(canAdd ? [{ key: 'clone', label: 'Clone', onSelect: () => void clone(d) }] : []),
                      ...(canDelete && !d.is_system
                        ? [{ key: 'delete', label: 'Delete', destructive: true, onSelect: () => void remove(d) }]
                        : []),
                    ]} />
                  </div>
                </div>
              </div>
            )} />
          </div>
        </>
      )}

      {editing && (
        <EditDefinitionModal definition={editing} onClose={() => setEditing(null)}
                             onSaved={() => { setEditing(null); void load(); }} />
      )}
      {generating && (
        <GenerateReportModal definition={generating} onClose={() => setGenerating(null)} />
      )}
    </div>
  );
}
```

  "Generate" and "Clone" require `reports:add` (same as the API); the "hides" test grants view+add, so it expects Generate and Clone present but not Edit/Delete — adjust its `queryByText('Clone')` assertion to `getByText('Clone')`.

  For Task 8 to compile, create two stubs that Task 9 replaces: `components/reports/GenerateReportModal.tsx` exporting `default function GenerateReportModal(_: { definition: ReportDefinition; onClose: () => void }) { return null; }` and `components/reports/HistoryTab.tsx` exporting `default function HistoryTab(_: { highlightRunId: string | null; onCount: (n: number) => void }) { return null; }`. The "tab query switches to History" test must still pass: make the stub `HistoryTab` call `listReportRuns()` once in a `useEffect` and pass `.length` to `onCount`.

- [ ] **Step 9: Run tests + typecheck**

Run: `cd portal && npx vitest run src/layout src/lib/reports.test.ts src/pages/Reports.test.tsx && npx tsc --noEmit -p .`
Expected: pass, clean.

- [ ] **Step 10: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add portal/src/lib/api.ts portal/src/lib/reports.ts portal/src/lib/reports.test.ts portal/src/layout/navSections.tsx portal/src/layout/reportsNav.test.tsx portal/src/App.tsx portal/src/components/Topbar.tsx portal/src/pages/Reports.tsx portal/src/pages/Reports.test.tsx portal/src/components/reports portal/src/styles/reports.css
git commit -m "feat(portal): Reports nav + page — Available tab with Generate/Edit/Clone/Delete"
```

---

### Task 9: Portal — Generate modal + History tab

**Files:**
- Replace: `portal/src/components/reports/GenerateReportModal.tsx`, `portal/src/components/reports/HistoryTab.tsx` (Task 8 stubs)
- Test: `portal/src/components/reports/GenerateReportModal.test.tsx` (new); append History cases to `portal/src/pages/Reports.test.tsx`

**Interfaces:**
- Consumes: Task 8 api functions + `lib/reports.ts`; `useSystemStatus()` from `lib/systemStatusContext`; `Switch` from `components/Switch`.
- Produces: `GenerateReportModal` props `{definition, onClose, onToast?: (msg: string) => void}`; `HistoryTab` props `{highlightRunId, onCount}`. Modal poll 2 s; History poll 3 s while active.

- [ ] **Step 1: Failing modal tests** — `portal/src/components/reports/GenerateReportModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InitiativeItem, ReportDefinition, ReportRun } from '../../lib/api';

const status = vi.hoisted(() => ({ workers_paused: false }));
vi.mock('../../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: { read_only: false, read_only_message: '', workers_paused: status.workers_paused, banner: null }, refresh: vi.fn() }),
}));
const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(), createReportRun: vi.fn(), getReportRun: vi.fn(),
  getReportRunDownloadUrl: vi.fn(), setReportRunNotify: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: GenerateReportModal } = await import('./GenerateReportModal');

const DEF: ReportDefinition = {
  id: 'd1', name: 'Move Report', description: '', report_type: 'move_report', is_system: true,
  updated_at: '2026-09-09T10:00:00Z',
  options: { summary: true, assets_by_source: true, assets_by_destination: true, size_weight: true,
    rail_usage: true, collisions: false, source_racks: true, destination_racks: true },
};
const ini = (id: string, name: string, status: string, type = 'move', client = 'Acme') => ({
  id, name, status, status_label: status, status_color: '#000', initiative_type: type,
  type_label: type, type_color: '#000', client_name: client, archived_at: null,
  scheduled_start: '2026-10-01T00:00:00Z', scheduled_end: null,
} as unknown as InitiativeItem);
const INIS = [ini('i1', 'Zeta', 'completed'), ini('i2', 'NAP11', 'in_progress'),
              ini('i3', 'Beta', 'planned', 'decommission')];
const run = (over: Partial<ReportRun>): ReportRun => ({
  id: 'r1', definition_id: 'd1', definition_name: 'Move Report', report_type: 'move_report',
  initiative_id: 'i2', initiative_name: 'NAP11', options: DEF.options, status: 'queued', error: null,
  requested_by: 'p1', requested_by_name: 'Alice', requested_rank: 40, notify: false, filename: null,
  size_bytes: null, started_at: null, finished_at: null, created_at: '2026-09-09T12:00:00Z', ...over,
});

beforeEach(() => {
  status.workers_paused = false;
  api.listInitiatives.mockResolvedValue(INIS);
  api.createReportRun.mockResolvedValue(run({}));
  api.getReportRun.mockResolvedValue(run({}));
  api.getReportRunDownloadUrl.mockResolvedValue('https://spaces/x.pdf');
  api.setReportRunNotify.mockResolvedValue(run({ notify: true }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

async function toStep2(user: ReturnType<typeof userEvent.setup>) {
  render(<GenerateReportModal definition={DEF} onClose={() => {}} />);
  await screen.findByText('NAP11');
  await user.click(screen.getByLabelText('NAP11'));
  await user.click(screen.getByRole('button', { name: 'Next' }));
}

it('step 1 sorts active first, filters by type and search, Next needs a pick', async () => {
  const user = userEvent.setup();
  render(<GenerateReportModal definition={DEF} onClose={() => {}} />);
  await screen.findByText('NAP11');
  expect(screen.getByRole('heading', { name: 'Generate Move Report' })).toBeTruthy();
  const names = screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'));
  expect(names).toEqual(['NAP11', 'Beta', 'Zeta']);
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  await user.selectOptions(screen.getByLabelText('Type'), 'decommission');
  expect(screen.getAllByRole('radio')).toHaveLength(1);
  await user.selectOptions(screen.getByLabelText('Type'), '');
  await user.type(screen.getByPlaceholderText('Search initiatives…'), 'nap');
  expect(screen.getAllByRole('radio')).toHaveLength(1);
});

it('step 2 shows the eight sections with definition defaults; select/deselect all; generate posts', async () => {
  const user = userEvent.setup();
  await toStep2(user);
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
  expect(boxes).toHaveLength(8);
  expect(boxes.map((b) => b.checked)).toEqual([true, true, true, true, true, false, true, true]);
  await user.click(screen.getByRole('button', { name: 'Deselect All' }));
  expect((screen.getByRole('button', { name: 'Generate Report' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Turn on at least one section')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Select All' }));
  await user.click(screen.getByLabelText(/^Collision Report/));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await waitFor(() => expect(api.createReportRun).toHaveBeenCalledWith({
    definition_id: 'd1', initiative_id: 'i2', notify: false,
    options: { ...DEF.options, collisions: false },
  }));
});

it('step 3 polls, then offers Download and the Files note', async () => {
  const user = userEvent.setup();
  api.getReportRun
    .mockResolvedValueOnce(run({ status: 'running' }))
    .mockResolvedValue(run({ status: 'completed', filename: 'Move Report - NAP11.pdf' }));
  await toStep2(user);
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await screen.findByText(/Generating/);
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  await screen.findByRole('button', { name: 'Download' }, { timeout: 6000 });
  expect(screen.getByText("Also saved to the initiative's Files")).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://spaces/x.pdf', '_blank'));
});

it('notify-me sets the flag, toasts and closes', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onToast = vi.fn();
  render(<GenerateReportModal definition={DEF} onClose={onClose} onToast={onToast} />);
  await screen.findByText('NAP11');
  await user.click(screen.getByLabelText('NAP11'));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await user.click(await screen.findByRole('button', { name: "Notify me when it's ready" }));
  await waitFor(() => expect(api.setReportRunNotify).toHaveBeenCalledWith('r1', true));
  expect(onToast).toHaveBeenCalledWith("We'll let you know when it's ready");
  expect(onClose).toHaveBeenCalled();
});

it('failure shows the error and Try again re-queues with the same options', async () => {
  const user = userEvent.setup();
  api.getReportRun.mockResolvedValue(run({ status: 'failed', error: 'rack renderer unavailable: x' }));
  await toStep2(user);
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await screen.findByText('rack renderer unavailable: x');
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(api.createReportRun).toHaveBeenCalledTimes(2));
});

it('says paused while workers are paused', async () => {
  status.workers_paused = true;
  const user = userEvent.setup();
  await toStep2(user);
  await user.click(screen.getByRole('button', { name: 'Generate Report' }));
  await screen.findByText('Paused for maintenance — will resume automatically');
});
```

- [ ] **Step 2: Failing History tests** — append to `portal/src/pages/Reports.test.tsx`:

```tsx
const RUN: ReportRun = {
  id: 'r1', definition_id: 'd1', definition_name: 'Move Report', report_type: 'move_report',
  initiative_id: 'i1', initiative_name: 'NAP11', options: DEFS[0].options, status: 'completed',
  error: null, requested_by: 'p1', requested_by_name: 'Alice Anderson', requested_rank: 40,
  notify: false, filename: 'Move Report - NAP11.pdf', size_bytes: 234567,
  started_at: '2026-09-09T12:00:01Z', finished_at: '2026-09-09T12:00:09Z',
  created_at: '2026-09-09T12:00:00Z',
};

it('History lists runs with status, duration, size and a Download action', async () => {
  const user = userEvent.setup();
  api.listReportRuns.mockResolvedValue([RUN, { ...RUN, id: 'r2', status: 'failed', error: 'boom',
    filename: null, size_bytes: null }]);
  api.getReportRunDownloadUrl.mockResolvedValue('https://spaces/r1.pdf');
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  renderPage('/reports?tab=history');
  await screen.findByText('NAP11', { selector: 'a' });
  expect(screen.getByText('Completed')).toBeTruthy();
  expect(screen.getByText('8s')).toBeTruthy();
  expect(screen.getByText('229 KB')).toBeTruthy();
  expect(screen.getByText('Failed')).toBeTruthy();
  const triggers = screen.getAllByRole('button', { name: /actions/i });
  await user.click(triggers[0]);
  await user.click(screen.getByText('Download'));
  await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://spaces/r1.pdf', '_blank'));
  await user.click(triggers[1]);
  await user.click(screen.getByText('View error'));
  expect(await screen.findByText('boom')).toBeTruthy();
});

it('History polls while a run is active and stops when idle', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.listReportRuns
    .mockResolvedValueOnce([{ ...RUN, status: 'running', finished_at: null }])
    .mockResolvedValue([RUN]);
  renderPage('/reports?tab=history');
  await waitFor(() => expect(api.listReportRuns).toHaveBeenCalledTimes(1));
  await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
  expect(api.listReportRuns).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(6500); });
  expect(api.listReportRuns).toHaveBeenCalledTimes(2);      // idle: no more polls
  vi.useRealTimers();
});
```

  (Add `act` to the `@testing-library/react` import at the top of the file.)

- [ ] **Step 3: Run to verify they fail**

Run: `cd portal && npx vitest run src/components/reports src/pages/Reports.test.tsx`
Expected: the new cases fail (stubs render nothing).

- [ ] **Step 4: `GenerateReportModal.tsx`**

```tsx
/**
 * Generate <definition> — one dialog, three states: pick an initiative,
 * choose sections, then progress (poll the run every 2 s) with
 * "Notify me when it's ready" / Close, ending in Download or Try again.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { Switch } from '../Switch';
import {
  ApiError, createReportRun, getReportRun, getReportRunDownloadUrl, listInitiatives,
  setReportRunNotify,
} from '../../lib/api';
import type { InitiativeItem, ReportDefinition, ReportRun } from '../../lib/api';
import { MOVE_REPORT_SECTIONS, sortInitiativesForPicker } from '../../lib/reports';
import { useSystemStatus } from '../../lib/systemStatusContext';

export const MODAL_POLL_MS = 2000;

type Step = 'pick' | 'sections' | 'progress';

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString() : '—');

export default function GenerateReportModal({ definition, onClose, onToast }: {
  definition: ReportDefinition;
  onClose: () => void;
  onToast?: (message: string) => void;
}) {
  const { status: sys } = useSystemStatus();
  const [step, setStep] = useState<Step>('pick');
  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [picked, setPicked] = useState<InitiativeItem | null>(null);
  const [options, setOptions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MOVE_REPORT_SECTIONS.map((s) => [s.key, !!definition.options[s.key]])));
  const [run, setRun] = useState<ReportRun | null>(null);
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState<number>(0);
  const [elapsed, setElapsed] = useState(0);
  const closedRef = useRef(false);

  useEffect(() => {
    listInitiatives().then(setInitiatives).catch(() => setError("Couldn't load initiatives."));
    return () => { closedRef.current = true; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sorted = useMemo(() => sortInitiativesForPicker(initiatives ?? []), [initiatives]);
  const types = useMemo(() => {
    const m = new Map<string, string>();
    sorted.forEach((i) => m.set(i.initiative_type, i.type_label));
    return [...m.entries()];
  }, [sorted]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sorted.filter((i) => (!type || i.initiative_type === type)
      && (!q || `${i.name} ${i.client_name ?? ''}`.toLowerCase().includes(q)));
  }, [sorted, search, type]);

  const enabledCount = MOVE_REPORT_SECTIONS.filter((s) => options[s.key]).length;
  const setAll = (v: boolean) =>
    setOptions(Object.fromEntries(MOVE_REPORT_SECTIONS.map((s) => [s.key, v])));

  const start = async () => {
    if (!picked) return;
    setError('');
    setStep('progress');
    setRun(null);
    setStartedAt(Date.now());
    try {
      setRun(await createReportRun({
        definition_id: definition.id, initiative_id: picked.id, options, notify: false,
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the report.");
    }
  };

  // poll while queued/running
  const active = run && (run.status === 'queued' || run.status === 'running');
  useEffect(() => {
    if (!active || !run) return;
    const timer = setInterval(() => {
      getReportRun(run.id).then((next) => { if (!closedRef.current) setRun(next); })
        .catch(() => undefined);                  // transient poll failure: keep polling
    }, MODAL_POLL_MS);
    return () => clearInterval(timer);
  }, [active, run]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [active, startedAt]);

  const notifyMe = async () => {
    if (!run) return;
    try {
      await setReportRunNotify(run.id, true);
      onToast?.("We'll let you know when it's ready");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't set the reminder.");
    }
  };
  const download = async () => {
    if (!run) return;
    try {
      window.open(await getReportRunDownloadUrl(run.id), '_blank');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't fetch the download link.");
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card">
        <div className="modal-head">
          <h3>Generate {definition.name}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>

        {step === 'pick' && (
          <>
            <div className="modal-body ini-picker">
              <div className="ini-picker-tools">
                <input placeholder="Search initiatives…" value={search}
                       onChange={(e) => setSearch(e.target.value)} />
                <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">All types</option>
                  {types.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </div>
              <div className="ini-picker-list" role="radiogroup">
                {initiatives === null && <div className="ini-picker-empty">Loading…</div>}
                {initiatives !== null && shown.length === 0 && (
                  <div className="ini-picker-empty">No initiatives match.</div>
                )}
                {shown.map((i) => (
                  <label key={i.id} className={`ini-picker-row ${picked?.id === i.id ? 'on' : ''}`}>
                    <input type="radio" name="initiative" aria-label={i.name}
                           checked={picked?.id === i.id} onChange={() => setPicked(i)} />
                    <span className="cell-primary">{i.name}</span>
                    <span className="cell-sub">{i.client_name ?? '—'}</span>
                    <span className="chip" style={{ background: i.status_color }}>{i.status_label}</span>
                    <span className="cell-sub">{i.type_label} · {fmtDate(i.scheduled_start)}{i.scheduled_end ? ` → ${fmtDate(i.scheduled_end)}` : ''}</span>
                  </label>
                ))}
              </div>
              {error && <div className="form-error">{error}</div>}
            </div>
            <div className="modal-foot">
              <button className="btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn-solid" disabled={!picked} onClick={() => setStep('sections')}>Next</button>
            </div>
          </>
        )}

        {step === 'sections' && (
          <>
            <div className="modal-body">
              <p className="cell-sub">Select which sections to include in the PDF report for <b>{picked?.name}</b>:</p>
              <div className="report-sections">
                {MOVE_REPORT_SECTIONS.map((s) => (
                  <label key={s.key} className="report-section-row">
                    <Switch checked={!!options[s.key]}
                            onChange={(v) => setOptions((o) => ({ ...o, [s.key]: v }))} />
                    <span className="report-section-text">
                      <span className="report-section-title">{s.title}</span>
                      <span className="report-section-desc">{s.description}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="report-section-actions">
                <button type="button" onClick={() => setAll(true)}>Select All</button>
                <button type="button" onClick={() => setAll(false)}>Deselect All</button>
              </div>
              {enabledCount === 0 && <div className="form-error">Turn on at least one section</div>}
            </div>
            <div className="modal-foot">
              <button className="btn-ghost" onClick={() => setStep('pick')}>Back</button>
              <button className="btn-solid" disabled={enabledCount === 0} onClick={() => void start()}>
                Generate Report
              </button>
            </div>
          </>
        )}

        {step === 'progress' && (
          <>
            <div className="modal-body report-progress">
              {(!run || active) && !error && (
                <>
                  <div className="spinner" />
                  <div>
                    {sys.workers_paused ? 'Paused for maintenance — will resume automatically'
                      : run?.status === 'running' ? 'Generating…' : 'Queued'}
                  </div>
                  <div className="elapsed">{elapsed}s</div>
                </>
              )}
              {run?.status === 'completed' && (
                <>
                  <div><b>{run.filename}</b></div>
                  <div className="cell-sub">Also saved to the initiative&apos;s Files</div>
                </>
              )}
              {run?.status === 'failed' && (
                <div className="err">{run.error ?? 'The report failed.'}</div>
              )}
              {error && <div className="err">{error}</div>}
            </div>
            <div className="modal-foot">
              {active && (
                <button className="btn-ghost" onClick={() => void notifyMe()}>Notify me when it&apos;s ready</button>
              )}
              {run?.status === 'failed' && (
                <button className="btn-ghost" onClick={() => void start()}>Try again</button>
              )}
              <button className="btn-ghost" onClick={onClose}>Close</button>
              {run?.status === 'completed' && (
                <button className="btn-solid" onClick={() => void download()}>Download</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

  React escapes `'` in JSX text; the tests match `"Notify me when it's ready"` and `"Also saved to the initiative's Files"` — `&apos;` renders as `'`, so the text matches.

- [ ] **Step 5: `HistoryTab.tsx`**

```tsx
/** History tab: report runs the caller may see (rank + scope gate is
 *  server-side). Polls every 3 s while any listed run is queued/running. */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError, getReportRunDownloadUrl, listReportRuns } from '../../lib/api';
import type { ReportRun } from '../../lib/api';
import { formatBytes } from '../../lib/reports';
import { RowActionsMenu } from '../hardware/RowActionsMenu';

export const HISTORY_POLL_MS = 3000;

const STATUS_LABEL: Record<ReportRun['status'], string> = {
  queued: 'Queued', running: 'Generating', completed: 'Completed', failed: 'Failed',
};
const STATUS_CHIP: Record<ReportRun['status'], string> = {
  queued: 'c-slate', running: 'c-violet', completed: 'c-green', failed: 'c-red',
};

export function duration(run: ReportRun): string {
  if (!run.started_at || !run.finished_at) return '';
  const s = Math.max(0, Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function HistoryTab({ highlightRunId, onCount }: {
  highlightRunId: string | null;
  onCount: (n: number) => void;
}) {
  const [runs, setRuns] = useState<ReportRun[] | null>(null);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<ReportRun | null>(null);

  const load = async () => {
    try {
      const rows = await listReportRuns();
      setRuns(rows);
      onCount(rows.length);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load report history.");
    }
  };
  useEffect(() => { void load(); }, []);           // eslint-disable-line react-hooks/exhaustive-deps

  const active = useMemo(() => (runs ?? []).some((r) => r.status === 'queued' || r.status === 'running'), [runs]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { void load(); }, HISTORY_POLL_MS);
    return () => clearInterval(t);
  }, [active]);                                    // eslint-disable-line react-hooks/exhaustive-deps

  const download = async (run: ReportRun) => {
    try { window.open(await getReportRunDownloadUrl(run.id), '_blank'); } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't fetch the download link.");
    }
  };

  const grid = { gridTemplateColumns: '1.4fr 1.4fr 1.2fr 1.2fr 1fr 0.8fr 100px' };
  return (
    <div className="dir-list">
      {error && <div className="dir-empty"><b>Couldn&apos;t load history</b>{error}</div>}
      <div className="list-head" style={grid}>
        <span className="col-head">Report</span><span className="col-head">Initiative</span>
        <span className="col-head">Requested by</span><span className="col-head">Requested at</span>
        <span className="col-head">Status</span><span className="col-head">Size</span><span />
      </div>
      {runs && runs.length === 0 && <div className="dir-empty">No reports generated yet.</div>}
      {(runs ?? []).map((r) => (
        <div key={r.id} className={`dir-row ${r.id === highlightRunId ? 'row-highlight' : ''}`}>
          <div className="row-main" style={grid}>
            <div className="cell"><span className="cell-primary">{r.definition_name}</span></div>
            <div className="cell"><Link to={`/initiatives/${r.initiative_id}`}>{r.initiative_name}</Link></div>
            <div className="cell">{r.requested_by_name}</div>
            <div className="cell">{new Date(r.created_at).toLocaleString()}</div>
            <div className="cell">
              <span className={`chip ${STATUS_CHIP[r.status]}`}>{STATUS_LABEL[r.status]}</span>
              {duration(r) && <span className="cell-sub" style={{ marginLeft: 6 }}>{duration(r)}</span>}
            </div>
            <div className="cell">{formatBytes(r.size_bytes)}</div>
            <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <RowActionsMenu actions={[
                ...(r.status === 'completed' ? [{ key: 'download', label: 'Download', onSelect: () => void download(r) }] : []),
                ...(r.status === 'failed' ? [{ key: 'error', label: 'View error', onSelect: () => setViewing(r) }] : []),
              ]} />
            </div>
          </div>
        </div>
      ))}
      {viewing && (
        <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
          <div className="modal-card reports-modal-card">
            <div className="modal-head"><h3>Report failed</h3>
              <button className="modal-close" aria-label="Close" onClick={() => setViewing(null)}>×</button></div>
            <div className="modal-body"><pre className="err" style={{ whiteSpace: 'pre-wrap' }}>{viewing.error}</pre></div>
          </div>
        </div>
      )}
    </div>
  );
}
```

  Add `.row-highlight { outline: 2px solid var(--accent); outline-offset: -2px; }` to `styles/reports.css`. Wire the toast in `pages/Reports.tsx`: `<GenerateReportModal … onToast={(m) => setToast(m)} />` with a local `toast` state rendered as `<div role="status" className="toast">{toast}</div>` for 4 s (Task 10 replaces this with the shared `ToastHost` — keep it minimal).

- [ ] **Step 6: Run tests + typecheck**

Run: `cd portal && npx vitest run src/components/reports src/pages/Reports.test.tsx && npx tsc --noEmit -p .`
Expected: pass, clean.

- [ ] **Step 7: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add portal/src/components/reports portal/src/pages/Reports.tsx portal/src/pages/Reports.test.tsx portal/src/styles/reports.css
git commit -m "feat(portal): Generate report modal (pick/sections/progress) + History tab"
```

---

### Task 10: Portal — notifications provider, bell, toast host

**Files:**
- Create: `portal/src/lib/notificationsContext.tsx`, `portal/src/components/ToastHost.tsx`, `portal/src/styles/toast.css`
- Modify: `portal/src/components/Topbar.tsx` (bell), `portal/src/layout/AppShell.tsx` (mount `ToastHost` after `SystemBanners`), `portal/src/App.tsx` (mount `NotificationsProvider` inside `AuthProvider`, around `BrowserRouter`), `portal/src/pages/Reports.tsx` (use `useToast()` instead of the Task 9 local toast)
- Test: `portal/src/lib/notificationsContext.test.tsx`, `portal/src/components/ToastHost.test.tsx` (new); extend `portal/src/components/Topbar.test.tsx`

**Interfaces:**
- Produces: `NotificationsProvider`, `useNotifications(): {unreadCount, items, refresh, markRead(id), markAllRead(), newItems: InboxItem[], dismissNew(id)}`, `useToast(): (message: string) => void` (local ephemeral toasts), `INBOX_POLL_MS = 30_000`. `ToastHost` renders inbox-driven toasts (`report_ready` → Download action; other kinds → Open) and local message toasts.

- [ ] **Step 1: Failing tests**

`portal/src/lib/notificationsContext.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Inbox } from './api';

const api = vi.hoisted(() => ({ listInbox: vi.fn(), markInboxRead: vi.fn(), markAllInboxRead: vi.fn() }));
vi.mock('./api', async (importActual) => ({ ...(await importActual<typeof import('./api')>()), ...api }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p1' } }) }));

const { NotificationsProvider, useNotifications, INBOX_POLL_MS } = await import('./notificationsContext');

const inbox = (items: Inbox['items']): Inbox =>
  ({ unread_count: items.filter((i) => !i.read_at).length, items });
const item = (id: string, read = false) => ({
  id, kind: 'report_ready', title: `T${id}`, body: '', link: '/reports', payload: {},
  created_at: '2026-09-09T12:00:00Z', read_at: read ? '2026-09-09T12:01:00Z' : null,
});

function Probe() {
  const n = useNotifications();
  return <div>unread:{n.unreadCount} new:{n.newItems.map((i) => i.id).join(',')}
    <button onClick={() => void n.markRead('a')}>read-a</button></div>;
}

beforeEach(() => { api.listInbox.mockResolvedValue(inbox([item('a')])); api.markInboxRead.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

it('polls on mount, exposes the unread count, and flags only items that appear AFTER the first poll as new', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:1 new:');                       // first poll: nothing "new"
  api.listInbox.mockResolvedValue(inbox([item('b'), item('a')]));
  await act(async () => { await vi.advanceTimersByTimeAsync(INBOX_POLL_MS + 50); });
  await screen.findByText('unread:2 new:b');
});

it('markRead calls the API and drops the count', async () => {
  render(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:1 new:');
  api.listInbox.mockResolvedValue(inbox([item('a', true)]));
  await act(async () => { screen.getByText('read-a').click(); });
  await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith('a'));
  await screen.findByText('unread:0 new:');
});
```

`portal/src/components/ToastHost.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  newItems: [] as { id: string; kind: string; title: string; body: string; link: string | null; payload: Record<string, unknown> }[],
  dismissNew: vi.fn(), markRead: vi.fn(() => Promise.resolve()), local: [] as { id: number; message: string }[],
  dismissLocal: vi.fn(),
}));
vi.mock('../lib/notificationsContext', () => ({
  useNotifications: () => ctx,
  useLocalToasts: () => ({ toasts: ctx.local, dismiss: ctx.dismissLocal }),
}));
const api = vi.hoisted(() => ({ getReportRunDownloadUrl: vi.fn() }));
vi.mock('../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../lib/api')>()), ...api }));

const { default: ToastHost } = await import('./ToastHost');
afterEach(() => { cleanup(); vi.clearAllMocks(); ctx.newItems = []; ctx.local = []; });

it('shows a Download toast for report_ready and marks it read on click', async () => {
  const user = userEvent.setup();
  api.getReportRunDownloadUrl.mockResolvedValue('https://spaces/r1.pdf');
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  ctx.newItems = [{ id: 'n1', kind: 'report_ready', title: 'Move Report is ready', body: 'NAP11',
    link: '/reports?tab=history&run=r1', payload: { run_id: 'r1' } }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.getByRole('status').textContent).toContain('Move Report is ready');
  await user.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://spaces/r1.pdf', '_blank'));
  expect(ctx.markRead).toHaveBeenCalledWith('n1');
  expect(ctx.dismissNew).toHaveBeenCalledWith('n1');
});

it('other kinds get an Open action; dismiss removes without marking read', async () => {
  const user = userEvent.setup();
  ctx.newItems = [{ id: 'n2', kind: 'report_failed', title: 'Move Report failed', body: 'x', link: '/reports', payload: {} }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(ctx.dismissNew).toHaveBeenCalledWith('n2');
  expect(ctx.markRead).not.toHaveBeenCalled();
});

it('renders local message toasts', () => {
  ctx.local = [{ id: 1, message: "We'll let you know when it's ready" }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.getByText("We'll let you know when it's ready")).toBeTruthy();
});
```

Append to `portal/src/components/Topbar.test.tsx` (extend the existing `vi.mock('../lib/api', …)` to also stub `listInbox: vi.fn(() => Promise.resolve({ unread_count: 0, items: [] }))` and add a `vi.mock('../lib/notificationsContext', () => ({ useNotifications: () => bell }))` with a hoisted `bell` object):

```tsx
it('bell shows the unread badge and lists items; clicking one marks it read', async () => {
  bell.unreadCount = 2;
  bell.items = [{ id: 'n1', kind: 'report_ready', title: 'Move Report is ready', body: 'NAP11',
    link: '/reports?tab=history&run=r1', payload: { run_id: 'r1' }, created_at: '2026-09-09T12:00:00Z', read_at: null }];
  const user = userEvent.setup();
  renderTopbar();
  expect(screen.getByText('2')).toBeTruthy();                       // badge
  await user.click(screen.getByTitle('Notifications'));
  await user.click(screen.getByText('Move Report is ready'));
  expect(bell.markRead).toHaveBeenCalledWith('n1');
  await user.click(screen.getByTitle('Notifications'));
  await user.click(screen.getByText('Mark all read'));
  expect(bell.markAllRead).toHaveBeenCalled();
});
```

  where `const bell = vi.hoisted(() => ({ unreadCount: 0, items: [] as unknown[], markRead: vi.fn(), markAllRead: vi.fn(), refresh: vi.fn(), newItems: [], dismissNew: vi.fn() }));`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd portal && npx vitest run src/lib/notificationsContext.test.tsx src/components/ToastHost.test.tsx src/components/Topbar.test.tsx`
Expected: module-not-found / assertion failures.

- [ ] **Step 3: `lib/notificationsContext.tsx`**

```tsx
/**
 * In-app inbox provider: polls /notifications/inbox every 30 s and on tab
 * focus. Items that appear after the first successful poll are "new" —
 * ToastHost shows those. Also hosts short-lived local message toasts
 * (useToast) so pages don't each grow their own.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';

import { useAuth } from '../auth/AuthContext';
import { listInbox, markAllInboxRead, markInboxRead } from './api';
import type { InboxItem } from './api';

export const INBOX_POLL_MS = 30_000;
export const LOCAL_TOAST_MS = 4_000;

interface LocalToast { id: number; message: string }

interface Value {
  unreadCount: number;
  items: InboxItem[];
  newItems: InboxItem[];
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismissNew: (id: string) => void;
  toast: (message: string) => void;
  localToasts: LocalToast[];
  dismissLocal: (id: number) => void;
}

const Ctx = createContext<Value | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { person } = useAuth();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [newItems, setNewItems] = useState<InboxItem[]>([]);
  const [localToasts, setLocalToasts] = useState<LocalToast[]>([]);
  const seen = useRef<Set<string> | null>(null);          // null until the first poll lands
  const nextLocalId = useRef(1);

  const refresh = useCallback(async () => {
    if (!person) return;
    try {
      const inbox = await listInbox();
      setItems(inbox.items);
      setUnreadCount(inbox.unread_count);
      if (seen.current === null) {
        seen.current = new Set(inbox.items.map((i) => i.id));
      } else {
        const fresh = inbox.items.filter((i) => !i.read_at && !seen.current!.has(i.id));
        inbox.items.forEach((i) => seen.current!.add(i.id));
        if (fresh.length) setNewItems((cur) => [...fresh, ...cur].slice(0, 3));
      }
    } catch {
      /* transient: keep the last value */
    }
  }, [person]);

  useEffect(() => {
    if (!person) return;
    void refresh();
    const t = setInterval(() => { void refresh(); }, INBOX_POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [person, refresh]);

  const markRead = useCallback(async (id: string) => {
    await markInboxRead(id).catch(() => undefined);
    setNewItems((cur) => cur.filter((i) => i.id !== id));
    await refresh();
  }, [refresh]);
  const markAllRead = useCallback(async () => {
    await markAllInboxRead().catch(() => undefined);
    setNewItems([]);
    await refresh();
  }, [refresh]);
  const dismissNew = useCallback((id: string) => setNewItems((cur) => cur.filter((i) => i.id !== id)), []);
  const dismissLocal = useCallback((id: number) => setLocalToasts((cur) => cur.filter((t) => t.id !== id)), []);
  const toast = useCallback((message: string) => {
    const id = nextLocalId.current++;
    setLocalToasts((cur) => [...cur, { id, message }]);
    setTimeout(() => dismissLocal(id), LOCAL_TOAST_MS);
  }, [dismissLocal]);

  const value = useMemo<Value>(() => ({
    unreadCount, items, newItems, refresh, markRead, markAllRead, dismissNew, toast, localToasts, dismissLocal,
  }), [unreadCount, items, newItems, refresh, markRead, markAllRead, dismissNew, toast, localToasts, dismissLocal]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const EMPTY: Value = {
  unreadCount: 0, items: [], newItems: [], refresh: async () => {}, markRead: async () => {},
  markAllRead: async () => {}, dismissNew: () => {}, toast: () => {}, localToasts: [], dismissLocal: () => {},
};

export function useNotifications(): Value {
  return useContext(Ctx) ?? EMPTY;
}

export function useToast(): (message: string) => void {
  return useNotifications().toast;
}

export function useLocalToasts(): { toasts: LocalToast[]; dismiss: (id: number) => void } {
  const n = useNotifications();
  return { toasts: n.localToasts, dismiss: n.dismissLocal };
}
```

- [ ] **Step 4: `components/ToastHost.tsx` + `styles/toast.css`**

```tsx
/** Stacked toasts (max 3) for new inbox items + local messages. Generic:
 *  the only kind-specific bit is the action mapping below. */
import { useNavigate } from 'react-router-dom';

import { getReportRunDownloadUrl } from '../lib/api';
import { useLocalToasts, useNotifications } from '../lib/notificationsContext';
import '../styles/toast.css';

export default function ToastHost() {
  const { newItems, dismissNew, markRead } = useNotifications();
  const { toasts, dismiss } = useLocalToasts();
  const navigate = useNavigate();

  const act = async (item: (typeof newItems)[number]) => {
    if (item.kind === 'report_ready' && typeof item.payload.run_id === 'string') {
      try { window.open(await getReportRunDownloadUrl(item.payload.run_id), '_blank'); } catch { /* keep toast */ }
    } else if (item.link) {
      navigate(item.link);
    }
    void markRead(item.id);
    dismissNew(item.id);
  };

  return (
    <div className="toast-host" aria-live="polite">
      {newItems.slice(0, 3).map((item) => (
        <div key={item.id} className="toast" role="status">
          <div className="toast-text">
            <div className="toast-title">{item.title}</div>
            {item.body && <div className="toast-body">{item.body}</div>}
          </div>
          <button className="btn-solid toast-action" onClick={() => void act(item)}>
            {item.kind === 'report_ready' ? 'Download' : 'Open'}
          </button>
          <button className="toast-dismiss" aria-label="Dismiss" onClick={() => dismissNew(item.id)}>×</button>
        </div>
      ))}
      {toasts.map((t) => (
        <div key={t.id} className="toast toast-local" role="status">
          <div className="toast-text">{t.message}</div>
          <button className="toast-dismiss" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
```

```css
.toast-host { position: fixed; right: 18px; bottom: 18px; display: flex; flex-direction: column; gap: 10px; z-index: 60; max-width: 380px; }
.toast { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 10px;
         background: var(--panel); border: 1px solid var(--line); box-shadow: 0 8px 24px rgba(0,0,0,.18); }
.toast-text { flex: 1; min-width: 0; }
.toast-title { font-weight: 600; }
.toast-body { font-size: 12px; color: var(--text-muted); }
.toast-dismiss { background: none; border: 0; font-size: 18px; line-height: 1; cursor: pointer; color: var(--text-muted); }
.bell-badge { position: absolute; top: 2px; right: 2px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
              background: var(--red); color: #fff; font-size: 10px; font-weight: 700; display: grid; place-items: center; }
.pop-menu .notif-item { display: block; width: 100%; text-align: left; padding: 8px 10px; background: none; border: 0; cursor: pointer; }
.pop-menu .notif-item.unread { font-weight: 600; }
.pop-menu .notif-body { display: block; font-size: 12px; color: var(--text-muted); font-weight: 400; }
.pop-menu .notif-foot { display: flex; justify-content: flex-end; padding: 6px 10px; }
```

- [ ] **Step 5: Bell in `Topbar.tsx`** — replace the `pop-wrap` block for notifications:

```tsx
        <div className="pop-wrap" style={{ position: 'relative' }}>
          <button className="icon-btn" title="Notifications"
                  onClick={() => setPop(pop === 'notif' ? null : 'notif')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" />
            </svg>
            {unreadCount > 0 && <span className="bell-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>
          {pop === 'notif' && (
            <div className="pop-menu">
              <div className="pop-title">Notifications</div>
              {items.length === 0 && <div className="pop-empty">You&apos;re all caught up.</div>}
              {items.slice(0, 10).map((n) => (
                <button key={n.id} className={`notif-item ${n.read_at ? '' : 'unread'}`}
                        onClick={() => { void markRead(n.id); setPop(null); if (n.link) navigate(n.link); }}>
                  {n.title}
                  <span className="notif-body">{n.body}{n.body ? ' · ' : ''}{relativeTime(n.created_at)}</span>
                </button>
              ))}
              {items.length > 0 && (
                <div className="notif-foot">
                  <button className="btn-ghost" onClick={() => void markAllRead()}>Mark all read</button>
                </div>
              )}
            </div>
          )}
        </div>
```

  with `const { unreadCount, items, markRead, markAllRead } = useNotifications();` near the other hooks, `import { useNotifications } from '../lib/notificationsContext';`, `import '../styles/toast.css';`, and a module-level helper:

```tsx
function relativeTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
```

- [ ] **Step 6: Mount** — `App.tsx`: wrap `<BrowserRouter>` in `<NotificationsProvider>` (inside `AuthProvider`, so the login page never polls). `AppShell.tsx`: render `<ToastHost />` right after `<SystemBanners />`. `pages/Reports.tsx`: replace the Task 9 local toast with `const toast = useToast();` and `onToast={toast}`; remove the local `toast` state/markup.

- [ ] **Step 7: Run tests + typecheck + full portal suite**

Run: `cd portal && npx vitest run && npx tsc --noEmit -p . && npm run build`
Expected: all pass, clean build (the build also emits `dist-node/render-rack.js`).

- [ ] **Step 8: Commit**

```bash
git checkout -- api/src/serversherpa/_dev_reload.py
git add portal/src/lib/notificationsContext.tsx portal/src/lib/notificationsContext.test.tsx portal/src/components/ToastHost.tsx portal/src/components/ToastHost.test.tsx portal/src/styles/toast.css portal/src/components/Topbar.tsx portal/src/components/Topbar.test.tsx portal/src/layout/AppShell.tsx portal/src/App.tsx portal/src/pages/Reports.tsx
git commit -m "feat(portal): in-app notifications — provider, bell inbox, toast host"
```

---

### Task 11: Full suites + live verification

**Files:** none new (fixes only if something is found).

- [ ] **Step 1: Full suites, foreground**

Run: `cd api && .venv/bin/python -m pytest -q` (timeout 600000ms) and `cd portal && npx vitest run && npm run build`.
Expected: all green. Known pre-existing flake: `pages/ClientDashboard.test.tsx` occasionally fails in full-suite runs and passes on re-run; anything else failing is yours.

- [ ] **Step 2: Dev stack**

`./dev-up.sh` (or `api/.venv/bin/honcho start -f Procfile.dev`) — confirm `reportsvc` starts and `/system/processes` (Admin → Processes) lists `report-worker` as Running.

- [ ] **Step 3: Live loop** (browser pane, dev login from the dev-workflow notes):

1. Nav shows **Reports** after Labels; `/reports` opens on Available with the seeded Move Report row (System badge, `8 of 8`).
2. Row actions → Generate → pick a seeded move initiative that has racked assets (NAP11 demo) → all sections on → Generate Report. Modal shows Queued → Generating… → Download within seconds. Click Download: the PDF opens; check the cover, both asset lists, size/weight, rails, collisions, and a rack elevation page whose SVG matches the portal's rack modal.
3. Initiative → Notes & Files shows the PDF as a document uploaded by you.
4. History tab lists the run (Completed, duration, size); Download works from the row menu.
5. Generate again → click **Notify me when it's ready** → toast `We'll let you know when it's ready`; within ~30 s a toast `Move Report is ready` with Download appears, the bell badge shows 1, the bell lists it, clicking marks it read.
6. Settings → Administration → read-only + pause workers → Generate → modal reads `Paused for maintenance — will resume automatically`; Processes shows report-worker Paused; lift → run completes.
7. Clone the definition, edit the copy (name + toggle sections), Delete it; confirm System row has no Delete.
8. Log in as a staff user; History must not list runs the admin generated.

- [ ] **Step 4: Record**

Append the outcome (suite counts, live checks) to `.superpowers/sdd/progress.md` and leave the dev state clean (no read-only, workers resumed).
