# Android kiosk: move-password sign-in + QR scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Android kiosk's Move password sign-in, a QR icon inside the password field opens the kiosk's own camera (QR only). The first QR read is submitted as the move password, and move-password sign-in actually works (today it is a stub that says "not available yet").

**Architecture:** Port the web kiosk's move sign-in (`kiosk/src/lib/api.ts` `moveLoginRequest`, `kiosk/src/auth/KioskAuthContext.tsx` `loginWithMovePassword` + move-lock effect, `kiosk/src/pages/Login.tsx` `handleMove` + `MOVE_ERROR_MESSAGES`, `kiosk/src/layout/KioskShell.tsx` footer) into the Kotlin app: `KioskApi.moveLogin` → `KioskAuth.loginWithMovePassword` → `LoginViewModel.submitMove`. A small `MoveSetupGuard` drops a saved Kiosk Setup that belongs to a different move. The QR button reuses `CameraScanSheet` with a new `qrOnly` mode.

**Tech Stack:** Kotlin, Jetpack Compose (Material3), kotlinx.serialization, OkHttp + MockWebServer, DataStore Preferences, CameraX + ML Kit barcode scanning, JUnit4 + kotlinx-coroutines-test + Robolectric (`@Config(sdk = [34])`).

## Global Constraints

- Work only in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/android-login` (branch `android-login`). The Android project is `Android_Kiosk_App/`.
- Gradle needs: `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`, then run from `Android_Kiosk_App/`.
- Run test suites in the foreground (never `run_in_background`). `RfidPanelTest` is known flaky under CPU load (an emulator running); if only it fails, rerun it alone with `--tests '*RfidPanelTest*' --rerun-tasks`.
- American English in all copy, comments and docs (color, recognize, canceled…).
- Never `git add -A` at the repo root; stage `Android_Kiosk_App/...` paths explicitly.
- Every commit message ends with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Match surrounding code style: dense one-line Kotlin, short doc comments that say why, test names as sentences (`@Test fun moveLoginPostsThePassword()`).
- Server contract (already on main, do not change the server): `POST /kiosk/move-login`, unauthenticated, JSON body `{"password": "<string>"}` (1–200 chars; the server trims). 200 returns the normal `SessionOut` plus `"kiosk_move": {"initiative_id": "<uuid>", "name": "<move name>"}`. Errors: 401 `invalid_move_password`, 401 `move_not_active`, 403 `kiosk_not_allowed`, 429 `move_login_rate_limited` (all as `{"detail": {"code": ...}}`).
- Move-form copy, verbatim from the web kiosk:
  - blank entry: `Enter the move password.`
  - `invalid_move_password` → `That move password isn't right.`
  - `move_not_active` → `That move password isn't active.`
  - `move_login_rate_limited` → `Too many tries. Wait a few minutes.`
  - `kiosk_not_allowed` (move form only) → `That move can't sign in to kiosks right now. Ask a coordinator.`
  - `network` → `Can't reach the server. Check the kiosk's network connection.`
  - anything else → `Login failed. Please try again.`

---

### Task 1: The move-login call, the session's move, and `KioskAuth.loginWithMovePassword`

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/model/Session.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/api/KioskApi.kt` (the auth block near `suspend fun login`, line ~28)
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/api/OkHttpKioskApi.kt` (after `override suspend fun login`, line ~113)
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/auth/KioskAuth.kt`
- Modify: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/data/FakeKioskApi.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/data/api/OkHttpKioskApiAuthTest.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/data/auth/KioskAuthTest.kt`

**Interfaces:**
- Produces:
  - `@Serializable data class KioskMove(val initiative_id: String, val name: String)` in `core/model/Session.kt`
  - `SessionData.kiosk_move: KioskMove? = null` (new last field)
  - `@Serializable data class MoveLoginIn(val password: String)` in `core/model/Session.kt`
  - `KioskApi.moveLogin(password: String): SessionData` (stores the session like `login`)
  - `KioskAuth.loginWithMovePassword(password: String): SessionData` (sets `AuthState.Authed`, pending sign-in `LoginMethod.PASSWORD`)
  - `AuthState.Authed.kioskMove: KioskMove?` getter
  - `FakeKioskApi.moveLoginResult: (String) -> SessionData` (default throws `ApiError(401, "invalid_move_password")`), records `"moveLogin"` in `calls`, and the last password in `moveLoginPasswords`
  - `fakeSession(..., kioskMove: KioskMove? = null)` new optional parameter

- [ ] **Step 1: Write the failing tests**

Append to `OkHttpKioskApiAuthTest` (inside the class):

