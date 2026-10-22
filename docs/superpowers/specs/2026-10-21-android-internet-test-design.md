# Android kiosk: Internet Test (a network link conditioner) — design

Date: 2026-10-21. Status: approved by Jimmy ("looks right, build it") and built on branch `android-net-test` (2026-10-22), not yet merged to main. Cut from `main` 798ba91b, with main merged in since (ba97976f: the Time Clock station and database v3). `android-labels` is already merged into main, so both dials are buildable today; main also carries Settings › Developer › Reset app (231c9f5b).

## 1. Intent

Jimmy: "testing offline sync and printing on a bad venue wifi including poor internet such as india and other places we operate."

The Android kiosk gets a developer tool like Apple's Network Link Conditioner. It deliberately makes the app's network slow, laggy and lossy, so we can rehearse two real conditions on one handheld:

- **Bad venue Wi-Fi.** Everything suffers: the link to the portal and the link to the network Zebra next to the tablet.
- **Poor internet (India and elsewhere).** Only the trip to the portal is slow and lossy. The printer on the local network still answers instantly.

Success means a developer can set those conditions in a few taps, watch how sign-in-free flows behave, and then turn it off and get the app back exactly as it was.

## 2. Goals, non-goals, anti-goals

**Goals**
- One switch, **Internet Test**, in Settings › Developer.
- Two independent dials, each with a preset list and a Custom setting:
  - **Internet** covers every call to the portal.
  - **Local network** covers every connection to a network Zebra printer, including the printer scan in Printer Setup.
