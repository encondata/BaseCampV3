# Notifications Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bell's placeholder list with a real notifications panel (Settings-aware typography/density, kind icons, per-item mark read/unread + hide, header mark-all-read + clear-read) backed by a soft `dismissed_at` — per `docs/superpowers/specs/2026-09-10-notifications-panel-design.md`.

**Architecture:** One nullable column + three small endpoints on the existing notifications router; provider gains three optimistic actions; a new `NotificationsPanel` component replaces the inline markup in `Topbar.tsx`; styles in `styles/toast.css` use the directory list tokens (`--list-fs-*`, `--list-row-*`) so Settings apply.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic; React + vitest (jsdom).

## Global Constraints

- Branch `reports`, on top of the current HEAD (do not rebase). Migration revision `0048`, revises `0047`.
- Endpoints (verbatim): `POST /notifications/inbox/{id}/unread` → 204; `DELETE /notifications/inbox/{id}` → 204 (soft: `dismissed_at`); `POST /notifications/inbox/clear-read` → 204. Own rows only, 404 `notification_not_found` otherwise. `GET /notifications/inbox` excludes dismissed rows from `items` and `unread_count`.
- Copy (verbatim): header `Notifications`; chip `{n} unread`; header buttons `Mark all read`, `Clear read`; row action labels `Mark read`, `Mark unread`, `Hide`; empty `You're all caught up.`; footer `Showing the 50 most recent`.
- Panel sizing: width `min(420px, calc(100vw - 32px))`; max-height `min(70vh, 560px)`, list scrolls inside.
- Typography/density: font sizes ONLY via `--list-fs-primary` / `--list-fs-sub` / `--list-fs-head`; row `min-height: var(--list-row-min-h)` and `padding: var(--list-row-pad-y) 12px` (tokens defined in `portal/src/styles/directory.css` lines 15–45; `Topbar` already lives inside `.portal-shell`, which carries `data-list-size`/`data-density`).
- Reuse: `.pop-menu`/`.pop-title`/`.pop-empty` (chrome.css), `.btn-ghost`, `.icon-btn` (chrome.css), accent tokens `--accent`/`--accent-rgb`, text tokens `--text-dark`/`--text-mute`, `--paper-line`. No raw native controls, no new colour literals.
- API tests from `api/`: `.venv/bin/python -m pytest -q tests/test_notifications_inbox.py` — FOREGROUND, timeout 600000ms. Portal from `portal/`: `npx vitest run src/lib/notificationsContext.test.tsx src/components/NotificationsPanel.test.tsx src/components/Topbar.test.tsx && npx tsc --noEmit -p .`. TDD.
- Before committing: `git checkout -- api/src/serversherpa/_dev_reload.py .claude/launch.json`. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: API — `dismissed_at`, unread / hide / clear-read endpoints

**Files:**
- Create: `api/migrations/versions/0048_notifications_dismissed.py`
- Modify: `api/src/serversherpa/db/models.py` (`Notification`: add `dismissed_at: Mapped[datetime | None]` after `read_at`)
- Modify: `api/src/serversherpa/api/routes/notifications.py` (inbox section)
- Test: `api/tests/test_notifications_inbox.py` (append)

**Interfaces:** Produces the three endpoints above; `GET /notifications/inbox` filters `Notification.dismissed_at.is_(None)` in both the count and the list. Task 2 consumes them via `lib/api.ts`.

- [ ] **Step 1: Failing tests** — append to `api/tests/test_notifications_inbox.py`:

```python
async def test_mark_unread_restores_the_row(client, db, seeded_user):
    hdrs = await login(client)
    a = await notify(db, seeded_user.id, "report_ready", "A")
    await db.commit()
    await client.post(f"/notifications/inbox/{a.id}/read", headers=hdrs)
    assert (await client.get("/notifications/inbox", headers=hdrs)).json()["unread_count"] == 0
    resp = await client.post(f"/notifications/inbox/{a.id}/unread", headers=hdrs)
    assert resp.status_code == 204
    body = (await client.get("/notifications/inbox", headers=hdrs)).json()
    assert body["unread_count"] == 1 and body["items"][0]["read_at"] is None


async def test_hide_is_soft_and_excluded_from_list_and_count(client, db, seeded_user):
    hdrs = await login(client)
    a = await notify(db, seeded_user.id, "report_ready", "A")
    b = await notify(db, seeded_user.id, "report_ready", "B")
    await db.commit()
    resp = await client.delete(f"/notifications/inbox/{a.id}", headers=hdrs)
    assert resp.status_code == 204
    assert (await client.delete(f"/notifications/inbox/{a.id}", headers=hdrs)).status_code == 204  # idempotent
    body = (await client.get("/notifications/inbox", headers=hdrs)).json()
    assert [i["id"] for i in body["items"]] == [str(b.id)]
    assert body["unread_count"] == 1
    await db.refresh(a)
    assert a.dismissed_at is not None                      # row kept
    assert (await client.post(f"/notifications/inbox/{a.id}/unread", headers=hdrs)).status_code == 404
    assert (await client.post(f"/notifications/inbox/{a.id}/read", headers=hdrs)).status_code == 404


async def test_hide_and_unread_are_own_rows_only(client, db, seeded_user):
    other = await _make(db, client, "staff", "bob@test.example.com")
    a = await notify(db, seeded_user.id, "report_ready", "A")
    await db.commit()
    assert (await client.delete(f"/notifications/inbox/{a.id}", headers=other)).status_code == 404
    assert (await client.post(f"/notifications/inbox/{a.id}/unread", headers=other)).status_code == 404
    assert (await client.delete(f"/notifications/inbox/{uuid4()}", headers=other)).status_code == 404


async def test_clear_read_hides_only_read_rows(client, db, seeded_user):
    hdrs = await login(client)
    a = await notify(db, seeded_user.id, "report_ready", "A")
    await notify(db, seeded_user.id, "report_ready", "B")
    await db.commit()
    await client.post(f"/notifications/inbox/{a.id}/read", headers=hdrs)
    assert (await client.post("/notifications/inbox/clear-read", headers=hdrs)).status_code == 204
    body = (await client.get("/notifications/inbox", headers=hdrs)).json()
    assert [i["title"] for i in body["items"]] == ["B"] and body["unread_count"] == 1
    assert (await client.post("/notifications/inbox/clear-read", headers=hdrs)).status_code == 204  # nothing left: fine
```

- [ ] **Step 2: Run to verify they fail** — `cd api && .venv/bin/python -m pytest -q tests/test_notifications_inbox.py` → 404/405 failures.

- [ ] **Step 3: Migration** — `api/migrations/versions/0048_notifications_dismissed.py`:

```python
"""notifications.dismissed_at — soft "Hide" from the bell (rows are kept;
retention policy TBD).

Revision ID: 0048
Revises: 0047
Create Date: 2026-09-10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0048"
down_revision: str | None = "0047"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("notifications", sa.Column("dismissed_at", sa.DateTime(timezone=True)))
    op.create_index("notifications_person_live_idx", "notifications",
                    ["person_id", "created_at"], postgresql_where=sa.text("dismissed_at IS NULL"))


def downgrade() -> None:
    op.drop_index("notifications_person_live_idx", table_name="notifications")
    op.drop_column("notifications", "dismissed_at")
```

  Model: add `dismissed_at: Mapped[datetime | None]` to `Notification` after `read_at`.

- [ ] **Step 4: Routes** — in `api/src/serversherpa/api/routes/notifications.py`, replace the inbox section:

```python
def _own_live(user: CurrentUser, notification_id: uuid.UUID):
    return select(Notification).where(
        Notification.id == notification_id,
        Notification.person_id == user.person.id,
        Notification.dismissed_at.is_(None))


@router.get("/inbox", response_model=NotificationInboxOut)
async def inbox(user: CurrentUser, db: DbSession,
                unread_only: bool = False) -> NotificationInboxOut:
    live = (Notification.person_id == user.person.id, Notification.dismissed_at.is_(None))
    unread = await db.scalar(select(func.count()).select_from(Notification)
                             .where(*live, Notification.read_at.is_(None)))
    q = select(Notification).where(*live).order_by(Notification.created_at.desc()).limit(INBOX_LIMIT)
    if unread_only:
        q = q.where(Notification.read_at.is_(None))
    items = (await db.scalars(q)).all()
    return NotificationInboxOut(unread_count=int(unread or 0), items=items)


@router.post("/inbox/{notification_id}/read", status_code=204)
async def inbox_mark_read(notification_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    row = await db.scalar(_own_live(user, notification_id))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "notification_not_found"})
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
        await db.commit()
    return Response(status_code=204)


@router.post("/inbox/{notification_id}/unread", status_code=204)
async def inbox_mark_unread(notification_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    row = await db.scalar(_own_live(user, notification_id))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "notification_not_found"})
    if row.read_at is not None:
        row.read_at = None
        await db.commit()
    return Response(status_code=204)


@router.delete("/inbox/{notification_id}", status_code=204)
async def inbox_hide(notification_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    """Soft dismiss: the row is kept (retention policy TBD), just hidden."""
    row = await db.scalar(select(Notification).where(
        Notification.id == notification_id, Notification.person_id == user.person.id))
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "notification_not_found"})
    if row.dismissed_at is None:
        row.dismissed_at = datetime.now(UTC)
        await db.commit()
    return Response(status_code=204)


@router.post("/inbox/read-all", status_code=204)
async def inbox_mark_all_read(user: CurrentUser, db: DbSession) -> Response:
    rows = (await db.scalars(select(Notification).where(
        Notification.person_id == user.person.id, Notification.dismissed_at.is_(None),
        Notification.read_at.is_(None)))).all()
    now = datetime.now(UTC)
    for row in rows:
        row.read_at = now
    await db.commit()
    return Response(status_code=204)


@router.post("/inbox/clear-read", status_code=204)
async def inbox_clear_read(user: CurrentUser, db: DbSession) -> Response:
    rows = (await db.scalars(select(Notification).where(
        Notification.person_id == user.person.id, Notification.dismissed_at.is_(None),
        Notification.read_at.is_not(None)))).all()
    now = datetime.now(UTC)
    for row in rows:
        row.dismissed_at = now
    await db.commit()
    return Response(status_code=204)
```

  Route order matters: FastAPI matches `/inbox/read-all` and `/inbox/clear-read` before `/inbox/{notification_id}/...` only because the literal paths have no trailing segment; keep the literal routes defined and they cannot collide with `{id}/read`. `DELETE /inbox/{id}` has no literal sibling.

- [ ] **Step 5: Migrate + run** — `cd api && .venv/bin/alembic upgrade head && .venv/bin/python -m pytest -q tests/test_notifications_inbox.py tests/test_report_worker.py` → all pass.

- [ ] **Step 6: Commit** — `feat(notifications): soft-hide (dismissed_at), mark-unread, clear-read inbox endpoints`.

---

### Task 2: Portal — provider actions, `NotificationsPanel`, Topbar wiring

**Files:**
- Modify: `portal/src/lib/api.ts` (inbox section: `markInboxUnread(id)`, `hideInboxItem(id)`, `clearReadInbox()`)
- Modify: `portal/src/lib/notificationsContext.tsx` (`markUnread`, `hide`, `clearRead`; `EMPTY` extended)
- Create: `portal/src/components/NotificationsPanel.tsx`, `portal/src/components/NotificationsPanel.test.tsx`
- Modify: `portal/src/components/Topbar.tsx` (replace the inline list with `<NotificationsPanel onClose={() => setPop(null)} />`; move `relativeTime` into the panel file and export it)
- Modify: `portal/src/styles/toast.css` (replace the `.pop-menu .notif-*` rules with the panel styles)
- Test: `portal/src/lib/notificationsContext.test.tsx`, `portal/src/components/Topbar.test.tsx` (adjust)