```kotlin
    @Test fun moveLoginPostsThePasswordAndStoresTheLockedSession() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(jsonResponse(200, SESSION_JSON.dropLast(1) + ""","kiosk_move":{"initiative_id":"m1","name":"Dallas Move"}}"""))
            val s = h.api.moveLogin("orange-kayak-42")
            val req = h.server.takeRequest()
            assertEquals("/kiosk/move-login", req.path)
            assertEquals("POST", req.method)
            assertEquals("""{"password":"orange-kayak-42"}""", req.body.readUtf8())
            assertEquals("m1", s.kiosk_move?.initiative_id)
            assertEquals("Dallas Move", s.kiosk_move?.name)
            assertEquals("tok1", h.session.accessToken())
        }
    }

    @Test fun moveLoginErrorsCarryTheirCode() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(jsonResponse(429, """{"detail":{"code":"move_login_rate_limited"}}"""))
            try { h.api.moveLogin("x"); fail("expected ApiError") } catch (e: ApiError) {
                assertEquals(429, e.status); assertEquals("move_login_rate_limited", e.code)
            }
        }
    }

    @Test fun anOrdinarySessionHasNoMove() = runBlocking {
        ApiHarness(tmp.root).use { h ->
            h.server.enqueue(sessionResponse())
            assertEquals(null, h.api.login("a@b.c", "pw").kiosk_move)
        }
    }
```

`SESSION_JSON` is the top-level `val` in `ApiTestSupport.kt` (a JSON object literal ending in `}`); if it is `private`, make it `internal`. Check how `SESSION_JSON` ends before relying on `dropLast(1)`: it must end with the object's closing `}` and no trailing whitespace; if it has trailing whitespace use `SESSION_JSON.trimEnd().dropLast(1)`.

Append to `KioskAuthTest` (inside the class):

```kotlin
    @Test fun moveLoginSignsInLockedToTheMoveAsAPasswordSignIn() = runTest {
        val move = com.serversherpa.kiosk.core.model.KioskMove("m1", "Dallas Move")
        val api = FakeKioskApi().apply { moveLoginResult = { fakeSession(kioskMove = move) } }
        val auth = KioskAuth(api, FakeRefresher(), testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.loginWithMovePassword("orange-kayak-42")
        assertEquals(listOf("orange-kayak-42"), api.moveLoginPasswords)
        val authed = auth.state.value as AuthState.Authed
        assertEquals(move, authed.kioskMove)
        // The heartbeat only knows password | link; a move sign-in counts as password (as on the web).
        assertEquals(LoginMethod.PASSWORD, auth.takePendingSignIn())
    }

    @Test fun aFailedMoveLoginLeavesTheStateAlone() = runTest {
        val auth = KioskAuth(FakeKioskApi(), FakeRefresher(), testIdentity(tmp.root, backgroundScope), backgroundScope)
        auth.restore()   // FakeRefresher returns null: Anon
        try { auth.loginWithMovePassword("nope"); fail("expected ApiError") } catch (e: ApiError) { assertEquals("invalid_move_password", e.code) }
        assertEquals(AuthState.Anon, auth.state.value)
        assertNull(auth.takePendingSignIn())
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `Android_Kiosk_App/`): `./gradlew testDebugUnitTest --tests '*OkHttpKioskApiAuthTest*' --tests '*KioskAuthTest*'`
Expected: compilation FAILS (`moveLogin`, `kiosk_move`, `loginWithMovePassword`, `moveLoginResult` unresolved).

- [ ] **Step 3: Implement**

`core/model/Session.kt` — add after `UiPreferences`, and the new field last in `SessionData`, and the request body after `LoginIn`:

```kotlin
/** The move a move-password session is locked to (`kiosk_move` on the session). */
@Serializable
data class KioskMove(val initiative_id: String, val name: String)
```

```kotlin
    val max_rank: Int = 0,
    /** Set only on a move-password sign-in: the session works on this move alone. */
    val kiosk_move: KioskMove? = null,
)
```

```kotlin
@Serializable
data class MoveLoginIn(val password: String)
```

Update the `SessionData` doc comment to: `` /** `SessionOut` — what /auth/login, /kiosk/move-login, /auth/refresh, and an approved pair poll return. */ ``

`data/api/KioskApi.kt` — directly under `suspend fun login(email: String, password: String): SessionData`:

```kotlin
    /** Sign in with a move's kiosk password (no person account involved); stores the session like [login]. */
    suspend fun moveLogin(password: String): SessionData
