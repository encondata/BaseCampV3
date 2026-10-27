# Learning portal (learn.serversherpa.com): design

**Status:** Approved by Jimmy on 2026-10-25 after a design discussion and HTML mockups (`docs/mockups/learning-portal.html`). He approved every screen except the original Initiative › Learning tab layout. That was redone as the tabbed initiative detail page (commit b7239d11), which has a Learning tab.
**Harbor Master:** design page `SS/Design › Learning portal (learn.serversherpa.com)`, card SS-515.
**Branch:** `learning-portal` (off `initiative-tabs`).

## What it does

New workers get an email with a one-click link plus a 6-character learning code. They sign in at learn.serversherpa.com with the code and their last name. There they read and sign the documents assigned to them:
- a standard packet for everyone,
- initiative or client packets,
- individual extras.

When everything for an initiative is signed:
- a `worker_certifications` row is written;
- people who manage learning get a notification;
- the worker gets an email with their time clock QR code;
- the compliance report shows them as signed off.

When a worker scans in at the time clock with unsigned items, the station shows a warning listing them. The worker can email themselves the link or cancel the punch, or an admin (rank 60+) can override.

The management side lives in the portal and is configurable end to end:
- library, versions, validity and the per-document re-sign rule,
- packets, assignment rules with a dry run,
- invite scheduling and reminders,
- quizzes and translations,
- dashboard, compliance grid, reports and settings.

## Jimmy's decisions (verbatim intent)

| Topic | Decision |
|---|---|
| Sign-in | 6-character code **+ last name**, with a rate limit and an expiry; the email has a **one-click link**. |
| Codes | One per person per initiative; a new initiative means a new code. A general code (no initiative) covers manual assignments on non-initiative days. |
| Sending | **Send now**, or a **scheduled send** that shows on the initiative timeline. Controls go on the initiative's Learning tab. |
| Reminders | Yes, configurable (company default, per-initiative override). |
| SMS | Later. Workers without email: a printable code sheet now. |
| Time clock | Warning popup on scan, listing what's outstanding. **Admin or above** can override. A new initiative means new codes. |
| Validity | Each document has a validity period (30 days, 6 months, 1 year…). A sign-off stays valid for the whole initiative it was signed for. Only a **new initiative assignment** can require signing again. |
| New version | Required at the next initiative, or pushed by hand to people on site outside an initiative. |
| Re-sign rule | Per document: **every initiative**, or **only if expired or there's a new version** (shown in the mockup, approved). |
| Hosting | Separate app at learn.serversherpa.com on the shared sign-in look. Default: "Enter your learning code"; secondary: "Sign in with an account". Workers get learning-only access unless they already have an account. |
| Managers | Whoever manages the wiki, plus a new **Learning admin** role. |
| Languages | English governs. Translations are for convenience, and each sign-off records the language read. Claude drafts and a fluent reviewer approves. Priority: Japanese, Korean, Hebrew (right-to-left). |
| Platform scope | This session builds the API, portal, learn app, web kiosk and laptop time clock. **Android and iOS time clock warnings belong to the platform sessions.** The API contract ships here. |
| Policy values | No invented numbers. Code lockout and rate limits **default to the portal's existing sign-in values** and are editable (see Settings). |

## Implementation decisions (from code research)

### Wiki content
- The wiki's top-level container is a **space** (shown as "library" in the UI). The "Learning bucket" is a new space, key `learning`, name `Learning`.
- Content is ProseMirror/Tiptap JSON. Python has no converter, so HTML comes from the wiki render server (`export_html.render_fragment`, `SS_WIKI_RENDER_URL`, default `http://localhost:5177`).
- **Snapshot at publish.** Publishing a learning version copies the wiki page's current published `content_json`, renders it to HTML once and stores both in `learning_document_versions`, together with the wiki version id and number.
  - Reason: wiki trash purges cascade and delete version history, and the learn site should not depend on the render server per read.
- Images are stored as wiki asset ids. They are resolved to presigned URLs when a worker opens the document (`finish_fragment` with an images map), the same way the PDF export does it.
- **Who can manage learning:**
  - **Learning admin role:** gets `learning:view/add/change/delete`.
  - **Wiki managers:** anyone with `wiki:delete` (the wiki administrators) is treated as a learning manager. The check is `learning:change` OR `wiki:delete`.
- Seed: the CLI command `serversherpa learning-seed` creates the `learning` space, its sample pages, the matching learning documents, the Standard onboarding packet and the Everyone rule.
  - It is idempotent (looks things up by key or title) and follows `.superpowers/wiki/android-guides/android_guides.py`.