- Each dial controls download and upload separately, each with a speed limit, a delay and a drop rate (six values).
- Presets copy Apple's values exactly (§5).
- **Off is a true bypass.** With the switch off, the app uses the very same connection objects and routes it uses today, with nothing added to the path.
- It turns itself off automatically at sign-out, on a Clear Setup, and two hours after it was switched on.
- An amber **Net test** chip shows in the top bar (and in the Time Clock's own header) whenever it is on.
- The code is built to be removed later without side effects (§8).

**Non-goals**
- Slowing the whole tablet. Only the kiosk app's own traffic is conditioned, so there is no VPN and no system permission prompt. Jimmy: "just the kiosk app is fine."
- Conditioning sign-in or pairing. Jimmy: "we don't need to worry about sign in and throttling that." It switches off at sign-out, so the sign-in screen is never conditioned.
- Custom presets of our own, such as an "India venue" preset. Jimmy: "Apple's list is enough for now."
- Fixing what the tool reveals. Today the app has no offline state, and a queued scan becomes permanently Failed after five tries (about 80 seconds). These are expected findings for separate work.
- The iOS, web and laptop kiosks; Bluetooth, USB, DataWedge and RFID sled traffic; control from the portal.
- Live counters or statistics on screen. They weren't asked for, so none are built.

**Anti-goals** (failure even if it technically works)
- Any change in behavior while the switch is off.
- A crippled handheld reaching a crew.
- Code that is hard to find or risky to delete.
- Blocking network work moving onto the main thread.

## 3. Constraints

- **Same build for everyone.** The tool ships in every build, debug and release. Jimmy: "same build for now, keep it in all builds."
- **Who can turn it on:** only someone signed in with the portal `developer` role, with Developer mode on. That is the existing gate on the Developer tab (`SettingsTabs.kt` `TabRequirement.DEVELOPER`, `KioskPrefs.devMode`).
- **Built on current `main`**, which now includes the `android-labels` printer networking. The printer hooks are `NetworkZebra.zebraSession()` and `ZebraScanner` / `LocalNetworks.socketFactoryFor`.
- Kotlin and Compose, following the app's existing patterns:
  - manual wiring in `AppContainer`;
  - DataStore preferences in `KioskPrefs`;
  - `SettingsRow`, `Segmented`, `KioskChip`;
  - the `core/` package stays Android-free, enforced by `CorePurityTest`.
- American English in all copy and comments.
- Toolchain (from the Android memory and plans):
  - `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` and `ANDROID_HOME=~/Library/Android/sdk`.
  - `./gradlew testDebugUnitTest assembleDebug`, run in the foreground with a long timeout.

## 4. Behavior

### 4.1 The switch and the dials

- **Internet Test** sits in Settings › Developer, below Developer mode, as a `SettingsRow` with a switch. Hint copy: "Slows this app's own traffic to test bad networks. Off: the app uses its normal connections, untouched. Turns itself off after 2 hours, or when you sign out or setup is cleared."
- While it is on, the section shows when it will turn off, for example "Turns off at 3:45 PM". *(My call.)*
- When the switch is on, the two dials appear under it, as in the approved mockup (`.superpowers/brainstorm/.../netcond-layout.html`):
  - **Internet**, captioned "portal: sync, uploads, heartbeat".
  - **Local network**, captioned "network Zebra printers".
- Each dial shows its presets as a row of chips. The selected preset shows a summary line, for example `↓ 780 kbps · 100 ms · 0% drop` and `↑ 330 kbps · 100 ms · 0% drop`.
- Choosing **Custom** shows six number boxes: Speed, Delay and Drop, each for Download and Upload.
  - Units are kbps (or Mbps), ms and %. Blank or 0 speed means no limit.
  - Speed and Delay take whole numbers. Drop takes one decimal point; a comma counts as the point, because the Decimal keyboard of a comma-decimal locale (de, fr, es, pt-BR) offers only `,`.
  - Custom remembers its last values per dial.
- Settings persist on the kiosk in DataStore as one JSON value: the switch, then for each dial its preset and its custom values. The switch state survives an app restart while the same person is still signed in.
- **Conditions apply only while someone is signed in.** This is a level, not an edge: while nobody is signed in the switch stays off, so if it is ever found on then (a switch-on that lands just after a sign-out), it turns off again at once rather than waiting, saved, for the next person to sign in. The start-up session restore (`KioskAuth.restore()` → `SessionStore.doRefresh()`), sign-in and pairing always take the direct route, like sign-in itself (Jimmy: no need to throttle sign-in). A restart on 100% Loss therefore still restores the session instead of dropping the developer to the sign-in screen. *(My call.)*
- **The Time Clock station's own calls stay direct too.** `OkHttpStationApi` makes its calls with the station key while nobody is signed in, so under this rule it keeps using `AppContainer.httpClient` as it is and needs no hook. The one routed Time Clock call is the photo download (§4.5), which is conditioned only while the switch is on, so only when someone is signed in. *(My call.)*

### 4.2 Turning off

The switch turns off, and stays off, when any of these happens:

1. **Any sign-out.** Jimmy: "turn it off automatically when they sign out." In this code the paths are:
   - the Sign out button (`AppContainer.logout()`);
   - the must-change-password notice's Sign out (`KioskGuard`);
   - the session ending, when a refresh fails and the state becomes signed out.

   The switch turns off **at the start** of a sign-out, before the sign-out's own portal calls (`/kiosk/sign-out`, `/auth/logout`), so sign-out stays quick and always reaches the portal. A watcher on the auth state turning signed-out catches the session-ending path. *(My call.)*
2. **The start-up restore finishes with nobody signed in.** This is a safety net in case a sign-out path was missed.
3. **Two hours after it was switched on.** Jimmy: "turn off after 2 hours."
   - The clock starts when the switch is turned on. Changing a preset or a Custom value doesn't restart it. *(My call.)*
   - The switch-on time is saved with the setting, so the two hours keep counting across app restarts. At start-up, a switch past its two hours comes back off.
   - If the device clock is moved backward past the switch-on time, the switch is treated as expired, which errs on the safe side. *(My call.)*
   - A saved switch-on time below zero can only be corrupt (the app writes the wall clock), so it counts as expired too.
4. **Setup is cleared.** Jimmy: "yes on clear setup." A Clear Setup sent from the portal and the move lock dropping the setup (`MoveSetupGuard`) both turn it off, even though the person stays signed in. The portal's Clear Setup arrives with the heartbeat: `KioskPrefs.applySetupClear` clears the setup, `Heartbeat.setupCleared` announces it (the controller listens there), and `SetupClearedRedirect` sends the person to Kiosk Setup. Either one usually means the handheld is going to a new move or crew.
5. **Developer mode is turned off.** The section would be hidden, so it must not stay active out of sight. *(My call.)*

Settings › Developer › Reset app leaves Internet Test alone, as it leaves Developer mode alone: both are developer settings, and the developer stays signed in. *(My call.)*

Changes take effect on the next call or connection. Calls already in flight finish under the conditions they started with. Turning the switch off also releases any pooled connections the conditioned path opened, so nothing conditioned lingers.

### 4.3 The warning (Jimmy picked option B)

- An amber **Net test** chip shows on every signed-in screen whenever the switch is on.
  - It sits in the `KioskShell` top bar. The top bar has had no mode chips until now (comment at `KioskShell.kt:84-86`); this is Jimmy's explicit choice.
  - The Time Clock takes the whole screen, without the top bar, so its own header (`TcHeader` in `TcShell.kt`) carries the chip too, above the date in the clock's column, where it takes no width from the wordmark. The Time Clock is always light paper, so the chip there uses the portal's amber chip for a light surface (dark amber `#a36207` on translucent amber) instead of the top bar's pale amber. The one gap: on a short screen, Enter Your Name drops the whole header while the keyboard is up, chip included. A Time Clock station never shows the chip, because nobody is signed in there.
  - Tapping the chip opens Settings › Developer.
- The footer gets a `Net test` item whose value names both dials' presets, for example `3G · Custom`. It uses the accent color, like `Dev mode`. (The Time Clock has no kiosk footer, so it has no footer item.)
- It never appears on the sign-in screen, because the switch is always off there.

### 4.4 What each setting does (app-level emulation)

Apple's tool shapes packets. Inside the app we shape what the app sees, so each setting has to feel to the app the way the real condition would:

- **Speed:** downloaded bytes reach the app no faster than the download rate, and uploaded bytes leave no faster than the upload rate.
- **Delay:** one-way latency. Each message turn costs the delay in its direction. A request costs the upload delay before it is sent, and the response costs the download delay before its first byte arrives. A new connection costs one round trip (upload plus download delay) to set up. A raw printer session is treated the same way: each write burst costs the upload delay, and each read burst costs the download delay.
- **Drop:** real packet loss never produces an instant error. TCP retransmits, so the app sees stalls. At high loss it sees hangs that end in its own timeouts. The emulation follows that:
  - The drop rate applies per segment-sized chunk (about 1,460 bytes) and to each connection attempt.
  - A dropped chunk or attempt waits a retransmission time that grows on consecutive drops, the way TCP backs off.
  - **100% Loss** means nothing gets through. Connections and reads hang until the app's own timeouts fire, exactly as on a dead link.
- **DNS delay** (High Latency DNS): added to each host-name lookup for a new portal connection. Printers are reached by IP address, so it doesn't apply to them.

Random drops come from a seedable source, so tests are repeatable.

### 4.5 Routing: the dual approach (Jimmy's design)

Jimmy: "if the 'Internet Test' toggle is on then we filter through the connection object. if the toggle is off then we bypass and keep the existing routes."

- **Internet, switch off:** the four users of the existing `AppContainer.httpClient` keep using that same object, with no interceptor added: `OkHttpKioskApi`, `SessionStore.doRefresh()`, the Time Clock photo download (`loadPhoto` in `ConfirmPerson.kt`, a presigned storage URL; it lived in `TimeclockScreen.kt` until the Time Clock station was merged from main), and `OkHttpStationApi` (a Time Clock station's calls under its station key).
- **Internet, switch on:** the API calls and the avatar download use a conditioned client (the photo is internet traffic too, so a poor-internet test shows avatars loading slowly, as crews would see them; *my call*). The restore and refresh call stays direct (§4.1), and so does `OkHttpStationApi`, which only calls while nobody is signed in and takes `AppContainer.httpClient` with no hook at all (§4.1). The conditioned client is derived from the original with `newBuilder()`, with the same cookie jar and timeouts, but its own connection pool, so conditioned connections never mix with normal ones.
  - The conditioning runs inside the network call on the IO thread. That includes pacing the whole response body, which is then handed back already read.
  - Several screens parse response bodies on the caller's (main) thread (`OkHttpKioskApi.kt:83-86`), so the conditioned path must never trickle body bytes on the caller's thread.
- **Local network, switch off:** printer sessions and scan probes use exactly the socket factories they use today: the Wi-Fi or Ethernet network's `socketFactory`, or the default.
- **Local network, switch on:** a wrapping socket factory delegates to that same network-bound factory, so the Wi-Fi or Ethernet binding is kept, and adds the conditions. Printer timeouts stay the printer code's own (500 ms probe connect, 3 s connect, 5 s total, 30 s send), so conditions trip them exactly as a bad link would.
  - So with Local network on **Very Bad Network** (500 ms each way, a 1,000 ms round trip), Printer Setup's scan finds no printers: each probe has 500 ms to connect, and the round trip alone is longer. That is the faithful result for such a link, not a fault (100% Loss hides them the same way). To test printing on that link, pick the printer with Enter IP, or try the scan under a milder preset. A printer already chosen still connects, because a print's connect has 3 s. No copy in the app says this.
- **"Off" preset:** each dial also has an **Off** preset, meaning that link isn't conditioned while the other dial is. For example, Internet on Off with the printer on Very Bad Network. *(My call: the mockup showed Off on the Local network dial only.)* With the switch on and a dial on Off, that link takes the switch-off path.

## 5. Presets (exact values)

The values come from Apple's own profile file on this Mac: `/System/Library/PrivateFrameworks/ConditionInducer.framework/Versions/A/Resources/NetworkProfiles.plist`. Only the nine profiles Apple's Network Link Conditioner lists are used. Speeds are in Mbps, delays in ms and drops in %. "—" means no limit.

| Preset | ↓ speed | ↓ delay | ↓ drop | ↑ speed | ↑ delay | ↑ drop | DNS delay |
|---|---|---|---|---|---|---|---|
| Wi-Fi | 40 | 1 | 0 | 33 | 1 | 0 | — |
| Wi-Fi 802.11ac | 250 | 1 | 0 | 100 | 1 | 0 | — |
| LTE | 50 | 50 | 0 | 10 | 50 | 0 | — |
| DSL | 2 | 5 | 0.05 | 0.256 | 5 | 0.039 | — |
| 3G | 0.78 | 100 | 0 | 0.33 | 100 | 0 | — |
| Edge | 0.24 | 400 | 0 | 0.2 | 400 | 0 | — |
| Very Bad Network | 1 | 500 | 10 | 1 | 500 | 10 | — |
| High Latency DNS | — | 0 | 0 | — | 0 | 0 | 3000 ms |
| 100% Loss | — | 0 | 100 | — | 0 | 100 | — |

- **Internet dial:** Off, Wi-Fi, Wi-Fi 802.11ac, LTE, DSL, 3G, Edge, Very Bad Network, High Latency DNS, 100% Loss and Custom, in that order.
- **Local network dial:** Off, Wi-Fi, Very Bad Network, 100% Loss and Custom. Phone-network presets don't describe a printer link.

## 6. Interfaces the build must keep

- `AppContainer.httpClient` stays as it is. The conditioned client is built from it, never the other way round.
- Every conditioned portal call (the API and the photo download) gets its client from one place: a small route provider, `(OkHttpClient) -> OkHttpClient` (`InternetTestRoutes.portal`), that returns its argument itself or the conditioned copy built from it.
- Every printer socket gets its factory from one place: `zebraSession()`, which every printer session and every scan probe (`ZebraScanner.identifyAt`) opens its socket through. The factory it is given (the network's `socketFactoryFor`, or the scan subnet's) is wrapped there, only while the switch and the dial are on.
- With the switch off, the route provider returns `AppContainer.httpClient` itself (`===`), and the printer path gets the unwrapped factory (`===`).

## 7. Tests the build must include

- **Presets:** the table in §5 matches the code value for value.
- **Pacing:** speed, delay and drop math run on a controllable clock and a seeded random source. Cover throughput at a set rate, one-way delay per direction, the connection round trip, the backoff on consecutive drops, and 100% loss never completing.
- **Bypass identity:** with the switch off, and with a dial on Off, the API and the avatar download get exactly `AppContainer.httpClient` (no added interceptor), the restore and refresh call always does, and the printer path gets exactly its original factory. The avatar download (`loadPhoto`) is also tested end to end: direct while off, conditioned while signed in and on.
- **Integration with MockWebServer:**
  - a conditioned call is measurably slower by the configured delay;
  - 100% Loss ends in the client's own timeout, not an instant failure;
  - switching off mid-way: the next call goes direct and conditioned pooled connections are released;
  - no body reads move to the caller's thread.
- **Printer path:** with the existing `FakePrinter` loopback, a wrapped factory still delegates to the network-bound factory it was given, and a Very Bad Network printer session trips the printer code's own timeouts.
- **Turn-off rules:** each sign-out path, a start-up restore with no session, and Developer mode off each leave the switch off and persisted. Sign-out under 100% Loss finishes promptly and the portal receives `/auth/logout`. On a controllable clock: the switch turns off at exactly two hours, a preset change doesn't extend it, a restart past two hours starts with it off, and a clock moved backward counts as expired. A portal Clear Setup and a move-lock setup drop each turn it off while the person stays signed in. A restart on 100% Loss keeps the session and the switch. Reset app leaves the switch as it was.
- **UI (Compose):**
  - the section shows only for a developer with Developer mode on;
  - Custom shows the six boxes and remembers them;
  - the chip and footer item appear only while the switch is on;
  - the Time Clock's header shows the chip while signed in and on, without taking width from the wordmark on a 320 dp handheld, and a Time Clock station never shows it;
  - tapping the chip, in the top bar or on the Time Clock, opens Settings › Developer;
  - the Drop boxes take a comma as the decimal point.
- **Removal guard:** a test lists every file outside the Internet Test package that refers to it, with its number of marked lines, and fails if that list or a count changes, or if `REMOVAL.md` no longer agrees with it (§8).

Live check on the emulator (recipe in the Android label printing memory):
- sync and the outbox with Internet on 3G, Very Bad Network and 100% Loss;
- a print to the fake Zebra with Local network on Very Bad Network;
- sign out, then confirm the switch is off.

## 8. Built to be removed (Jimmy's requirement)

Jimmy: "once we prove this app out we will remove the testing code and I want to make sure it is seemless and doesn't cause problems."

- **One package.** Everything lives in one package of its own, `com.serversherpa.kiosk.nettest`. That covers presets, pacing, the interceptor, the socket factory wrapper, settings, the Developer section, and the chip and footer item. Its Android-free math may live in a matching `core/nettest/` subpackage if `CorePurityTest` needs that. *(My call.)*
- **Few named touch points outside the package (as built).** Each carries the comment marker `// INTERNET-TEST`, so `grep -rn "INTERNET-TEST"` finds them all. Nine files, 25 marked lines:
  1. `AppContainer.kt` (7): two imports; build the controller (`val internetTest`); start it with the auth state, Developer mode and `Heartbeat.setupCleared`; pass the route provider to `OkHttpKioskApi` and the setup-drop hook to `MoveSetupGuard`; and one call at the start of `logout()`. Every sign-out, the must-change-password notice's included, goes through `logout()`, so that one line covers them all; the watcher on the auth state lives inside the package.
  2. `data/api/OkHttpKioskApi.kt` (2) and `ui/screens/timeclock/screens/ConfirmPerson.kt` (2, in `loadPhoto`): take their client from the route provider. `SessionStore` and `OkHttpStationApi` stay on the original client and need no change (§4.1).
  3. `data/printer/NetworkZebra.kt` (2): `zebraSession()`, which every printer session and scan probe goes through, takes its socket factory through the router.
  4. `ui/screens/settings/DeveloperPanel.kt` (2): one call to the Internet Test section.
  5. `ui/shell/KioskShell.kt` (4): the chip and the footer item.
  6. `ui/screens/timeclock/screens/TcShell.kt` (2) and `ui/screens/timeclock/TimeclockScreen.kt` (2): the Time Clock header's chip, and `NetTestChipNavigation(nav)`, which answers the chip's tap. The chip asks for Settings › Developer and the screen that has the NavHostController answers, so no callback is threaded through `TimeclockFlowScreen`, `TcShell` and `TcHeader`.
  7. `data/auth/MoveSetupGuard.kt` (2): the setup-drop hook. The portal's Clear Setup needs no line of its own: the controller listens to `Heartbeat.setupCleared` (item 1).
  8. `KioskPrefs` needed no change: the setting lives in the package, under its own DataStore key.
- **Removal steps.** A `REMOVAL.md` inside the package lists them: delete the package, delete the marked lines, run the suite. The guard test in §7 keeps the list of touch points honest while the code lives.
- **Removal shape (as built).** Each added fragment sits alone on its own marked line, so "delete every marked line" is the whole removal and nothing is restored by hand. That is why `OkHttpKioskApi` and `MoveSetupGuard` take their hooks as constructor parameters with defaults (`route = { it }`, `onDropped = {}`), and why the `.let(...)` steps in `execute()`, `zebraSession()` and `loadPhoto()` each have a line to themselves. A test checks the shape of every marked line, so a line that mixes original code with Internet Test code fails. Another pins each file's number of marked lines, because some of them (`route`, `.let(route)`, `onDropped`) name nothing of Internet Test's, and a marker lost there would otherwise go unnoticed.
- **Two kept items.** Two fixes made along the way are not Internet Test and stay after removal, unmarked: the top bar's separator `" · "` in `KioskShell` never wraps (`maxLines = 1, softWrap = false`, with its 320 dp `KioskShellTest`), and the shared test rule `NativeFontsSettled.kt`.
- **Dry run.** Deleting both packages and every marked line from this branch was tried in a throwaway worktree, most recently on the final fix wave (25 lines in nine files): the unit tests and `assembleDebug` pass. `REMOVAL.md` records the runs.
- **Leftover setting.** After removal, the saved DataStore value is simply never read again, which is harmless. *(My call: no migration is needed.)*
- **What the bypass guarantees.** Because "off" means the original objects, removal can't change how the app behaves for crews.

## 9. Left to the builder

- The pacing algorithm (a token bucket or similar), the chunk size, and the backoff curve (start near TCP's 1 s and double).
- Where pure code lives, as long as `CorePurityTest` passes.
- The exact Compose layout, matched to the approved mockup and the app's tokens.
- How the chip's tap navigates (the existing Settings route with the Developer tab selected).
- The DataStore key name (suggested `ss.kiosk.netTest`).

## 10. Decision log

| Decision | Who |
|---|---|
| Two dials: Internet and Local network | Jimmy |
| Presets like Apple's | Jimmy |
| Apple's list is enough for now | Jimmy |
| Kiosk app only | Jimmy |
| Dual approach: on means conditioned, off means existing routes untouched | Jimmy |
| Removal must be seamless | Jimmy |
| Same build for everyone; the tool ships in all builds | Jimmy |
| Turns off automatically at sign-out | Jimmy |
| Sign-in and pairing aren't conditioned | Jimmy |
| Warning: top-bar chip plus footer item (option B) | Jimmy |
| Turns off two hours after it was switched on | Jimmy |
| A portal Clear Setup or move-lock setup drop turns it off | Jimmy |
| Build on `android-labels` so both dials work now (it has since merged; built on main) | Claude |
| An Off preset on both dials | Claude |
| Developer mode off also turns the switch off | Claude |
| One package, `// INTERNET-TEST` markers, `REMOVAL.md`, a guard test | Claude |
| Drop modeled as TCP-like stalls and timeouts, never instant errors | Claude |
| Conditions only while signed in; restore, sign-in and pairing go direct | Claude |
| Switch turns off at the start of sign-out, before its portal calls | Claude |
| The Time Clock avatar download is conditioned too | Claude |
| The Time Clock station's own calls (`OkHttpStationApi`, signed out) stay direct under the signed-in rule | Claude |
| Removal is "delete every marked line", with each added fragment alone on its marked line and a test on that shape | Claude |
| Reset app leaves Internet Test alone | Claude |
| The Time Clock's header carries the chip too, above the date, in the light-surface amber; its tap goes through `NetTestChipNavigation` | Claude |
| "Signed in only" is a level: a switch found on while signed out turns off at once | Claude |
| A switch-on time below zero counts as expired | Claude |
| The Drop boxes take a comma as the decimal point | Claude |
| A Very Bad Network local link hiding printers from Scan is documented here, with no copy in the app | Claude |
| The two-hour clock starts at switch-on, survives restarts, isn't extended by changes, and counts a backward clock as expired | Claude |
| The section shows the time it will turn off | Claude |
| Preset values from Apple's `NetworkProfiles.plist` (the nine Network Link Conditioner profiles) | Claude |
