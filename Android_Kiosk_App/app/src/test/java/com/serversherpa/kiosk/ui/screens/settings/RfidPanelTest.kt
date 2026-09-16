package com.serversherpa.kiosk.ui.screens.settings

import android.app.Application
import android.net.Uri
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.rules.ActivityScenarioRule
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.settings.SETTINGS_TABS
import com.serversherpa.kiosk.core.settings.SettingsTabId
import com.serversherpa.kiosk.core.settings.visibleTabs
import com.serversherpa.kiosk.input.rfid.RfidPermissions
import com.serversherpa.kiosk.input.rfid.RfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class RfidPanelTest {
    @get:Rule val compose = createComposeRule()

    // RfidPanel is by far the longest panel in Settings — well past a
    // 360x800 test window's height. In the real app it is always reached
    // through KioskShell, which wraps every screen's content in its own
    // Modifier.verticalScroll (see KioskShell.kt), so this is never an issue
    // on device. Composing RfidPanel bare, the way the other (short) panel
    // tests compose their panels, leaves the bottom rows laid out past the
    // fixed test window with nothing to scroll them into view — Compose
    // still finds those nodes by text, but a click can't land on a node the
    // layout gave zero size. Wrapping in the same verticalScroll here
    // matches how the panel is actually shown, and performScrollTo() before
    // a click on a row that may be below the fold mirrors what a real
    // operator's swipe would do.
    private fun ComposeContentTestRule.setRfidPanelContent(c: AppContainer) {
        setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme {
                    Column(Modifier.verticalScroll(rememberScrollState())) { RfidPanel() }
                }
            }
        }
    }

    @Test fun theTabExistsForAnyoneSignedInAndNotWhenSignedOut() {
        assertTrue(SETTINGS_TABS.any { it.id == SettingsTabId.RFID })
        assertTrue(visibleTabs(isAdmin = false, isDeveloper = false, signedIn = true).any { it.id == SettingsTabId.RFID })
        assertTrue(visibleTabs(isAdmin = false, isDeveloper = false, signedIn = false).none { it.id == SettingsTabId.RFID })
    }

    @Test fun theReaderIsOffUntilSomeoneTurnsItOn() {
        val c = testContainer()
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Off. Turn the reader on to use the sled.").assertIsDisplayed()
    }

    @Test fun pickingATriggerModeWritesIt() {
        val c = testContainer()
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Click to start and stop").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(RfidTriggerMode.TOGGLE, runBlocking { c.prefs.rfid.first() }.triggerMode)
    }

    @Test fun restoreDefaultsPutsEverythingBack() {
        val c = testContainer()
        runBlocking { c.prefs.setRfid(com.serversherpa.kiosk.core.rfid.RfidSettings(enabled = true, powerDbm = 9)) }
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Restore defaults").performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(27, runBlocking { c.prefs.rfid.first() }.powerDbm)
    }

    /**
     * A reader whose `connect()` can be told to hang until the test releases
     * it. `FakeRfidReader` gives no seam for that (its `connect()` always
     * resolves on the current suspension point with whatever `connectResult`
     * says) and must not gain one just for this test, so this is a small
     * test-local stand-in — same idiom as `RfidControllerTest`'s
     * `SlowConnectReader`, minus the parts this test doesn't need
     * (triggers/tags collection, an inner fake to delegate to).
     */
    private class GatedConnectReader : RfidReader {
        private val _connection = MutableStateFlow<RfidConnection>(RfidConnection.Disconnected)
        override val connection: StateFlow<RfidConnection> = _connection
        override val tags: Flow<String> = MutableSharedFlow()
        override val triggers: Flow<TriggerEvent> = MutableSharedFlow()

        /** What the next `connect()` resolves to, once its gate (if any) opens. */
        var connectResult: Result<Unit> = Result.success(Unit)

        /** Set before a call whose `connect()` must stay in flight; that call
         *  suspends here until the test completes it. Left null for a call
         *  that should resolve immediately. */
        var connectGate: CompletableDeferred<Unit>? = null

        override suspend fun connect(): Result<Unit> {
            _connection.value = RfidConnection.Connecting
            connectGate?.await()
            return connectResult
                .onSuccess { _connection.value = RfidConnection.Connected("Fake RFD40", 80) }
                // Deliberately NOT derived from connectResult's exception message: the
                // status line (connectionLine(connection)) and the red error line
                // (RfidController.connectionError, built from the same Result this
                // method returns) would otherwise carry identical text, and the test
                // below needs to find the error line by text alone, unambiguously.
                .onFailure { _connection.value = RfidConnection.Failed("connect() reported a failure") }
        }
        override suspend fun disconnect() { _connection.value = RfidConnection.Disconnected }
        override suspend fun apply(settings: RfidSettings): Result<Unit> = Result.success(Unit)
        override suspend fun startInventory(): Result<Unit> = Result.success(Unit)
        override suspend fun stopInventory(): Result<Unit> = Result.success(Unit)
    }

    /**
     * The old `connectButtonTriggersConnectionAttempt` proved nothing: it
     * left `FakeRfidReader`'s default connect() (always succeeds) in place,
     * so `connectionError` was never populated and the suppression path was
     * never entered, then wrapped its one assertion in a try/catch that
     * swallowed a failure either way — a test that could not fail even if
     * `RfidPanel`'s in-flight suppression were deleted outright.
     *
     * This test instead builds the exact situation the fix exists for: a
     * connection error already on screen from a failed attempt, then a
     * second attempt that is still running. The previous error must not
     * reappear while that second attempt is in flight — only once it
     * resolves does `connectionError` get a chance to change.
     */
    @Test fun aStaleConnectionErrorIsHiddenWhileARetryIsStillInFlight() {
        val reader = GatedConnectReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)

        // First attempt: connect() resolves immediately, with a failure, so
        // connectionError ends up populated with a message this test chose.
        val staleError = "Simulated failure from a previous attempt."
        reader.connectResult = Result.failure(RuntimeException(staleError))
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        compose.waitForIdle()

        // Anchor: the error must actually be on screen before the retry,
        // or hiding it during the retry would prove nothing.
        compose.onNodeWithText(staleError).assertIsDisplayed()

        // Second attempt: connect() now hangs until this test releases it,
        // giving a real, controlled window in which it is still running.
        reader.connectResult = Result.success(Unit)
        reader.connectGate = CompletableDeferred()
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        compose.waitForIdle()

        // The stale error from the first attempt must not be showing while
        // this second attempt is still in flight. connectionError itself
        // hasn't changed yet (connect() hasn't returned), so this can only
        // pass because RfidPanel's connectAttemptInFlight suppresses it.
        // (This compose-ui-test version has no assertDoesNotExist; a zero-count
        // assertion on the matching nodes is the equivalent, loud-failing check.)
        compose.onAllNodesWithText(staleError).assertCountEquals(0)

        // Let the stuck connect() finish so it doesn't leak past the test.
        reader.connectGate?.complete(Unit)
        compose.waitForIdle()
    }

    /** [createComposeRule] always hands back a [ComponentActivity] backed by an
     *  [ActivityScenarioRule] (see `AndroidComposeTestRule_androidKt.createComposeRule`) —
     *  that generic signature just isn't exposed on the [ComposeContentTestRule]
     *  interface `compose` is declared as, so tests that need the underlying
     *  activity (to drive its lifecycle, or read what it started) cast to it. */
    @Suppress("UNCHECKED_CAST")
    private val ComposeContentTestRule.androidRule
        get() = this as AndroidComposeTestRule<ActivityScenarioRule<ComponentActivity>, ComponentActivity>

    @Test fun aMissingPermissionShowsTheWarningAndTheSettingsButtonWhileEnabled() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).denyPermissions(*RfidPermissions.REQUIRED.toTypedArray())
        val c = testContainer()
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Android needs Bluetooth and location permission before the sled can connect. Grant them in this app's settings.")
            .performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Open app settings").performScrollTo().assertIsDisplayed()
    }

    /** Robolectric denies every dangerous permission by default, manifest
     *  declaration or not — a test gets nothing for free — so this grants
     *  every entry in [RfidPermissions.REQUIRED] explicitly to build the
     *  "nothing missing" case, rather than relying on [testContainer]'s
     *  default environment to already be in it. */
    @Test fun nothingMissingShowsNeitherTheWarningNorTheButton() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).grantPermissions(*RfidPermissions.REQUIRED.toTypedArray())
        val c = testContainer()
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)
        compose.onAllNodesWithText("Open app settings").assertCountEquals(0)
    }

    @Test fun clickingOpenAppSettingsStartsTheAppDetailsIntent() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).denyPermissions(*RfidPermissions.REQUIRED.toTypedArray())
        val c = testContainer()
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Open app settings").performScrollTo().performClick()
        compose.waitForIdle()
        val started = Shadows.shadowOf(app).nextStartedActivity
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, started?.action)
        assertEquals(Uri.parse("package:" + app.packageName), started?.data)
    }

    /**
     * Whether flipping the switch on actually drives
     * `permissionLauncher.launch(...)` all the way to a real permission
     * prompt. `ComponentActivity`'s built-in `ActivityResultRegistry` special-
     * cases `RequestMultiplePermissions`/`RequestPermission` contracts: rather
     * than starting a separate activity for the result, it calls
     * `ActivityCompat.requestPermissions(...)` directly on the host activity,
     * which Robolectric's `ShadowActivity` records via
     * `getLastRequestedPermission()`. That means — unlike the launcher
     * interaction the brief flagged as possibly undrivable in this harness —
     * this specific contract type turns out to be observable without needing
     * to fake the `ActivityResultRegistry` itself. This test proves that path
     * end to end: real click, real launcher, real (shadowed) platform call.
     *
     * The switch under test is found as the first toggleable node in the
     * tree: `RfidPanel` has four `Switch`es total (this one, "Report each tag
     * once", "Blink on read", "Dynamic power optimization"), all later in
     * composition order than the enable switch, so `onAllNodes(isToggleable())[0]`
     * reliably means this one — there is no test tag on any of them to select
     * by name instead.
     */
    @Test fun turningTheReaderOnWithAMissingPermissionRequestsIt() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).denyPermissions(*RfidPermissions.REQUIRED.toTypedArray())
        val c = testContainer()
        compose.setRfidPanelContent(c)
        compose.onAllNodes(isToggleable())[0].performScrollTo().performClick()
        compose.waitForIdle()

        var requested: Array<out String>? = null
        compose.androidRule.activityRule.scenario.onActivity { activity ->
            requested = Shadows.shadowOf(activity).lastRequestedPermission?.requestedPermissions
        }
        assertEquals(RfidPermissions.REQUIRED.toSet(), requested?.toSet())
    }

    /**
     * M2: an operator who leaves the kiosk to grant the permission in
     * Android's own Settings app, then returns, must see the warning line
     * clear on its own — nothing about `RfidPermissions.missing(context)`
     * itself would ever tell Compose to recompose that line, so this proves
     * the `ON_RESUME` refresh is what does it, not a side effect of anything
     * else. The grant is applied first (so a stale read would still show the
     * old, missing state), then the activity is driven from RESUMED down to
     * CREATED and back up to RESUMED — the same transition a real
     * "leave the app, come back" trip produces — using `ActivityScenario`,
     * the same tool `ActivityScenarioRule` itself is built on.
     */
    @Test fun returningFromSettingsAfterGrantingClearsTheWarningOnResume() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val permissions = RfidPermissions.REQUIRED.toTypedArray()
        Shadows.shadowOf(app).denyPermissions(*permissions)
        val c = testContainer()
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Open app settings").performScrollTo().assertIsDisplayed()

        Shadows.shadowOf(app).grantPermissions(*permissions)
        compose.androidRule.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        compose.androidRule.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitForIdle()

        compose.onAllNodesWithText("Open app settings").assertCountEquals(0)
    }
}
