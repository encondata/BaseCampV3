# Person photo hover preview — design

**Date:** 2026-11-03 · **Branch:** `avatar-preview`

## Jimmy's decisions (2026-11-03)

- Hovering a person's photo shows a larger photo that isn't cut to the
  inline avatar's circle / rounded-square shape.
- Everywhere a person's photo appears in the portal (lists, detail pages,
  dashboards, access/group member lists, the sidebar user chip, modals).
- Size: **240 px** (from the mockup: Medium 240 px beside the avatar,
  white card, rounded image, the person's name under it).

## Behavior

- Opens after a short hover delay (**300 ms**) so sweeping across a list
  doesn't flash photos; closes on mouse leave, scroll, Escape, or when the
  avatar unmounts.
- Only when the person has a photo; initials avatars show nothing.
- Shows the whole stored image (`object-fit: contain`, no circle/crop
  mask) at 240 × 240 px max inside a card with the person's name under it.
  Stored photos are squared by the upload crop step, so most previews are
  square.
- Placed beside the avatar (right side, flips left near the right edge,
  clamped inside the viewport vertically); `pointer-events: none` so it
  never blocks the row beneath.
- Portaled into `trigger.closest('.portal-shell') ?? document.body` so it
  keeps the theme tokens and isn't clipped by `overflow: hidden` parents
  (same rule as `usePortaledMenu`); works in light and dark themes.
- Doesn't change any click behavior (rows still open, AvatarUpload still
  uploads).

## Build

- One shared component (e.g. `components/PhotoPreview.tsx`) that wraps an
  existing avatar element: `<PhotoPreview src name>{avatar}</PhotoPreview>`.
- Applied at every portal call site that renders a person's photo
  (`avatar_url`): Users, Workers, External, OrgDirectory, PeopleDashboard,
  UserDetail, WorkerDetail, Profile, StakeholderDetail, access tabs
  (Members, Groups, Overrides, Role review), notification group members,
  user-admin modals, AvatarUpload, the AppShell user chip.
- House guardrails (list typography, modal dropdowns, rounded scrollbars).

## Testing

Component: no preview without a photo; opens after the delay, not before;
closes on leave/scroll/Escape; portaled into `.portal-shell`; image uses
contain at 240 px; name shown. Call sites: each listed page wraps its photo
(a test per area or a guardrail test that every `avatar_url` `<img>` in
portal/src sits inside PhotoPreview). Live: harness check in Chromium of
placement, flip and theme.
