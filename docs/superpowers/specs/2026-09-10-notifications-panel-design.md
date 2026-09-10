# Notifications panel redesign

**Date:** 2026-09-10 · **Status:** Approved design · **Branch:** `reports` (on top of the Reports feature)

## Summary

Replace the bell's generic pop-menu with a purpose-built notifications panel
that follows the portal's Settings (list text size + density), shows each
item with a kind icon, unread marker, body and relative time, and offers
per-item **Mark read / Mark unread** and **Hide** actions plus header
actions **Mark all read** and **Clear read**. "Hide" is a soft dismiss
(`dismissed_at`), never a delete — the retention policy is still open.

## Data + API

- `notifications.dismissed_at timestamptz null` (migration 0048). Dismissed
  rows are excluded from `GET /notifications/inbox` (items AND
  `unread_count`) and never surface again; they stay in the table.
- `POST /notifications/inbox/{id}/unread` → 204: clears `read_at` (own rows
  only, 404 otherwise; no-op on a dismissed row → 404).
- `DELETE /notifications/inbox/{id}` → 204: sets `dismissed_at` (own rows
  only, 404 otherwise; idempotent).
- `POST /notifications/inbox/clear-read` → 204: sets `dismissed_at` on every
  own row that is read and not yet dismissed.
- All are ordinary mutating calls (frozen in read-only mode, no allowlist).

## Portal

`lib/notificationsContext.tsx` gains `markUnread(id)`, `hide(id)`,
`clearRead()` — optimistic (update `items`/`unreadCount` locally, call the
API, then `refresh()`; on API failure refresh restores truth).

`components/NotificationsPanel.tsx` (rendered by Topbar in place of the
inline list):
- Container `.pop-menu.notif-panel`, width `min(420px, calc(100vw - 32px))`,
  max-height `min(70vh, 560px)` with the list scrolling inside.
- Header: title `Notifications` (existing `.pop-title` style) + unread count
  chip (`N unread`, hidden at 0) + header actions `Mark all read` (disabled
  at 0 unread) and `Clear read` (disabled when no read items) as `.btn-ghost`.
- Row (`.notif-row`, `role="listitem"`): left kind icon (report icon for
  `report_ready`, warning triangle for `report_failed`, bell for others);
  accent unread dot; title (`--list-fs-primary`), body
  (`--list-fs-sub`, muted), time (`--list-fs-sub`, muted, `relativeTime`).
  Row min-height/padding use `--list-row-min-h` / `--list-row-pad-y` so
  compact density applies. Unread rows: title weight 600 + subtle accent
  tint background.
- Row actions (`.notif-actions`, visible on hover/focus-within, always
  visible on touch via `@media (hover: none)`): two `.icon-btn`-sized
  buttons with `aria-label`s `Mark read` / `Mark unread` and `Hide`. They
  `stopPropagation` so the row click (open link + mark read) does not fire.
- Empty state: bell icon + `You're all caught up.` (`.pop-empty`).
- Footer when `items.length >= 50`: `Showing the 50 most recent`.
- Keyboard: Escape closes; ArrowDown/ArrowUp move focus between rows;
  Enter opens the focused row.
- Typography follows Settings: all font sizes derive from `--list-fs-*`
  (which already include `--list-scale`), so Settings → list text size and
  density change the panel like any list.

## Tests

- API `tests/test_notifications_inbox.py`: unread, hide (excluded from list
  + count, idempotent, own-rows-only), clear-read (only read rows), read-only
  freeze untouched.
- Portal `lib/notificationsContext.test.tsx`: markUnread/hide/clearRead call
  the API and update counts optimistically. `components/NotificationsPanel.test.tsx`:
  renders rows with icons/dot/time, per-row actions call the right provider
  fns without triggering navigation, header actions, empty state, cap
  footer, keyboard. `Topbar.test.tsx`: bell opens the panel.

## Out of scope

Hard delete, a full-page inbox, notification preferences, email.
