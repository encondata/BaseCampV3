# Kiosk environment picker — design

Date: 2026-11-20 · Status: approved by Jimmy 2026-11-20

## Why

ServerSherpa is getting close to a production release and now runs several
staging and test environments (RC1, UAT, Beta, Alpha, Dev, and soon Prod).
Moving a kiosk between them today means typing the full API and portal URLs
into Settings › This Kiosk. That's slow, easy to get wrong, and it means
handing people full server addresses. Jimmy wants a named drop-down instead,
with typed URLs kept for the people who really need them.

## Goals

- On the Android, iOS and laptop kiosks, Settings › This Kiosk shows the
  current **environment** by name and lets someone change it by picking a
  name.
- The list of names is downloaded from
  `https://status.serversherpa.com/environments.json` when that file exists.
  Otherwise it comes from a list built into the app.
- Changing environment needs the password **cumulus**.
- A **Custom URL** option still exists, behind a stronger check (see
  "Who can change what").
- After a switch the kiosk is clean for the new environment. Nothing from
  the old server (sign-in, setup, unsent scans, cached moves) leaks into it.
- Anyone looking at a kiosk can tell when it isn't on Prod.

## Non-goals (later projects)

- The status site serving `environments.json`. Until it does, the request
  fails and kiosks use their built-in list.
- Sirdar writing the file (a "show in kiosk picker" checkbox per
  environment, and publishing on change).
- The web kiosk (served from `kiosk.<env>…`). Its environment is the address
  it was loaded from, so it gets no picker.
- Changing how the laptop installer works. It still sets the starting URL.

## Anti-goals (a failure even if it works)

- A downloaded list that can point kiosks at a server outside
  serversherpa.com. Only Custom URL can do that, and it has its own check.
- A switch that leaves the old server's data behind: unsent scans sent to
  the wrong environment, or a refresh cookie, station key or push token
  still tied to the old server.
- A gate that can be stepped around. Switching to a named environment must
  not make Custom URL easier to reach (see rule 3 below).
- Hiding Settings sections because of setup choices (existing rule:
  setup choices hide nothing).

## Approaches considered

1. **Keep free-text URL fields** (today). No build cost, but it's exactly
   the problem: slow, error-prone, and it exposes full addresses.
2. **Built-in list only.** Simple, works offline, can't be tampered with.
   But adding an environment (RC2) needs a new app build on every platform.
3. **Downloaded list with the built-in list as fallback — picked.** New
   environments show up without a release once the status site serves the
   file. The domain rule keeps a tampered file inside serversherpa.com, and
   kiosks keep working offline or before the file exists.

Where Sirdar would publish the list from (copying the file to every
environment, status sites pulling it from Sirdar, or public file storage)
was discussed and deferred. Jimmy decided the kiosk only ever reads
status.serversherpa.com.

For the laptop, two places to switch were considered: kiosk Settings, or
re-running the installer. **Kiosk Settings was picked** so all three
platforms behave the same, even though the laptop's local service ("the
edge") then has to change servers while it runs.

## The environment list

### The file contract (the status site and Sirdar will follow it later)

`GET https://status.serversherpa.com/environments.json`

```json
{
  "version": 1,
  "environments": [
    { "id": "prod",  "name": "Prod",  "domain": "serversherpa.com" },
    { "id": "rc1",   "name": "RC1",   "domain": "rc1.serversherpa.com" },
    { "id": "uat",   "name": "UAT",   "domain": "uat.serversherpa.com" },
    { "id": "beta",  "name": "Beta",  "domain": "beta.serversherpa.com" },
    { "id": "alpha", "name": "Alpha", "domain": "alpha.serversherpa.com" },
    { "id": "dev",   "name": "Dev",   "domain": "dev.serversherpa.com" }
  ]
}
```

- `id` is the stable key the kiosk saves. Sirdar's environment-name rule
  applies (`^[a-z][a-z0-9-]{1,31}$`, no trailing hyphen), except that `prod`
  is allowed.
- `name` is what people see.
- `domain` is the base the app builds every address from:
  `https://api.<domain>` and `https://portal.<domain>`. This matches how
  Sirdar already names hosts (`api.`, `portal.`, `kiosk.` … in front of the
  environment domain).
