# Removing Internet Test

Internet Test is the developer-only network link conditioner in Settings ›
Developer. It was built to come out cleanly. When it has done its job, removal
is two deletions and one build. Nothing is restored by hand.

Design: `docs/superpowers/specs/2026-10-21-android-internet-test-design.md`
(section 8).

## Steps

Run these from `Android_Kiosk_App/`.

1. **Delete the two packages** (this file goes with the first one):

   ```
   rm -r app/src/main/java/com/serversherpa/kiosk/nettest app/src/test/java/com/serversherpa/kiosk/nettest
   ```

2. **Delete every line marked `// INTERNET-TEST`.** Each marked line holds only
   Internet Test code, on a line of its own, so deleting the whole line is the
   whole change. There are 21 of them in the seven files listed below:

   ```
   grep -rl "// INTERNET-TEST" app/src | xargs sed -i '' '/\/\/ INTERNET-TEST/d'
   ```

   (That is the macOS `sed`. With GNU `sed`, use `sed -i` with no `''`.)

3. **Check nothing is left.** This prints nothing:

   ```
   git grep -n -i "nettest\|INTERNET-TEST" -- .
   ```

4. **Build and test:**

   ```
   export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
   export ANDROID_HOME=~/Library/Android/sdk
   ./gradlew testDebugUnitTest assembleDebug
   ```

## What stays

Two changes made along the way are not Internet Test. They fix problems that
were found while building it, and nothing marks them. Keep them:

- **The top bar's separator never wraps.** In `ui/shell/KioskShell.kt`, the
  `" · "` Text between the kiosk name and the person has
  `maxLines = 1, softWrap = false`. Without it a long kiosk name stretches the
  bar on a 320 dp device. Its test is `aLongKioskNameNeverStretchesTheBar` in
  `KioskShellTest` (320 dp, real fonts).
- **`app/src/test/java/com/serversherpa/kiosk/NativeFontsSettled.kt`**, the
  shared test rule that waits for native fonts. `KioskShellTest` uses it.

The deletion in step 2 doesn't touch either one.

## The touch points

Outside the two packages, the app refers to Internet Test in exactly these
seven files (paths under `app/src/main/java/com/serversherpa/kiosk/`). Each
added fragment sits alone on its own marked line, so the original code on the
lines around it is the same with or without it.

| File | Marked lines | What they do |
|---|---|---|
| `AppContainer.kt` | 7 | Two imports; `val internetTest`; `route = InternetTestRoutes::portal,` (an argument to `OkHttpKioskApi`); `internetTest.start(...)`; `onDropped = internetTest::onSetupDropped,` (an argument to `MoveSetupGuard`); `internetTest.beforeSignOut()` at the start of `logout()` |
| `data/api/OkHttpKioskApi.kt` | 2 | The `route` constructor parameter (default `{ it }`) and the `.let(route)` step in `execute()` |
| `data/auth/MoveSetupGuard.kt` | 2 | The `onDropped` constructor parameter (default `{}`) and the `onDropped()` call after a setup drop |
| `data/printer/NetworkZebra.kt` | 2 | An import and the `.let(InternetTestRoutes::local)` step in `zebraSession()` |
| `ui/screens/timeclock/screens/ConfirmPerson.kt` | 2 | An import and the `.let(InternetTestRoutes::portal)` step in `loadPhoto()` (the Time Clock photo download) |
| `ui/screens/settings/DeveloperPanel.kt` | 2 | An import and the `InternetTestSection()` call |
| `ui/shell/KioskShell.kt` | 4 | Two imports; the `NetTestChip(...)` in the top bar; the "Net test" footer item |

With the marked lines gone, `zebraSession()` again calls
`socketFactory.createSocket()` and `execute()` again uses `client`. The
`.let(...)` steps were the only thing between them and the original objects,
which is also why, with the switch off, Internet Test changes nothing: it
hands back the very same client and socket factory.

Deleting the lines leaves a few cosmetic seams. All of it compiles and behaves
as before; join the lines if you like the tidier form: `executeCall(client` and
`, request)` in `OkHttpKioskApi.execute()`; `socketFactory` and `.createSocket()`
in `zebraSession()`; `client` and `.newCall(...)` in `loadPhoto()`; and the
`OkHttpKioskApi(httpClient, config, session,` call and `MoveSetupGuard(...)`
call in `AppContainer.kt`, whose closing `)` now sits on its own line after a
trailing comma.

## Leftover data

The switch and its settings were saved in DataStore under `ss.kiosk.netTest`.
After removal nothing reads that value, so it stays on the device and does no
harm. No migration is needed.

## While the feature lives

`RemovalGuardTest` fails if any file outside the packages refers to Internet
Test and isn't in the table above (add it to the table on purpose), or if a
line there refers to it without the marker. `MarkedLinesAreDeletableTest`
fails if a marked line mixes original code with Internet Test code, which is
what would make step 2 delete something it shouldn't.

## Dry runs

Both were run in a throwaway worktree that was thrown away afterward. The
second used the commands above exactly as written.

- **2026-10-22, before the main merge** (base `798ba91b`): both packages and
  every marked line deleted. 574 tests passed and `assembleDebug` built.
- **2026-10-22, after the main merge** (base `cc7b3288`, Time Clock station
  and database v3 merged in): 21 marked lines and both packages deleted,
  `git grep` found nothing left. 716 tests passed and `assembleDebug` built.
  (The first attempt had one failure, `RfidPanelTest.restoreDefaultsPutsEverythingBack`,
  which expected a power of 27 and read 9. It passes on its own and the whole
  suite passed on the rerun. It looks like a timing flake in that Compose
  test, and it doesn't touch Internet Test code.)