**Interfaces:** Consumes Task 1 endpoints. Provider adds `markUnread(id): Promise<void>`, `hide(id): Promise<void>`, `clearRead(): Promise<void>`. `NotificationsPanel` props `{ onClose: () => void }`; it reads `useNotifications()` and uses `useNavigate()`.

- [ ] **Step 1: Failing tests**

`portal/src/components/NotificationsPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InboxItem } from '../lib/api';

const ctx = vi.hoisted(() => ({
  unreadCount: 0, items: [] as InboxItem[], newItems: [] as InboxItem[],
  refresh: vi.fn(), markRead: vi.fn(() => Promise.resolve()), markUnread: vi.fn(() => Promise.resolve()),
  markAllRead: vi.fn(() => Promise.resolve()), hide: vi.fn(() => Promise.resolve()),
  clearRead: vi.fn(() => Promise.resolve()), dismissNew: vi.fn(), toast: vi.fn(),
  localToasts: [], dismissLocal: vi.fn(),
}));
vi.mock('../lib/notificationsContext', () => ({ useNotifications: () => ctx }));

const { default: NotificationsPanel } = await import('./NotificationsPanel');

const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id, kind: 'report_ready', title: `Report ${id}`, body: 'NAP11', link: `/reports?tab=history&run=${id}`,
  payload: { run_id: id }, created_at: new Date(Date.now() - 90_000).toISOString(), read_at: null, ...over,
});

function renderPanel(onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="*" element={<NotificationsPanel onClose={onClose} />} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => { ctx.items = []; ctx.unreadCount = 0; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('renders rows with kind icon, unread dot, body and relative time; header shows the unread chip', () => {
  ctx.items = [item('a'), item('b', { kind: 'report_failed', read_at: new Date().toISOString(), title: 'Move Report failed' })];
  ctx.unreadCount = 1;
  renderPanel();
  expect(screen.getByText('Notifications')).toBeTruthy();
  expect(screen.getByText('1 unread')).toBeTruthy();
  const rows = screen.getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0].className).toContain('unread');
  expect(rows[1].className).not.toContain('unread');
  expect(rows[0].querySelector('.notif-dot')).toBeTruthy();
  expect(rows[1].querySelector('.notif-dot')).toBeNull();
  expect(rows[0].querySelector('.notif-icon-report_ready')).toBeTruthy();
  expect(rows[1].querySelector('.notif-icon-report_failed')).toBeTruthy();
  expect(screen.getByText('1m ago')).toBeTruthy();
});

it('row click marks read, closes, and navigates; action buttons do not navigate', async () => {
  const user = userEvent.setup();
  ctx.items = [item('a'), item('b', { read_at: new Date().toISOString() })];
  ctx.unreadCount = 1;
  const onClose = renderPanel();
  await user.click(screen.getByText('Report a'));
  expect(ctx.markRead).toHaveBeenCalledWith('a');
  expect(onClose).toHaveBeenCalled();
  await user.click(screen.getAllByRole('button', { name: 'Mark read' })[0]);
  expect(ctx.markRead).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole('button', { name: 'Mark unread' }));
  expect(ctx.markUnread).toHaveBeenCalledWith('b');
  await user.click(screen.getAllByRole('button', { name: 'Hide' })[1]);
  expect(ctx.hide).toHaveBeenCalledWith('b');
  expect(onClose).toHaveBeenCalledTimes(1);           // actions never close/navigate
});

it('header actions: Mark all read disabled at 0 unread; Clear read disabled with no read rows', async () => {
  const user = userEvent.setup();
  ctx.items = [item('a')];
  ctx.unreadCount = 1;
  renderPanel();
  expect((screen.getByRole('button', { name: 'Clear read' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Mark all read' }));
  expect(ctx.markAllRead).toHaveBeenCalled();
  cleanup();
  ctx.items = [item('a', { read_at: new Date().toISOString() })];
  ctx.unreadCount = 0;
  renderPanel();
  expect((screen.getByRole('button', { name: 'Mark all read' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Clear read' }));
  expect(ctx.clearRead).toHaveBeenCalled();
});

it('empty state, cap footer, and keyboard: Escape closes, arrows move focus, Enter opens', async () => {
  const user = userEvent.setup();
  const onClose = renderPanel();
  expect(screen.getByText("You're all caught up.")).toBeTruthy();
  cleanup();
  ctx.items = Array.from({ length: 50 }, (_, i) => item(`n${i}`));
  ctx.unreadCount = 50;
  const onClose2 = renderPanel();
  expect(screen.getByText('Showing the 50 most recent')).toBeTruthy();
  const rows = screen.getAllByRole('listitem');
  rows[0].focus();
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(rows[1]);
  await user.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(rows[0]);
  await user.keyboard('{Enter}');
  expect(ctx.markRead).toHaveBeenCalledWith('n0');
  await user.keyboard('{Escape}');
  expect(onClose2).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
```