```

`data/api/OkHttpKioskApi.kt` — directly under `override suspend fun login(...)`:

```kotlin
    override suspend fun moveLogin(password: String): SessionData {
        val resp = plain { url(apiUrl("/kiosk/move-login")).post(jsonBody(MoveLoginIn.serializer(), MoveLoginIn(password))) }
        return parse(resp, SessionData.serializer()).also { session.store(it) }
    }
```

(Add `import com.serversherpa.kiosk.core.model.MoveLoginIn` if the file imports models one by one; if it uses `core.model.*`, nothing to add.)

`data/auth/KioskAuth.kt`:
- In `AuthState.Authed`, add `val kioskMove get() = session.kiosk_move`.
- Change the comment `// Set only by login()/completePair(), ...` to `// Set only by login()/loginWithMovePassword()/completePair(), ...`.
- Under `login(...)` add:

```kotlin
    /** A move-password sign-in. The heartbeat's login_method only knows password | link,
     *  and a move password is a password as far as device registration goes (as on the web). */
    suspend fun loginWithMovePassword(password: String): SessionData {
        val data = api.moveLogin(password)
        pendingSignIn = LoginMethod.PASSWORD
        _state.value = AuthState.Authed(data)
        return data
    }
```

`test/.../data/FakeKioskApi.kt`:
- Fields, under `loginResult`:

```kotlin
    var moveLoginResult: (String) -> SessionData = { throw ApiError(401, "invalid_move_password") }
    val moveLoginPasswords = ArrayList<String>()
```

- Override, under `override suspend fun login`:

```kotlin
    override suspend fun moveLogin(password: String): SessionData { calls += "moveLogin"; moveLoginPasswords += password; return moveLoginResult(password) }
```

- `fakeSession` gains `kioskMove: KioskMove? = null` as its last parameter and passes `kiosk_move = kioskMove` (the file imports `core.model.*`, so `KioskMove` resolves).

Any other `KioskApi` implementation in `src/test` must compile too: run `grep -rn ": KioskApi\b\|KioskApi {" Android_Kiosk_App/app/src/test` — every class listed that implements the interface directly (not via `FakeKioskApi`) needs an `override suspend fun moveLogin(password: String): SessionData = throw ApiError(401, "invalid_move_password")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./gradlew testDebugUnitTest --tests '*OkHttpKioskApiAuthTest*' --tests '*KioskAuthTest*'`
Expected: BUILD SUCCESSFUL, all pass.

- [ ] **Step 5: Commit**

```bash
git add Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/model/Session.kt Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/api/KioskApi.kt Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/api/OkHttpKioskApi.kt Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/auth/KioskAuth.kt Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/data
git commit -m "feat(kiosk-android): move-password sign-in call — POST /kiosk/move-login, the session's kiosk_move, KioskAuth.loginWithMovePassword

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The move lock on the saved Kiosk Setup, and the footer's Move

**Files:**
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/auth/MoveSetupGuard.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/AppContainer.kt` (`fun start()`, next to `SessionCoordinator(...).start()`)
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/shell/KioskShell.kt` (footer, line ~149)
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/data/auth/MoveSetupGuardTest.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/shell/KioskShellTest.kt`

**Interfaces:**
- Consumes (Task 1): `AuthState.Authed.kioskMove: KioskMove?`, `KioskAuth.loginWithMovePassword`, `fakeSession(kioskMove = ...)`, `KioskMove(initiative_id, name)`.
- Consumes (existing): `KioskPrefs.setupSelection: Flow<KioskSetupSelection?>`, `KioskPrefs.setSetupSelection(KioskSetupSelection?)`, `KioskPrefs.setSetupState(SetupState)`, `SetupState.INCOMPLETE`, `KioskSetupSelection(initiativeId, initiativeName, siteId, siteName, siteRole, scanStatus, scanLabel)`.
- Produces: `class MoveSetupGuard(auth: StateFlow<AuthState>, prefs: KioskPrefs, scope: CoroutineScope) { fun start() }`.

Why (from the web kiosk): a move-password session works only on its own move. A setup saved for another move (an earlier sign-in) would keep driving the screens and footer, and every call naming it would be refused (`move_locked`) — so drop it and send the crew back to Kiosk Setup. Keyed on the move, so it runs once per sign-in (and on a cookie restore).

- [ ] **Step 1: Write the failing tests**