### Worker sign-in (learn sessions)
- Workers without accounts must not get `user_accounts` rows, so learn sessions are **their own table** (`learning_sessions`) with their own dependency. They never touch `auth_sessions`.
- **Session token:**
  - The token is `token_urlsafe(32)`, stored as SHA-256.
  - The learn app keeps it in `sessionStorage` and sends `Authorization: Learn <token>`. With no cookie involved, there is no CSRF surface.
  - The session's lifetime is the shorter of the code's expiry and `SS_SESSION_TTL_SECONDS`.
- **Account sign-in:** the learn app reuses `@portal/pages/Login` and the portal auth (cookie `ss_portal_refresh`, like the wiki). `/learn/*` worker routes accept either a learn session or a normal user bearer token, and act on that person's own assignments.
- **Codes:**
  - 6 characters of Crockford base32 (`kiosk_pairing.CODE_ALPHABET`), case- and space-insensitive (`normalize_code`).
  - Stored as an HMAC fingerprint (the `move_password.fingerprint` pattern, domain `b"learning-code\0"`) with a unique index over active codes.
  - The code itself only ever appears in the email and the printable code sheet.
  - Last-name matching is casefolded, accent-stripped (NFKD), and whitespace-trimmed and collapsed.
- **One-click link:**
  - `learn_url("/start#t=<token>")` (token in the fragment, like reset links).
  - The token is `token_urlsafe(32)` stored as SHA-256 on the code row. It stays reusable until the code expires or is revoked.
- **Abuse limits** use the database-backed pattern of `routes/kiosk.py` `move_login_capped` (counting `audit_log` `learning_code_failed` rows).
  - Per-IP bucket limit and window: default **30 per 300 s** (copied from move login).
  - Global limit: default **300 per 300 s**.
  - Per-code lockout: **10** failures, then **900 s** (copied from `SS_MAX_FAILED_LOGINS` / `SS_LOCKOUT_SECONDS`).
  - All of these are editable in learning settings.
- **Code expiry default:** the initiative's end date at 23:59 in the site's time zone (or UTC).
- **General codes:** they stay valid until they are revoked or every assignment they cover is signed. The optional `general_code_days` setting is blank by default; we pick no number.
- **Session lifetime:** uses the portal's `SS_SESSION_TTL_SECONDS`, capped at the code's expiry.
- **Schedule defaults:** the values in the approved mockup.
  - Invite 7 days before start at 08:00 site time.
  - Reminders 5 and 3 days before start.
  - Due 2 days before start.
  - Codes expire at the initiative's end.

### Assignment engine
- Assignments are created, never edited away:
  - `learning_assignments` (person, initiative or null, document, the version required, due date, status);
  - `learning_signoffs` (append-only).
- **On add to an initiative.** `learning.assign_on_add(db, initiative_id, person_id, actor_id)` runs in the same transaction at both insert points: `routes/initiatives.add_initiative_person` and `people/team_bulk.commit_rows` (the add branch). It evaluates rules and creates assignments for documents that are due.
- **A document is due on an initiative when any of these is true:**
  - its rule is `every_initiative`;
  - the person has no valid sign-off;
  - their latest sign-off is for an older version.