- Entries are shown in file order.

### Validation

The kiosk keeps an entry only when:

- `domain` is exactly `serversherpa.com`, or ends in `.serversherpa.com`,
  and is a plain lower-case host name (letters, digits, hyphens and dots; no
  port, path, scheme or user info);
- `id` matches the rule above and appears only once;
- `name` is a non-empty string.

Bad entries are dropped one at a time. The file is used only if
`version` is `1` and at least one entry survives. Otherwise it counts as a
failed download. Only https is used for the request, and redirects to
another host are not followed.

### Where the list comes from, in order

1. A fresh download, made when the person opens the environment chooser.
2. The last good download, saved on the device.
3. The built-in list: the six entries shown above, in that order.

The chooser never waits long for the download (builder picks a short
timeout). It opens with the best list available and refreshes in place if
the download lands.

**Prod** is the entry whose domain is exactly `serversherpa.com`.

### What the kiosk saves *(Claude's call)*

At switch time the kiosk saves the environment's `id`, `name` and the
`domain` it resolved, and it keeps connecting to that saved domain. The
list only feeds the chooser. If a later list gives `rc1` a different
domain, or drops `rc1`, the kiosk keeps working where it is. It never moves
servers without a switch, because a silent move would skip the wipe. The
chooser marks the current environment by its saved `id` and domain. When
the list's entry for that `id` now has a different domain, the entry is
shown as a normal choice, and picking it is a full switch.

## Who can change what

1. **Named environment:** always needs the password `cumulus`, typed into
   a password prompt. The password is in the source on purpose. Jimmy
   accepted that it's a speed bump, since the repo is going private and
   release builds aren't public.