Create `MoveSetupGuardTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.auth

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.model.KioskMove
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class MoveSetupGuardTest {
    @get:Rule val tmp = TemporaryFolder()

    private val setupA = KioskSetupSelection("mA", "Move A", "s1", "Dock 4", "source", "pre_stage", "Pre-stage")

    private suspend fun TestScope.prefsWith(selection: KioskSetupSelection?): KioskPrefs {
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "g${System.nanoTime()}.preferences_pb") })
        prefs.setSetupSelection(selection)
        prefs.setSetupState(if (selection == null) SetupState.INCOMPLETE else SetupState.COMPLETE)
        return prefs
    }

    @Test fun aMoveSessionDropsASetupSavedForAnotherMove() = runTest {
        val prefs = prefsWith(setupA)
        val auth = MutableStateFlow<AuthState>(AuthState.Anon)
        MoveSetupGuard(auth, prefs, backgroundScope).start()
        auth.value = AuthState.Authed(fakeSession(kioskMove = KioskMove("mB", "Move B")))
        advanceUntilIdle()
        assertNull(prefs.setupSelection.first())
        assertEquals(SetupState.INCOMPLETE, prefs.setupState.first())
    }

    @Test fun aMoveSessionKeepsItsOwnMovesSetup() = runTest {
        val prefs = prefsWith(setupA)
        val auth = MutableStateFlow<AuthState>(AuthState.Authed(fakeSession(kioskMove = KioskMove("mA", "Move A"))))
        MoveSetupGuard(auth, prefs, backgroundScope).start()
        advanceUntilIdle()
        assertEquals(setupA, prefs.setupSelection.first())
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())
    }

    @Test fun anOrdinarySessionLeavesTheSetupAlone() = runTest {
        val prefs = prefsWith(setupA)
        val auth = MutableStateFlow<AuthState>(AuthState.Authed(fakeSession()))
        MoveSetupGuard(auth, prefs, backgroundScope).start()
        advanceUntilIdle()
        assertEquals(setupA, prefs.setupSelection.first())
    }
}
```