- **What "valid" means.** A sign-off is valid when `signed_at + validity_days` is on or after the date it is checked, or when it was signed for that same initiative (valid through the initiative end).
- **Rules:**
  - Ordered, can be turned off, conditions combined with AND.
  - Fields: `everyone`, `initiative`, `client`, `site`, `site_country`, `worker_role` (the person's `work_type` on the initiative), `partner`, `person`.
  - Each rule points at one packet.
- **Dry run.** `POST /learning/initiatives/{id}/dry-run` returns per-row results (who gets what, why, what was skipped and why, no email), following the Bulk Actions review-summary convention. Applying it is the same call with `apply=true`.

### Invites, reminders and the scheduler
- Each initiative has one `learning_invite_schedules` row:
  - `mode`: manual / scheduled;
  - send time (`send_offset_days` before start plus `send_time` in the site's time zone);
  - `reminder_offsets` (days before start);
  - `due_offset_days`;
  - `late_adds` (auto-invite people added after the send);
  - `sent_at`.
- The notification-worker gains `run_learning_once(maker)` every **60 s**, which:
  - sends scheduled invites that are due;
  - sends reminders (deduplicated per assignment and offset in `learning_email_log`);
  - raises `learning_overdue` notifications once per initiative per day.
- **Emails** use new templates `learning_invite`, `learning_reminder`, `learning_complete` and `learning_new_version`, rendered with `mail/outbox.enqueue`.
  - The subject and intro text can be edited per template and language in settings. The rest is the stored template.
  - The completion email embeds the QR code as an inline CID image. This needs `segno` and an attachments capability in `mail/transport.build_message` + `EmailOutbox.attachments` JSONB (base64, content id).
- **QR value:** `str(people.badge_uid)`, which kiosks already match.

### Completion
- When a person's last open assignment for an initiative (or for the general set) is signed, all in one transaction:
  - write a `worker_certifications` row with name `Onboarding: <initiative name>` (or `Learning: general`), issued today, and `expires_on` set to the earliest expiry among the signed documents. `learning_assignment_id`/`source='learning'` is added to the table.
  - `notify(kind='learning_complete')` everyone with `learning:change` or `wiki:delete` (global). The notification category is a new `learning`.
  - enqueue the completion email with the QR code.

### Time clock
- `KioskTimeclockStatusOut` gains `learning: {outstanding: [{title, kind: "required"|"extra"}], link_email: bool} | null`, computed for the station's `current_initiative_id`, or general assignments when it has none. It is null when nothing is outstanding.
- `POST /kiosk/station/timeclock/learning-link {serial, person_id}` re-sends the one-click link (the "Email me the link" button).
- `POST /kiosk/station/timeclock/learning-override` takes `{serial, person_id, admin_email, admin_password, totp_code?, reason, scope: "punch"|"day"}`.
  - It checks the admin's credentials without opening a session (Argon2 verify plus TOTP when enrolled, account lockout counted) and requires rank 60+.
  - It writes `learning_overrides` and audits `learning_override`, then returns `{override_id}`.
  - Reasons are a fixed list plus Other with text: `signing_on_break`, `signed_on_paper`, `no_phone`, `other`.
- **Gating is in the UI (soft gate).**
  - The web kiosk and laptop flows add a `learning` step after the worker confirms who they are, for clock-in only.
  - A "day" override suppresses the warning for that person at that site for the rest of the local day.
  - Clock-in accepts an optional `learning_override_id` to link the punch to the override.
  - The server does **not** block punches, so Android and iOS keep working until their sessions add the screen.
- Face or PIN sign-in is not possible at shared stations (biometric is refused there), so the override uses email + password (+ 2FA).
- The laptop edge already forwards status and punches live (punches need the server), so no offline snapshot is needed. The edge forwards the two new routes.

### Portal (management)
- **Nav:** a new **Learning** section.
  - Dashboard `/learning`, Library `/learning/library`, Packets `/learning/packets`, Assignment rules `/learning/rules`, Settings `/learning/settings`.
  - Gated on `learning:view` (managers via `wiki:delete` too).
- **Initiative detail Learning tab:**
  - stats (invited, opened, in progress, complete, overdue);
  - invites and reminders card with a mini timeline, Send now, Edit schedule;
  - what this move requires (packets from rules, plus extras);
  - workers roster (status, progress, language, last activity, Resend / Regenerate code / Revoke);
  - Print code sheet (PDF);
  - Compliance report button.
- **The initiative timeline** shows the scheduled send as a marker.
- **Document page tabs:**
  - Content and rules: rendered preview, plus the settings panel for validity, re-sign rule, sign style, scroll to end, minimum reading time, quiz on or off, and the "what changed" note on publish.
  - Quiz: question pool, pass mark, retries, what happens on failure.
  - Translations: per-language status (Draft / In review / Published / Out of date), Translate draft (Claude), edit, approve.
  - Versions: history and compare.
  - Sign-offs.
- **Worker detail:** the Certifications panel shows learning certs, plus a new Learning history panel (every sign-off, version, language, read time, quiz attempts, overrides).
- **Learning settings:** code policy values, defaults (validity, reminders, due offset, send time), email text per template and language, branding line, and sign-off retention (default **keep**; no purge until HR or legal sets a period).
- **Reports:**
  - a new report type `learning_compliance` (xlsx + pdf, per initiative or for everyone);
  - a per-worker sign-off certificate PDF at `GET /learning/people/{id}/certificate.pdf`.

### Learn app (`learn/`)
- A Vite + React SPA, structured like `wiki/` (the `@portal` alias, `publicDir ../portal/public`, dedupe, a portal-imports allowlist test).
- Dev port **5179** with `strictPort`; Docker is a static Caddy image like `kiosk/`; deploy entries in `deploy/stack`.
- **Screens** (mockup view "Worker learn site"):
  1. Sign in: code boxes, last name, Continue, "Sign in with an account", language picker.
  2. My training: progress bar, ordered tasks.
  3. Read and sign: scroll-to-end and minimum time, the checkbox, typed name or drawn signature.
  4. Quiz.
  5. Done: the QR code (rendered with `@portal/lib/qr.ts`), Save to phone (downloads a PNG).
- **i18n:** a small dictionary for en/ja/ko/he, with `dir="rtl"` for Hebrew. Document text comes from published translations, falling back to English with a note.

## Out of scope (this build)
- SMS
- Wallet passes
- The Android and iOS time clock warning screens (their sessions own them)
- An offline compliance snapshot (punches already need the server)
- Purging sign-off records (no retention period has been set)