2. **Custom URL** (API URL + portal URL, the same fields and checks as
   today, http or https):
   - on a kiosk that has **never been registered**, `cumulus` is enough;
   - on a kiosk that **has been registered**, someone with a global role of
     rank 80 or higher must sign in (developer, founder, super_admin: the
     API's existing `ensure_super_admin` rule), and the current server
     checks it. *(Jimmy, 2026-11-20)*
     If that person is already signed in on the kiosk, no extra sign-in is
     needed. An offline sign-in (the laptop's cached sessions) never
     counts. The check is a live answer from the current server.
     *(Claude's call)*
3. **"Has been registered" never resets on a switch.** A kiosk counts as
   registered once any environment has given it a registration, and that
   stays true after switching. Only a fresh install or clearing the app's
   data resets it. Without this, someone could switch to a named
   environment with `cumulus` alone, land on a "never registered" kiosk,
   and reach Custom URL without the sign-in. *(Claude's call: this is what
   keeps rule 2 meaningful.)*
4. If the current server can't be reached, the dev or super admin sign-in
   can't happen. The named list (rule 1) still works, so a kiosk stuck on
   a dead server can always be moved to a working environment and checked
   from there.

On the laptop, the edge checks these rules itself (password, role and
registered flag). It doesn't trust the browser to.

## What a switch does

Before switching, the kiosk shows what will be lost and asks to confirm.
If anything is unsent (outbox scans, RFID uploads, Dock passes), the
confirmation says how many. The person can then either wait for it to
send, or discard it. **Discarding needs an admin sign-in** (rank 60 or
higher, live from the current server, the same bar as the laptop's Wipe
today). With nothing unsent, `cumulus` alone is enough. *(Jimmy,
2026-11-20)* This uses the same pattern as the laptop's Wipe
(`outbox_not_empty`, then confirm).

Then, in this order:

1. Sign out of the old server (best effort; offline is fine).
2. Clear everything the existing **Developer › Clear Setup** clears on
   that platform: setup, cached move data, local data, and settings back to
   their defaults.
3. Also clear what is tied to the old server: the refresh cookie (this
   also finishes Android's deferred "clear the old host's cookie" item),
   biometric sign-in enrollment, Time Clock station key, push
   registration, device registration token and the last registration
   state, and the settings-sync bookkeeping for the old server's settings
   document.
4. Keep the kiosk's name, its serial and the "has been registered" flag.
5. Save the new environment (its `id`, or the two custom URLs) and reload
   onto the sign-in screen. The first sign-in registers the kiosk with the
   new server, and Kiosk Setup starts as on a new kiosk.

*Claude's call:* settings go back to defaults (as Clear Setup does)
because the new server keeps its own settings document per kiosk, and
old-server settings shouldn't win there.

## Platform specifics

### Android (`Android_Kiosk_App/`) and iOS (`IOS_Kiosk_App/`)

- `ThisKioskPanel` (Kotlin and Swift) replaces the "API URL" / "Portal URL"
  fields and the "Save URLs" button with:
  ```
  Environment   UAT                         [ Change… ]
  Server        api.uat.serversherpa.com
  ```
  For a custom environment it shows `Custom` and the API URL.
- **Change…** opens the chooser (password → list → confirm). Custom URL is
  the last row of the list.
- `KioskConfig` resolves `apiUrl` / `portalUrl` from the saved environment.
  An existing install that has typed URLs saved and no environment saved
  is migrated on first launch: URLs that match a built-in domain become
  that environment, and anything else becomes Custom. The kiosk is not
  reset by this migration.
- The build default (today's default API/portal URL) becomes a default
  environment `id`.
- Both apps call the status site directly (native requests, no CORS).

### Laptop (`kiosk_laptop/edge` + the kiosk web app in laptop mode)

- The edge saves the chosen environment in its data folder (for example
  `/data/environment.json`). When that file exists, it wins over
  `EDGE_CLOUD_API_URL` / `EDGE_PORTAL_URL`. Without it, the installer's
  values are used as today.
- New edge routes (local only, like the rest of the edge):
  - `GET /edge/environments`: the edge downloads and checks the list
    server-side (so the status site needs no CORS headers), keeps the last
    good copy, and falls back to the built-in list;
  - `GET /edge/environment`: the current environment;
  - `POST /edge/environment`: the switch. It checks the rules under "Who
    can change what", answers `outbox_not_empty` with counts until
    confirmed, runs the existing Wipe, clears what is tied to the old
    server, saves the choice, and moves the edge's cloud connections to the
    new server. Either it rebuilds them while running, or it exits and lets
    the container restart policy bring it back (builder's call).
- The "has been registered" flag lives in the edge's data folder, next to
  `identity.json`. It survives Wipe and switches.
- The kiosk web app's This Kiosk tab shows the same picker when
  `mode === "laptop"`, then runs its Clear Setup browser reset and reloads,
  as `factoryReset.ts` does today after `/edge/wipe`.

### Non-Prod badge

Whenever the current environment isn't Prod, the kiosk shows its name
(`UAT`, `Custom`) as a small badge in the shell's status bar (laptop) or
top bar (Android/iOS), and on the sign-in screen. The plain web kiosk gets
no badge in this project, since it's out of scope like its picker; its
address already names its environment. *(Claude's call)* It uses the existing
chip style, in a warning tone. Nothing is shown on Prod.

## Tests the builder must cover

- List checks: a foreign domain, a domain with a port or path, a
  duplicate `id`, wrong `version`, an empty list and bad JSON all fall back
  correctly; good entries survive next to bad ones.
- The fallback order: fresh, then saved, then built-in.
- The gates: wrong password refused; Custom URL on a registered kiosk
  needs a developer or super_admin sign-in; the "named environment, then
  Custom" route can't skip that sign-in.
- A switch with unsent scans is refused until confirmed. After a switch,
  nothing tied to the old server remains (cookie, station key, push token,
  biometric credential, cached moves).
- Migration of existing saved URLs on Android and iOS.
- Edge: the saved environment wins over the env vars; switching wipes and
  re-points; the registered flag survives Wipe.

## Left to the builder

Download timeout and refresh timing; exact copy and layout inside the
existing This Kiosk styles (rounded modal corners, report-generate modal
header, buttons never hidden below a scroll, light/dark); how the edge
re-points its cloud connections; where the saved list and flags are kept on
each platform (DataStore / UserDefaults / edge data folder).