Append to `KioskShellTest` (inside the class; reuse the file's existing imports and the way the other tests build `c` and call `compose.setContent` — copy the body of `barAndFooterShowContextSignedOut` for the setContent line):

```kotlin
    @Test fun aMoveSessionWithNoSetupYetShowsItsMoveInTheFooter() {
        val c = testContainer()
        c.auth.completePair(fakeSession(kioskMove = com.serversherpa.kiosk.core.model.KioskMove("m1", "Dallas Move")))
        // ...same compose.setContent { ... KioskShell(...) { } } line as barAndFooterShowContextSignedOut...
        compose.onNodeWithText("Dallas Move", substring = true).assertIsDisplayed()
    }
```

(`completePair` is only used here to put an `Authed` session with a move into the state; it is the existing test idiom in this file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./gradlew testDebugUnitTest --tests '*MoveSetupGuardTest*' --tests '*KioskShellTest*'`
Expected: compile FAILS (`MoveSetupGuard` unresolved); after Step 3's guard only, the shell test still FAILS (no "Dallas Move" node).

- [ ] **Step 3: Implement**

Create `data/auth/MoveSetupGuard.kt`:

```kotlin
package com.serversherpa.kiosk.data.auth

import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * A move-password session works only on its own move (the web kiosk's move-lock effect in
 * KioskAuthContext.tsx). A setup saved for another move by an earlier sign-in would keep
 * driving the screens and the footer, and every call naming it would be refused
 * (move_locked), so it is dropped and the crew goes back through Kiosk Setup. Keyed on the
 * move, so it runs once per sign-in and once on a cookie restore.
 */
class MoveSetupGuard(
    private val auth: StateFlow<AuthState>,
    private val prefs: KioskPrefs,
    private val scope: CoroutineScope,
) {
    fun start() {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            auth.map { (it as? AuthState.Authed)?.kioskMove?.initiative_id }.distinctUntilChanged().filterNotNull().collect { locked ->
                val saved = prefs.setupSelection.first()
                if (saved != null && saved.initiativeId != locked) {
                    prefs.setSetupSelection(null)
                    prefs.setSetupState(SetupState.INCOMPLETE)
                }
            }
        }
    }
}
```

`AppContainer.kt` `start()` — directly under `SessionCoordinator(auth, heartbeat, foreground, scope).start()`:

```kotlin
        MoveSetupGuard(auth.state, prefs, scope).start()
```

(add `import com.serversherpa.kiosk.data.auth.MoveSetupGuard`).

`ui/shell/KioskShell.kt` footer — replace

```kotlin
            setup?.let { FootItem("Move", it.initiativeName); FootItem("Site", it.siteName); FootItem("Scan", it.scanLabel) }
```

with

```kotlin
            setup?.let { FootItem("Move", it.initiativeName); FootItem("Site", it.siteName); FootItem("Scan", it.scanLabel) }
            // A move-password session names its move before Kiosk Setup has run (as on the web).
                ?: authed?.kioskMove?.let { FootItem("Move", it.name) }
```

and extend the comment above it: `// What move this kiosk is set to, and nothing else.` stays; no other change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./gradlew testDebugUnitTest --tests '*MoveSetupGuardTest*' --tests '*KioskShellTest*'`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/auth/MoveSetupGuard.kt Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/AppContainer.kt Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/shell/KioskShell.kt Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/data/auth/MoveSetupGuardTest.kt Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/shell/KioskShellTest.kt
git commit -m "feat(kiosk-android): a move-password session drops a setup saved for another move; the footer names the move

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `LoginViewModel` signs in with the move password (typed or scanned)

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/login/LoginViewModel.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/screens/login/LoginViewModelTest.kt`

**Interfaces:**
- Consumes (Task 1): `KioskAuth.loginWithMovePassword(password: String): SessionData`, `FakeKioskApi.moveLoginResult`, `FakeKioskApi.moveLoginPasswords`, `fakeSession(kioskMove = ...)`.
- Produces (Task 4 relies on these exact names):
  - `LoginUi.moveError: String?` (replaces `moveNotice: Boolean`, which is removed), `LoginUi.moveLoading: Boolean`
  - `LoginViewModel.submitMove(onDone: () -> Unit)` (was `submitMove()`)
  - `LoginViewModel.submitScannedMove(value: String, onDone: () -> Unit)` — fills the field with the scan and submits it
  - `val MOVE_ERROR_MESSAGES: Map<String, String>` (top-level, next to `ERROR_MESSAGES`)

- [ ] **Step 1: Write the failing tests**

In `LoginViewModelTest`, delete `movePasswordIsAPlaceholder` and add:

```kotlin
    @Test fun aBlankMovePasswordIsRejectedLocally() = runTest {
        val api = FakeKioskApi()
        val vm = vm(api)
        vm.setView(LoginView.MOVE); vm.setMovePassword("   ")
        var done = false
        vm.submitMove { done = true }; runCurrent()
        assertEquals("Enter the move password.", vm.state.value.moveError)
        assertTrue(api.moveLoginPasswords.isEmpty())
        assertEquals(false, done)
    }

    @Test fun aMovePasswordSignsIn() = runTest {
        val api = FakeKioskApi().apply { moveLoginResult = { fakeSession(kioskMove = com.serversherpa.kiosk.core.model.KioskMove("m1", "Dallas Move")) } }
        val vm = vm(api)
        vm.setView(LoginView.MOVE); vm.setMovePassword("orange-kayak-42")
        var done = false
        vm.submitMove { done = true }
        assertTrue(vm.state.value.moveLoading)
        runCurrent()
        assertEquals(listOf("orange-kayak-42"), api.moveLoginPasswords)
        assertTrue(done)
        assertEquals("", vm.state.value.movePassword)
        assertEquals(false, vm.state.value.moveLoading)
        assertEquals(null, vm.state.value.moveError)
    }

    @Test fun moveErrorCodesMapToTheMoveFormsCopy() = runTest {
        val api = FakeKioskApi()
        val vm = vm(api)
        vm.setView(LoginView.MOVE)
        val cases = listOf(
            ApiError(401, "invalid_move_password") to "That move password isn't right.",
            ApiError(401, "move_not_active") to "That move password isn't active.",
            ApiError(429, "move_login_rate_limited") to "Too many tries. Wait a few minutes.",
            ApiError(403, "kiosk_not_allowed") to "That move can't sign in to kiosks right now. Ask a coordinator.",
            ApiError(0, "network") to "Can't reach the server. Check the kiosk's network connection.",
            ApiError(500, "unknown_error") to "Login failed. Please try again.",
        )
        for ((err, copy) in cases) {
            api.moveLoginResult = { throw err }
            vm.setMovePassword("pw-123456"); vm.submitMove {}; runCurrent()
            assertEquals(copy, vm.state.value.moveError)
            assertEquals("", vm.state.value.movePassword)   // cleared after a failure, as on the web
            assertEquals(false, vm.state.value.moveLoading)
        }
    }

    @Test fun aScannedCodeIsSubmittedAsTheMovePassword() = runTest {
        val api = FakeKioskApi().apply { moveLoginResult = { fakeSession() } }
        val vm = vm(api)
        vm.setView(LoginView.MOVE)
        var done = false
        vm.submitScannedMove("QR-VALUE-9") { done = true }; runCurrent()
        assertEquals(listOf("QR-VALUE-9"), api.moveLoginPasswords)
        assertTrue(done)
    }

    @Test fun typingClearsTheMoveError() = runTest {
        val vm = vm(FakeKioskApi())
        vm.setView(LoginView.MOVE); vm.submitMove {}; runCurrent()
        assertEquals("Enter the move password.", vm.state.value.moveError)
        vm.setMovePassword("a")
        assertEquals(null, vm.state.value.moveError)
    }

    @Test fun aSecondSubmitWhileSigningInIsIgnored() = runTest {
        val api = FakeKioskApi().apply { moveLoginResult = { fakeSession() } }
        val vm = vm(api)
        vm.setView(LoginView.MOVE); vm.setMovePassword("pw-123456")
        vm.submitMove {}; vm.submitScannedMove("other") {}
        runCurrent()
        assertEquals(listOf("pw-123456"), api.moveLoginPasswords)
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./gradlew testDebugUnitTest --tests '*LoginViewModelTest*'`
Expected: compile FAILS (`moveError`, `moveLoading`, `submitScannedMove`, `submitMove(onDone)` unresolved).

- [ ] **Step 3: Implement**

In `LoginViewModel.kt`:

`LoginUi` — replace `val movePassword: String = "", val moveNotice: Boolean = false,` with:

```kotlin
    val movePassword: String = "", val moveError: String? = null, val moveLoading: Boolean = false,
```

Under `ERROR_MESSAGES` add:

```kotlin
/** The move form's own wording (kiosk/src/pages/Login.tsx MOVE_ERROR_MESSAGES): kiosk_not_allowed
 *  on a move sign-in is about the move's kiosk identity, not a person's account. */
val MOVE_ERROR_MESSAGES = ERROR_MESSAGES + mapOf(
    "invalid_move_password" to "That move password isn't right.",
    "move_not_active" to "That move password isn't active.",
    "move_login_rate_limited" to "Too many tries. Wait a few minutes.",
    "kiosk_not_allowed" to "That move can't sign in to kiosks right now. Ask a coordinator.",
)
```

Replace `setView` / `setMovePassword`:

```kotlin
    fun setView(v: LoginView) = _state.update { it.copy(view = v, error = null, moveError = null) }
    fun setMovePassword(v: String) = _state.update { it.copy(movePassword = v, moveError = null) }
```

Replace the stub `/** Move passwords have no backend yet. */ fun submitMove() = ...` with:

```kotlin
    /** Sign in with the move password in the field. The server trims it; a blank entry never leaves the kiosk. */
    fun submitMove(onDone: () -> Unit) {
        val s = _state.value
        if (s.moveLoading) return
        if (s.movePassword.isBlank()) { _state.update { it.copy(moveError = "Enter the move password.") }; return }
        _state.update { it.copy(moveLoading = true, moveError = null) }
        scope.launch {
            try {
                auth.loginWithMovePassword(s.movePassword)
                _state.update { it.copy(moveLoading = false, movePassword = "") }
                onDone()
            } catch (e: Exception) {
                val code = (e as? ApiError)?.code ?: "network"
                _state.update { it.copy(moveLoading = false, movePassword = "", moveError = MOVE_ERROR_MESSAGES[code] ?: "Login failed. Please try again.") }
            }
        }
    }

    /** A QR code read by the camera is the move password: fill the field with it and sign in. */
    fun submitScannedMove(value: String, onDone: () -> Unit) {
        if (_state.value.moveLoading) return
        setMovePassword(value)
        submitMove(onDone)
    }
```

Note: `ERROR_MESSAGES + mapOf(...)` — later entries win, so `kiosk_not_allowed` takes the move wording. Nothing else in `main/` references `moveNotice` except `LoginScreen.kt` (Task 4 replaces that line); to keep this task compiling, in `LoginScreen.kt` change

```kotlin
                        if (ui.moveNotice) LoginNotice("Move passwords aren't available yet. Use email & password or link with your phone.", modifier = Modifier.padding(top = 8.dp))
```

to

```kotlin
                        ui.moveError?.let { Text(it, color = LoginPalette.ErrorText, fontFamily = Geologica, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
```

and in `LoginScreen(...)` change `submitMove = vm::submitMove,` to `submitMove = { vm.submitMove(goHome) },`. In `LoginScreenTest`, the test `moveFlowShowsItsNoticeAndGoesBack` asserts the old notice: change its name to `moveFlowAsksForAPasswordAndGoesBack` and replace the notice assertion line with `compose.onNodeWithText("Enter the move password.").assertIsDisplayed()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./gradlew testDebugUnitTest --tests '*LoginViewModelTest*' --tests '*LoginScreenTest*'`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/login Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/screens/login
git commit -m "feat(kiosk-android): Move password signs in — web kiosk's blank check and error copy, field cleared on failure, scanned codes submit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The QR button in the Move password field, and the camera sheet's QR-only mode

**Files:**
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/camera/BarcodeAnalyzer.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/camera/CameraScanSheet.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/login/LoginControls.kt` (icons block near `LockIcon`, line ~85; `PasswordEye` near line ~147)
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/login/LoginScreen.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/screens/login/LoginScreenTest.kt`

**Interfaces:**
- Consumes (Task 3): `LoginUi.moveError`, `LoginUi.moveLoading`, `LoginViewModel.submitMove(onDone)`, `LoginViewModel.submitScannedMove(value, onDone)`.
- Consumes (existing): `CameraScanSheet(initialMode: CameraMode = CameraMode.SINGLE, onScan: (ScanEvent) -> Unit, onDismiss: () -> Unit)`, `ScanEvent(value: String, source: ScanSource, symbology: String?)`, `AppContainer.hasCamera: Boolean`, `lineIcon(name, paths)` in `LoginControls.kt`.
- Produces:
  - `BarcodeAnalyzer(onValue: (String, String?) -> Unit, formats: IntArray = intArrayOf())` — empty means all formats (today's behavior)
  - `CameraScanSheet(..., qrOnly: Boolean = false)` — new last parameter
  - `internal val QrCodeIcon: ImageVector` and `@Composable internal fun MoveScanButton(enabled: Boolean, onClick: () -> Unit)` in `LoginControls.kt`
  - `LoginActions.scanMove: () -> Unit` (new last constructor parameter — opens the camera)
  - `LoginContent(ui, kioskName, actions, canScan: Boolean = false, pairPanel)` — `canScan` shows the QR button

- [ ] **Step 1: Write the failing tests**

In `LoginScreenTest`:
- `Calls.actions` gains the new last argument: `scanMove = { log += "scanMove" },`.
- `show(...)` gains `canScan: Boolean = false` and passes it: `LoginContent(calls.ui, kioskName, calls.actions, canScan = canScan) { ... }`.

Add tests:

```kotlin
    @Test fun theMoveFieldHasAQrButtonThatOpensTheCamera() {
        val calls = Calls(LoginUi(view = LoginView.MOVE))
        show(calls = calls, canScan = true)
        compose.onNodeWithContentDescription("Scan the move password's QR code").assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        assertTrue("scanMove" in calls.log)
    }

    @Test fun noCameraMeansNoQrButton() {
        show(calls = Calls(LoginUi(view = LoginView.MOVE)), canScan = false)
        compose.onNodeWithContentDescription("Scan the move password's QR code").assertDoesNotExist()
    }

    @Test fun signingInWithAMovePasswordShowsProgressAndLocksTheButtons() {
        show(calls = Calls(LoginUi(view = LoginView.MOVE, movePassword = "x", moveLoading = true)), canScan = true)
        compose.onNodeWithText("Signing in…").assertIsDisplayed()
        compose.onNodeWithTag("login-submit-move").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Scan the move password's QR code").assertIsNotEnabled()
    }

    @Test fun aMoveErrorIsShownUnderTheField() {
        show(calls = Calls(LoginUi(view = LoginView.MOVE, moveError = "That move password isn't right.")))
        compose.onNodeWithText("That move password isn't right.").assertIsDisplayed()
    }
```

Add any missing imports (`onNodeWithContentDescription`, `assertDoesNotExist`, `assertIsNotEnabled` are in `androidx.compose.ui.test`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./gradlew testDebugUnitTest --tests '*LoginScreenTest*'`
Expected: compile FAILS (`scanMove`, `canScan` unknown).

- [ ] **Step 3: Implement**

`BarcodeAnalyzer.kt` — let the caller limit the formats:

```kotlin
import com.google.mlkit.vision.barcode.BarcodeScannerOptions

/** Runs ML Kit on each frame; `onValue(value, symbology)` per decoded barcode. [formats] (ML Kit
 *  `Barcode.FORMAT_*`) limits what is decoded; empty means every format. */
class BarcodeAnalyzer(private val onValue: (String, String?) -> Unit, formats: IntArray = intArrayOf()) : ImageAnalysis.Analyzer {
    private val scanner = if (formats.isEmpty()) BarcodeScanning.getClient()
        else BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(formats.first(), *formats.drop(1).toIntArray()).build())
```

(the rest of the class unchanged).

`CameraScanSheet.kt`:
- Signature: `fun CameraScanSheet(initialMode: CameraMode = CameraMode.SINGLE, onScan: (ScanEvent) -> Unit, onDismiss: () -> Unit, qrOnly: Boolean = false)`.
- Add to the class doc: ` * [qrOnly] reads QR codes only, stays in SINGLE mode and hides the Single/Multi switch — the sign-in screen's move-password scan uses it.`
- `var mode by remember { mutableStateOf(if (qrOnly) CameraMode.SINGLE else initialMode) }`
- Analyzer: `BarcodeAnalyzer({ value, symbology -> ...existing body... }, formats = if (qrOnly) intArrayOf(Barcode.FORMAT_QR_CODE) else intArrayOf())` — the existing trailing-lambda body moves into the first argument unchanged. Add `import com.google.mlkit.vision.barcode.common.Barcode` (the same `Barcode` class `CameraSupport.kt` imports — copy that import line from `CameraSupport.kt`).
- In the bottom panel's first `Row`, wrap the two `ModeButton`s: `if (!qrOnly) { ModeButton(...Single...); ModeButton(...Multi...) } else Text("Point the camera at the move password's QR code.", color = SNOW, fontSize = 14.sp)`.

`LoginControls.kt` — next to `LockIcon`:

```kotlin
// A QR code: three finder squares and a scatter of modules, drawn as outlines like the other login glyphs.
internal val QrCodeIcon: ImageVector = lineIcon(
    "qr-code",
    listOf(
        "M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z",
        "M14 14h2v2h-2z", "M18 14h2", "M14 18h2", "M18 18h2v2h-2z",
    ),
)
```

and next to `PasswordEye`:

```kotlin
/** The QR button inside the Move password field: 48 dp target, opens the camera to read the move's QR code. */
@Composable
internal fun MoveScanButton(enabled: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(48.dp).testTag("login-move-scan")) {
        Icon(QrCodeIcon, contentDescription = "Scan the move password's QR code", tint = if (enabled) LoginPalette.Orange else LoginPalette.Slate)
    }
}
```

`LoginScreen.kt`:
- `LoginActions` gains a last parameter `val scanMove: () -> Unit,`.
- `LoginContent` signature: `internal fun LoginContent(ui: LoginUi, kioskName: String, actions: LoginActions, canScan: Boolean = false, pairPanel: @Composable () -> Unit)`.
- The `LoginView.MOVE` branch becomes:

```kotlin
                    LoginView.MOVE -> {
                        LoginField(
                            "Move password", ui.movePassword, actions.setMovePassword, tag = "login-move", masked = true,
                            invalid = ui.moveError != null,
                            trailing = if (canScan) ({ MoveScanButton(enabled = !ui.moveLoading, onClick = actions.scanMove) }) else null,
                        )
                        ui.moveError?.let { Text(it, color = LoginPalette.ErrorText, fontFamily = Geologica, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
                        LoginPrimaryButton(
                            if (ui.moveLoading) "Signing in…" else "Sign in", actions.submitMove,
                            Modifier.padding(top = 16.dp).testTag("login-submit-move"), loading = ui.moveLoading, enabled = !ui.moveLoading,
                        )
                        LoginLink("Back to email & password", Modifier.align(Alignment.Start)) { actions.setView(LoginView.PASSWORD) }
                    }
```

- In `LoginScreen(nav)`: add `var scanning by rememberSaveable { mutableStateOf(false) }` (imports for `rememberSaveable`, `mutableStateOf`, `getValue`, `setValue` already exist in the file). Pass `scanMove = { scanning = true },` into `LoginActions(...)`, and `canScan = container.hasCamera,` into `LoginContent(...)`. After the `LoginContent(...)` call add:

```kotlin
    // The kiosk's own camera, QR only: the first code read is the move password and is submitted at once.
    if (scanning) CameraScanSheet(
        onScan = { vm.submitScannedMove(it.value, goHome) },
        onDismiss = { scanning = false },
        qrOnly = true,
    )
```

(import `com.serversherpa.kiosk.input.camera.CameraScanSheet`). SINGLE mode already calls `onScan` then `onDismiss` on the first read, so the sheet closes itself and the sign-in shows its progress/error on the Move form.

- [ ] **Step 4: Run the whole suite and build**

Run: `./gradlew testDebugUnitTest assembleDebug`
Expected: BUILD SUCCESSFUL (see Global Constraints for the flaky `RfidPanelTest` rerun rule).

- [ ] **Step 5: Commit**

```bash
git add Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/input/camera Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/ui/screens/login Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/ui/screens/login
git commit -m "feat(kiosk-android): QR button in the Move password field — opens the kiosk camera (QR only) and signs in with the first code read

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks (controller, not a subagent)

Live verify on the emulator and the Pixel: give a dev-stack move a kiosk password, render it as a QR code, sign in by typing it and by scanning it, check the footer shows the move, check a wrong password shows "That move password isn't right.", and screenshot for the user.