Provider tests — append to `portal/src/lib/notificationsContext.test.tsx` (extend the hoisted `api` with `markInboxUnread`, `hideInboxItem`, `clearReadInbox` mocks resolving `undefined`; extend `Probe` with buttons `unread-a`, `hide-a`, `clear`):

```tsx
it('markUnread, hide and clearRead call the API optimistically and refresh', async () => {
  api.listInbox.mockResolvedValue(inbox([item('a', true), item('b')]));
  render(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:1 new:');
  await act(async () => { screen.getByText('unread-a').click(); });
  await waitFor(() => expect(api.markInboxUnread).toHaveBeenCalledWith('a'));
  await act(async () => { screen.getByText('hide-a').click(); });
  await waitFor(() => expect(api.hideInboxItem).toHaveBeenCalledWith('a'));
  await act(async () => { screen.getByText('clear').click(); });
  await waitFor(() => expect(api.clearReadInbox).toHaveBeenCalled());
  expect(api.listInbox.mock.calls.length).toBeGreaterThanOrEqual(4);   // refresh after each
});
```

Topbar test: the existing bell test keeps working if the panel is the real component; add `markUnread: vi.fn(), hide: vi.fn(), clearRead: vi.fn()` to the hoisted `bell` mock and change the "lists items" assertion to `screen.getByRole('listitem')`.

- [ ] **Step 2: Run to verify failures** — `cd portal && npx vitest run src/components/NotificationsPanel.test.tsx src/lib/notificationsContext.test.tsx src/components/Topbar.test.tsx`.

- [ ] **Step 3: `lib/api.ts`** — append to the inbox section:

```ts
export async function markInboxUnread(id: string): Promise<void> {
  const resp = await apiFetch(`/notifications/inbox/${id}/unread`, { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}
export async function hideInboxItem(id: string): Promise<void> {
  const resp = await apiFetch(`/notifications/inbox/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw await errorFrom(resp);
}
export async function clearReadInbox(): Promise<void> {
  const resp = await apiFetch('/notifications/inbox/clear-read', { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
}
```

- [ ] **Step 4: Provider** — in `notificationsContext.tsx` add to `Value` and implement (optimistic, then refresh):

```tsx
  const markUnread = useCallback(async (id: string) => {
    setItems((cur) => cur.map((i) => (i.id === id ? { ...i, read_at: null } : i)));
    setUnreadCount((n) => n + 1);
    await markInboxUnread(id).catch(() => undefined);
    await refresh();
  }, [refresh]);
  const hide = useCallback(async (id: string) => {
    setItems((cur) => {
      const gone = cur.find((i) => i.id === id);
      if (gone && !gone.read_at) setUnreadCount((n) => Math.max(0, n - 1));
      return cur.filter((i) => i.id !== id);
    });
    setNewItems((cur) => cur.filter((i) => i.id !== id));
    await hideInboxItem(id).catch(() => undefined);
    await refresh();
  }, [refresh]);
  const clearRead = useCallback(async () => {
    setItems((cur) => cur.filter((i) => !i.read_at));
    await clearReadInbox().catch(() => undefined);
    await refresh();
  }, [refresh]);
```

  (Also make `markRead` optimistic the same way: set `read_at` locally and decrement the count before the API call.) Add the three to the memo deps, the `value`, and `EMPTY`.

- [ ] **Step 5: `NotificationsPanel.tsx`**

```tsx
/**
 * The bell's popover: Settings-aware (list text size + density via the
 * directory list tokens), kind icons, unread marker, per-row Mark read /
 * Mark unread / Hide, header Mark all read / Clear read, keyboard nav.
 * "Hide" is a soft dismiss (dismissed_at) — rows are kept server-side.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { useNotifications } from '../lib/notificationsContext';
import type { InboxItem } from '../lib/api';
import '../styles/toast.css';

export const INBOX_CAP = 50;

export function relativeTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = `notif-icon notif-icon-${kind}`;
  if (kind === 'report_ready') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><path d="M8 13h8M8 17h5" />
      </svg>
    );
  }
  if (kind === 'report_failed') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3 2 20h20z" /><path d="M12 9v5M12 17h.01" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

export default function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const { items, unreadCount, markRead, markUnread, markAllRead, hide, clearRead } = useNotifications();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const readCount = items.filter((i) => i.read_at).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (n: InboxItem) => {
    void markRead(n.id);
    onClose();
    if (n.link) navigate(n.link);
  };

  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>, n: InboxItem, idx: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="listitem"]');
    if (e.key === 'ArrowDown') { e.preventDefault(); rows?.[idx + 1]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows?.[idx - 1]?.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); open(n); }
  };

  return (
    <div className="pop-menu notif-panel" role="dialog" aria-label="Notifications">
      <div className="notif-head">
        <span className="pop-title">Notifications</span>
        {unreadCount > 0 && <span className="notif-chip">{unreadCount} unread</span>}
        <span className="notif-head-actions">
          <button type="button" className="btn-ghost" disabled={unreadCount === 0}
                  onClick={() => void markAllRead()}>Mark all read</button>
          <button type="button" className="btn-ghost" disabled={readCount === 0}
                  onClick={() => void clearRead()}>Clear read</button>
        </span>
      </div>

      {items.length === 0 ? (
        <div className="pop-empty notif-empty">
          <KindIcon kind="bell" />
          You&apos;re all caught up.
        </div>
      ) : (
        <div className="notif-list" role="list" ref={listRef}>
          {items.map((n, idx) => (
            <div key={n.id} role="listitem" tabIndex={0}
                 className={`notif-row ${n.read_at ? '' : 'unread'}`}
                 onClick={() => open(n)} onKeyDown={(e) => onRowKey(e, n, idx)}>
              <KindIcon kind={n.kind} />
              <span className="notif-text">
                <span className="notif-title">
                  {!n.read_at && <span className="notif-dot" aria-hidden="true" />}
                  {n.title}
                </span>
                {n.body && <span className="notif-body">{n.body}</span>}
                <span className="notif-time">{relativeTime(n.created_at)}</span>
              </span>
              <span className="notif-actions" onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}>
                {n.read_at ? (
                  <button type="button" className="icon-btn" aria-label="Mark unread" title="Mark unread"
                          onClick={() => void markUnread(n.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="4" /></svg>
                  </button>
                ) : (
                  <button type="button" className="icon-btn" aria-label="Mark read" title="Mark read"
                          onClick={() => void markRead(n.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
                  </button>
                )}
                <button type="button" className="icon-btn" aria-label="Hide" title="Hide"
                        onClick={() => void hide(n.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {items.length >= INBOX_CAP && <div className="notif-foot">Showing the {INBOX_CAP} most recent</div>}
    </div>
  );
}
```

- [ ] **Step 6: Styles** — replace the `.pop-menu .notif-*` block in `toast.css` with:

```css
/* ── notifications panel (bell) — follows Settings via the list tokens ── */
.pop-menu.notif-panel {
  width: min(420px, calc(100vw - 32px));
  max-height: min(70vh, 560px);
  display: flex; flex-direction: column;
  padding: 0;
}
.notif-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 12px 10px; border-bottom: 1px solid var(--paper-line);
}
.notif-head .pop-title { margin: 0; }
.notif-chip {
  font-size: var(--list-fs-head); letter-spacing: 0.08em; text-transform: uppercase;
  padding: 3px 8px; border-radius: 999px;
  color: var(--accent); background: rgba(var(--accent-rgb), 0.14);
}
.notif-head-actions { margin-left: auto; display: flex; gap: 4px; }
.notif-head-actions .btn-ghost { font-size: var(--list-fs-sub); padding: 5px 9px; }
.notif-list { overflow-y: auto; }
.notif-row {
  display: flex; align-items: flex-start; gap: 12px;
  min-height: var(--list-row-min-h); padding: var(--list-row-pad-y) 12px;
  border-bottom: 1px solid var(--paper-line); cursor: pointer; outline: none;
}
.notif-row:last-child { border-bottom: 0; }
.notif-row:hover, .notif-row:focus-visible { background: rgba(var(--accent-rgb), 0.06); }
.notif-row.unread { background: rgba(var(--accent-rgb), 0.04); }
.notif-row.unread .notif-title { font-weight: 600; }
.notif-icon { flex: none; width: 20px; height: 20px; margin-top: 2px; color: var(--text-mute); }
.notif-icon-report_failed { color: var(--c-red, #c03540); }
.notif-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.notif-title { font-size: var(--list-fs-primary); color: var(--text-dark); display: flex; align-items: center; gap: 8px; }
.notif-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
.notif-body, .notif-time { font-size: var(--list-fs-sub); color: var(--text-mute); }
.notif-actions { flex: none; display: flex; gap: 4px; opacity: 0; transition: opacity 120ms; }
.notif-row:hover .notif-actions, .notif-row:focus-within .notif-actions { opacity: 1; }
@media (hover: none) { .notif-actions { opacity: 1; } }
.notif-actions .icon-btn { width: 30px; height: 30px; }
.notif-actions .icon-btn svg { width: 14px; height: 14px; }
.notif-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: var(--list-fs-cell); }
.notif-empty .notif-icon { width: 26px; height: 26px; }
.notif-foot { padding: 8px 12px; font-size: var(--list-fs-sub); color: var(--text-mute); text-align: center; border-top: 1px solid var(--paper-line); }
```

  (Keep the existing `.bell-badge` and `.toast*` rules.) Because `.pop-menu` sets `padding: 8px` and `min-width`, the `.notif-panel` overrides above win on specificity.

- [ ] **Step 7: Topbar** — replace the notification `pop-menu` block with `{pop === 'notif' && <NotificationsPanel onClose={() => setPop(null)} />}`; import the component; delete the local `relativeTime` and the `useNavigate`/`items`/`markRead`/`markAllRead` usages that only served the old list (keep `unreadCount` for the badge). Update `Topbar.test.tsx` per Step 1.

- [ ] **Step 8: Run** — `cd portal && npx vitest run src/lib/notificationsContext.test.tsx src/components/NotificationsPanel.test.tsx src/components/Topbar.test.tsx && npx tsc --noEmit -p . && npx vitest run` → green.

- [ ] **Step 9: Commit** — `feat(portal): notifications panel — Settings-aware rows, kind icons, mark read/unread, hide, clear read`.
