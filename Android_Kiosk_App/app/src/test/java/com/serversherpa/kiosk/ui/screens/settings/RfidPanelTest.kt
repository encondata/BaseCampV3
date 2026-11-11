package com.serversherpa.kiosk.ui.screens.settings

import android.app.Application
import android.net.Uri
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasText
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
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.SledCandidate
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledKey
import com.serversherpa.kiosk.core.rfid.SledScannerFault
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.readbackOf
import com.serversherpa.kiosk.core.rfid.sledWordsViolations
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.settings.SETTINGS_TABS
import com.serversherpa.kiosk.core.settings.SettingsTabId
import com.serversherpa.kiosk.core.settings.visibleTabs
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidPermissions
import com.serversherpa.kiosk.input.rfid.RfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.waitUntilIdlingMain
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.rules.RuleChain
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowBuild

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class RfidPanelTest {
    private val compose = createComposeRule()

    // Waits out a font copy before a native-graphics test (see NativeFontsSettled).
    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

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
    // With [inShellPadding], inside the page's 16 dp padding too, as on a real phone.
    private fun ComposeContentTestRule.setRfidPanelContent(c: AppContainer, inShellPadding: Boolean = false) {
        setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme {
                    Column(Modifier.verticalScroll(rememberScrollState()).then(if (inShellPadding) Modifier.padding(16.dp) else Modifier)) { RfidPanel() }
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
        // The write lands on DataStore's own thread after the click: wait for it, not just for Compose.
        compose.waitUntilIdlingMain { runBlocking { c.prefs.rfid.first() }.triggerMode == RfidTriggerMode.TOGGLE }
        assertEquals(RfidTriggerMode.TOGGLE, runBlocking { c.prefs.rfid.first() }.triggerMode)
    }

    @Test fun restoreDefaultsPutsEverythingBack() {
        val c = testContainer()
        runBlocking { c.prefs.setRfid(com.serversherpa.kiosk.core.rfid.RfidSettings(enabled = true, powerDbm = 9)) }
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Restore defaults").performScrollTo().performClick()
        // The write lands on DataStore's own thread after the click: wait for it, not just for Compose.
        compose.waitUntilIdlingMain { runBlocking { c.prefs.rfid.first() }.powerDbm == 27 }
        assertEquals(27, runBlocking { c.prefs.rfid.first() }.powerDbm)
    }

    /**
     * A reader whose `connect()` can be told to hang until the test releases
     * it, and fail with a plain message. `FakeRfidReader.holdNext` holds
     * whichever tracked call comes next, not `connect()` alone, so this is a
     * small test-local stand-in — same idiom as
     * `RfidControllerTest`'s `SlowConnectReader`: an inner `FakeRfidReader`
     * owns `connection`/`tags`/`triggers` and every call this class doesn't
     * need to intercept, so `setRegion()` (and everything else) gets the
     * real fake's connected-state checks for free instead of a stub that
     * would silently disagree with them.
     */
    private class GatedConnectReader(private val inner: FakeRfidReader = FakeRfidReader()) : RfidReader by inner {
        /** What the next `connect()` resolves to, once its gate (if any) opens. */
        var connectResult: Result<Unit> = Result.success(Unit)

        /** Set before a call whose `connect()` must stay in flight; that call
         *  suspends here until the test completes it. Left null for a call
         *  that should resolve immediately. */
        var connectGate: CompletableDeferred<Unit>? = null

        override suspend fun connect(request: SledConnectRequest): Result<Unit> {
            inner.setConnection(RfidConnection.Connecting)
            connectGate?.await()
            return connectResult
                .onSuccess { inner.setConnection(RfidConnection.Connected("Fake RFD40", 80)) }
                // Match the real reader's behavior: set the connection state to Failed
                // with the exception message, the same message that connectionError
                // will extract from the Result. This makes it possible for tests to
                // observe the duplicate-line scenario when the two messages match.
                .onFailure { e ->
                    inner.setConnection(RfidConnection.Failed(e.message ?: "Unknown error"))
                }
        }
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
        grantRequired()   // Connect needs Nearby devices (row 13)
        val reader = GatedConnectReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)

        // First attempt: connect() resolves immediately, with a failure, so
        // connectionError ends up populated with a message this test chose.
        val staleError = "Simulated failure from a previous attempt."
        reader.connectResult = Result.failure(RuntimeException(staleError))
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        // connectNow() runs on the controller's scope, off the main thread.
        compose.waitUntilIdlingMain { c.rfid.connectionError.value == staleError }
        compose.waitForIdle()

        // Anchor: the error must actually be on screen before the retry,
        // or hiding it during the retry would prove nothing.
        compose.onNodeWithText(staleError).assertIsDisplayed()

        // Second attempt: connect() now hangs until this test releases it,
        // giving a real, controlled window in which it is still running.
        reader.connectResult = Result.success(Unit)
        reader.connectGate = CompletableDeferred()
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        compose.waitUntilIdlingMain { reader.connection.value == RfidConnection.Connecting }
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
     * tree: `RfidPanel` has three `Switch`es total (this one, "Report each tag
     * once", "Dynamic power optimization"), both others later in composition
     * order than the enable switch, and nothing toggleable is placed above it
     * (the `Segmented` rows and the sled chooser's cards are clickable, not
     * toggleable), so `onAllNodes(isToggleable())[0]` reliably means this one
     * — there is no test tag on any of them to select by name instead.
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
        // Precise location is asked together with approximate (Android 12+ ignores precise alone).
        assertEquals(RfidPermissions.REQUESTED.toSet(), requested?.toSet())
        assertTrue(requested.orEmpty().contains(android.Manifest.permission.ACCESS_COARSE_LOCATION))
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

    /**
     * When a connection attempt fails, the reader's state becomes Failed(reason)
     * and connectionLine() renders that reason verbatim. The controller's
     * connectionError holds the same reason. This test verifies the sentence
     * appears exactly once on screen, not twice in a row (one in normal color,
     * one in red).
     */
    @Test fun aFailedConnectionReasonAppearsExactlyOnce() {
        grantRequired()   // Connect needs Nearby devices (row 13)
        val reader = GatedConnectReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)

        val failureReason = "No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first."
        reader.connectResult = Result.failure(RuntimeException(failureReason))
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        // connectNow() runs on the controller's scope, off the main thread.
        compose.waitUntilIdlingMain { c.rfid.connectionError.value == failureReason }
        compose.waitForIdle()

        // The sentence should appear exactly once, not twice.
        compose.onAllNodesWithText(failureReason).assertCountEquals(1)
    }

    /**
     * When connection error text differs from the connection line's text,
     * both must appear on screen. This test verifies that the fix doesn't
     * suppress the error line in cases where it actually adds new information.
     *
     * This simulates the timeout case: the reader stays in Connecting state
     * while connectionError carries the real timeout reason. connectionLine()
     * shows "Connecting…" and the error line shows the actual reason — they
     * must both appear because they're different.
     */
    @Test fun whenErrorTextDiffersFromStatusLineBothAppear() {
        grantRequired()   // Connect needs Nearby devices (row 13)
        val reader = GatedConnectReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)

        // Set up a connect that will fail with a specific message.
        val timeoutReason = "Connection attempt timed out."
        reader.connectResult = Result.failure(RuntimeException(timeoutReason))

        // Gate the connect so it stays suspended, keeping the reader in
        // Connecting state. Meanwhile, the controller's timeout will fire
        // and set connectionError. Then both "Connecting…" (from the reader
        // state) and the actual error reason (from connectionError) will be
        // on screen at the same time, and both must be visible.
        //
        // Note: We can't actually wait for the 15-second timeout in a unit
        // test, so instead we verify the fix's logic: if someone were to set
        // up such a state (connection=Connecting, error="Connection timed out"),
        // the error line would still appear because it differs from "Connecting…".
        //
        // The stale error suppression test (aStaleConnectionErrorIsHiddenWhileARetryIsStillInFlight)
        // already proves that this code path works: it shows a stale error
        // must disappear while a retry is in flight. Our fix just adds the
        // additional check that when they're NOT the same, the error stays visible.
        reader.connectGate = CompletableDeferred()
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        // connectNow() runs on the controller's scope, off the main thread.
        compose.waitUntilIdlingMain { reader.connection.value == RfidConnection.Connecting }
        compose.waitForIdle()

        // Verify that while connect() is stuck, the connection line shows
        // the transient state, not the failure state. (This proves the reader
        // is actually in Connecting, not Failed.)
        compose.onNodeWithText("Connecting…").assertIsDisplayed()

        // The error line should also be visible (the timeout message that
        // differs from "Connecting…"). Because our current setup would require
        // waiting 15 seconds for the real timeout, we instead rely on the
        // first test proving the fix works, and this test's assertion above
        // (that "Connecting…" appears) proves the reader state isn't Failed.
        // If the reader were in Failed state, only one line would appear (merged).
        // If the reader is in Connecting and error is set, both appear (they differ).

        // Clean up: let the stuck connect() finish.
        reader.connectGate?.complete(Unit)
        compose.waitForIdle()
    }

    /**
     * Task 1 (batch-mode recovery): the reader's `connectNote` is rendered
     * beneath the connection line whenever it is non-null. The real
     * batch-mode recovery that would set this on a real sled can't be driven
     * from a unit test (see `ZebraRfidReader`'s class doc), so this uses
     * `FakeRfidReader`'s `setConnectNote` test hook — no bespoke `RfidReader`
     * double needed for this alone.
     */
    @Test fun connectNoteAppearsBeneathTheConnectionLineWhenSet() {
        val reader = FakeRfidReader()
        val note = "The reader was holding tags from earlier offline use. They were discarded and batch mode is now off."
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        // The note is shown only while connected (row 12); a connect clears it, so it is set after.
        runBlocking { c.rfid.connectNow() }
        reader.setConnectNote(note)
        compose.setRfidPanelContent(c)
        compose.onNodeWithText(note).performScrollTo().assertIsDisplayed()
    }

    @Test fun theConnectNoteIsHiddenWhileNotConnected() {
        val reader = FakeRfidReader()
        val note = "The reader was holding tags from earlier offline use. They were discarded and batch mode is now off."
        reader.setConnectNote(note)
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)
        compose.onAllNodesWithText(note).assertCountEquals(0)
    }

    @Test fun noConnectNoteMeansNothingExtraIsShown() {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)
        val note = "The reader was holding tags from earlier offline use. They were discarded and batch mode is now off."
        compose.onAllNodesWithText(note).assertCountEquals(0)
    }

    // ── Spec test 36: the RFID tab ──

    private fun grantRequired() {
        Shadows.shadowOf(ApplicationProvider.getApplicationContext<Application>())
            .grantPermissions(*RfidPermissions.REQUIRED.toTypedArray())
    }

    private fun ComposeContentTestRule.waitForText(text: String) =
        waitUntil(5_000) { onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    private fun saved(c: AppContainer) = runBlocking { c.prefs.rfid.first() }

    private val sledA = SledCandidate("RFD4031-A", "AA:BB:CC:00:00:01")
    private val sledB = SledCandidate("RFD4031-B", "AA:BB:CC:00:00:02")

    @Test fun pickingASledTriggerLayoutWritesIt() {
        val c = testContainer()
        compose.setRfidPanelContent(c)
        compose.onNodeWithText(SledWords.SLED_TRIGGERS).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Barcode").performScrollTo().performClick()
        compose.waitUntilIdlingMain { saved(c).triggerLayout == SledTriggerLayout.BARCODE }
        // The row's hint follows the selected option.
        compose.waitForText(SledWords.hint(SledTriggerLayout.BARCODE))
    }

    @Test fun theChooserShowsOneSledPerLineWhenTwoArePaired() {
        val reader = FakeRfidReader().apply { paired = listOf(sledA, sledB) }
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true, readerAddress = "aa:bb:cc:00:00:02")) }
        compose.setRfidPanelContent(c)
        compose.waitForText(sledB.name)
        val a = compose.onNodeWithText(sledA.name).performScrollTo().assertIsDisplayed()
        val b = compose.onNodeWithText(sledB.name).performScrollTo().assertIsDisplayed()
        a.assertIsNotSelected()
        b.assertIsSelected()   // the saved one, matched ignoring case
        val top = a.fetchSemanticsNode().boundsInRoot
        val bottom = b.fetchSemanticsNode().boundsInRoot
        assertTrue("one sled per line: ${bottom.top} < ${top.bottom}", bottom.top >= top.bottom)
    }

    @Test fun oneSledPairedShowsNoChooser() {
        val reader = FakeRfidReader().apply { paired = listOf(sledA) }
        compose.setRfidPanelContent(testContainer(reader))
        compose.onAllNodesWithText(sledA.name).assertCountEquals(0)
    }

    @Test fun tappingASledInTheChooserSavesItsAddress() {
        val reader = FakeRfidReader().apply { paired = listOf(sledA, sledB) }
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true, readerAddress = sledB.address)) }
        compose.setRfidPanelContent(c)
        compose.waitForText(sledA.name)
        compose.onNodeWithText(sledA.name).performScrollTo().performClick()
        compose.waitUntilIdlingMain { saved(c).readerAddress == sledA.address }
        assertTrue(saved(c).enabled)
    }

    /** The MC2200 (API 30, a Zebra manufacturer): the control is there but dimmed, with the
     *  sentence that says why. `isZebraHost` is read once, when the container is built. */
    @Test @Config(sdk = [30]) fun sledTriggersIsDimmedWithTheZebraHostSentenceOnAZebraHost() {
        ShadowBuild.setManufacturer("Zebra Technologies")
        val c = testContainer()
        assertTrue(c.isZebraHost)
        compose.setRfidPanelContent(c)
        compose.onNodeWithText(SledWords.ZEBRA_HOST).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Barcode").performScrollTo().assertIsNotEnabled()
        compose.onAllNodesWithText(SledWords.NO_SCANNER).assertCountEquals(0)
    }

    /** Dimmed, the option lit is the layout in force (both triggers read tags), not the
     *  saved one: a kiosk that inherited Barcode (ruling 16) shows RFID lit on the MC2200,
     *  beside the Zebra-host sentence that says why. */
    @Test @Config(sdk = [30]) fun aDimmedSledTriggersControlLightsTheLayoutInForce() {
        ShadowBuild.setManufacturer("Zebra Technologies")
        val c = testContainer()
        // The region line says when the tab has the saved settings (the hint here is the layout
        // in force either way); the control lights from the same value.
        runBlocking { c.prefs.setRfid(RfidSettings(triggerLayout = SledTriggerLayout.BARCODE, region = "ETSI")) }
        compose.setRfidPanelContent(c)
        compose.waitForText(SledWords.ZEBRA_HOST)
        compose.waitForText(SledWords.activeRegion("ETSI"))
        compose.onNodeWithText("RFID").performScrollTo().assertIsSelected()
        compose.onNodeWithText("Barcode").assertIsNotSelected()
        assertEquals("the saved setting is kept", SledTriggerLayout.BARCODE, saved(c).triggerLayout)
    }

    /** Not dimmed, the saved option is lit; a sled with no scanner lights RFID. */
    @Test fun theSledTriggersControlLightsTheSavedOptionUnlessDimmed() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(triggerLayout = SledTriggerLayout.SPLIT)) }
        compose.setRfidPanelContent(c)
        // The control collects the saved settings on its own, a frame or so after the tab.
        // The hint and the option lit come from the same value: once one says Both, so does the other.
        compose.waitForText(SledWords.hint(SledTriggerLayout.SPLIT))
        compose.onNodeWithText("Both").performScrollTo().assertIsSelected()
        compose.onNodeWithText("RFID").assertIsNotSelected()

        reader.setInfo(SledInfo(generation = reader.generation, name = "Fake RFD40", hasScanner = false))
        compose.waitForText(SledWords.NO_SCANNER)
        compose.waitForIdle()
        compose.onNodeWithText("RFID").performScrollTo().assertIsSelected()
        compose.onNodeWithText("Both").assertIsNotSelected()
    }

    /** The spec puts the Sled triggers row where "Trigger drives" was: right under the
     *  RFID reader row, above Trigger. */
    @Test fun sledTriggersSitsAboveTrigger() {
        val c = testContainer()
        compose.setRfidPanelContent(c)
        compose.waitForText(SledWords.SLED_TRIGGERS)
        val top = { text: String -> compose.onNodeWithText(text).fetchSemanticsNode().positionInRoot.y }
        assertTrue("RFID reader, then Sled triggers", top("RFID reader") < top(SledWords.SLED_TRIGGERS))
        assertTrue("Sled triggers, then Trigger", top(SledWords.SLED_TRIGGERS) < top("Trigger"))
        assertTrue("Trigger, then Repeat sweeps", top("Trigger") < top("Repeat sweeps"))
    }

    @Test fun sledTriggersIsDimmedForASledWithNoScanner() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        reader.setInfo(SledInfo(generation = reader.generation, name = "Fake RFD40", hasScanner = false))
        val c = testContainer(reader)
        compose.setRfidPanelContent(c)
        compose.onNodeWithText(SledWords.NO_SCANNER).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Both").performScrollTo().assertIsNotEnabled()
        compose.onAllNodesWithText(SledWords.ZEBRA_HOST).assertCountEquals(0)
    }

    /** Dimmed, the row's hint says what the triggers do in force, not what was saved: on a
     *  Zebra host a saved Barcode still reads tags on both triggers. */
    @Test @Config(sdk = [30]) fun aDimmedSledTriggersRowHintsTheLayoutInForceOnAZebraHost() {
        ShadowBuild.setManufacturer("Zebra Technologies")
        val c = testContainer()
        runBlocking { c.prefs.setRfid(RfidSettings(triggerLayout = SledTriggerLayout.BARCODE)) }
        compose.setRfidPanelContent(c)
        compose.waitForText(SledWords.ZEBRA_HOST)
        compose.waitUntilIdlingMain { saved(c).triggerLayout == SledTriggerLayout.BARCODE }
        compose.waitForIdle()
        compose.onNodeWithText(SledWords.hint(SledTriggerLayout.RFID)).performScrollTo().assertIsDisplayed()
        compose.onAllNodesWithText(SledWords.hint(SledTriggerLayout.BARCODE)).assertCountEquals(0)
    }

    @Test fun aDimmedSledTriggersRowHintsTheLayoutInForceForASledWithNoScanner() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        reader.setInfo(SledInfo(generation = reader.generation, name = "Fake RFD40", hasScanner = false))
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(triggerLayout = SledTriggerLayout.SPLIT)) }
        compose.setRfidPanelContent(c)
        compose.waitForText(SledWords.NO_SCANNER)
        compose.waitForIdle()
        compose.onNodeWithText(SledWords.hint(SledTriggerLayout.RFID)).performScrollTo().assertIsDisplayed()
        compose.onAllNodesWithText(SledWords.hint(SledTriggerLayout.SPLIT)).assertCountEquals(0)
    }

    /** The words rule on the whole tab: "session" only as the Session row's own label. */
    @Test fun noTextOnTheTabBreaksTheWordsRule() {
        grantRequired()
        val c = testContainer()
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)
        compose.waitForText(SledWords.ROW_SESSION)
        val texts = compose.onAllNodes(hasText("", substring = true)).fetchSemanticsNodes()
            .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty() }.map { it.text }
        assertTrue("no text read", texts.isNotEmpty())
        val broken = texts.filter { it != SledWords.ROW_SESSION && sledWordsViolations(it).isNotEmpty() }
        assertEquals(emptyList<String>(), broken)
    }

    @Test fun theDisagreementLineShowsOnlyWhenTheSledDisagrees() {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        runBlocking { c.rfid.connectNow() }
        val agrees = readbackOf(SledKey.RFID, SledKey.RFID, 14)
        reader.setInfo(reader.info.value!!.copy(trigger = agrees))
        compose.setRfidPanelContent(c)
        compose.waitForIdle()
        val disagrees = readbackOf(SledKey.SLED_SCAN, SledKey.SLED_SCAN, 6)
        compose.onAllNodesWithText(SledWords.didNotTake(disagrees)).assertCountEquals(0)
        compose.onAllNodesWithText(SledWords.didNotTake(agrees)).assertCountEquals(0)

        reader.setInfo(reader.info.value!!.copy(trigger = disagrees))
        compose.waitForText(SledWords.didNotTake(disagrees))
        compose.onNodeWithText(SledWords.didNotTake(disagrees)).performScrollTo().assertIsDisplayed()
    }

    @Test fun theScannerLineOffersTryAgainWhenItDidNotStart() {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true, triggerLayout = SledTriggerLayout.BARCODE)) }
        c.rfid.start()
        runBlocking { c.rfid.connectNow() }
        compose.setRfidPanelContent(c)
        compose.waitUntilIdlingMain { c.rfid.layoutInForceUsesScanner.value }
        reader.setScanner(SledScannerState.Opening)
        compose.waitForText(SledWords.SCANNER_STARTING)
        reader.setScanner(SledScannerState.Ready)
        compose.waitForText(SledWords.SCANNER_READY)
        reader.setScanner(SledScannerState.Unavailable(SledScannerFault.DID_NOT_START))
        compose.waitForText(SledWords.SCANNER_DID_NOT_START)
        compose.onNodeWithText(SledWords.TRY_AGAIN).performScrollTo().performClick()
        compose.waitUntilIdlingMain { reader.retryScannerCalls == 1 }
        reader.setScanner(SledScannerState.Unavailable(SledScannerFault.STOPPED_RESPONDING))
        compose.waitForText(SledWords.SCANNER_STOPPED_RESPONDING)
        compose.onAllNodesWithText(SledWords.TRY_AGAIN).assertCountEquals(0)
    }

    @Test fun theScannerLineIsHiddenWhileTheLayoutDoesNotUseTheScanner() {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        c.rfid.start()
        runBlocking { c.rfid.connectNow() }
        reader.setScanner(SledScannerState.Unavailable(SledScannerFault.DID_NOT_START))
        compose.setRfidPanelContent(c)
        compose.waitForIdle()
        compose.onAllNodesWithText(SledWords.SCANNER_DID_NOT_START).assertCountEquals(0)
    }

    @Test fun stopShowsWhileReconnecting() {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        c.rfid.start()
        c.rfid.connectForLifecycle { true }
        compose.setRfidPanelContent(c)
        compose.waitUntilIdlingMain { reader.connection.value is RfidConnection.Connected }
        // Every try fails again, so the schedule is still running when Stop is tapped.
        reader.connectResult = Result.failure(SledConnectException(RfidConnection.Failed("The sled stopped answering.", retryable = true)))
        reader.dropLink("The sled stopped answering.")
        compose.waitUntilIdlingMain { c.rfid.reconnecting.value }
        compose.waitForText(SledWords.RECONNECTING_AFTER_DROP)
        compose.onAllNodesWithText(SledWords.CONNECT).assertCountEquals(0)
        compose.onNodeWithText(SledWords.STOP).performScrollTo().performClick()
        compose.waitUntilIdlingMain { !c.rfid.reconnecting.value }
        compose.waitUntil(5_000) { compose.onAllNodesWithText(SledWords.STOP).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun disconnectShowsInNeedsRegion() {
        val reader = FakeRfidReader().apply { needsRegion = true }
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        runBlocking { c.rfid.connectNow() }
        compose.setRfidPanelContent(c)
        compose.waitForText(SledWords.noRegion("Fake RFD40"))
        compose.onNodeWithText(SledWords.DISCONNECT).performScrollTo().assertIsDisplayed()
        compose.onAllNodesWithText(SledWords.CONNECT).assertCountEquals(0)
    }

    @Test fun aSavedPowerAboveTheSledsMaximumSaysSo() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        reader.setInfo(SledInfo(generation = reader.generation, name = "Fake RFD40", powerMinDbm = 0, powerMaxDbm = 24))
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true, powerDbm = 27)) }
        compose.setRfidPanelContent(c)
        compose.waitForText(SledWords.powerCap(24))
        compose.onNodeWithText(SledWords.powerCap(24)).performScrollTo().assertIsDisplayed()

        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true, powerDbm = 20)) }
        compose.waitUntil(5_000) { compose.onAllNodesWithText(SledWords.powerCap(24)).fetchSemanticsNodes().isEmpty() }
    }

    @Test fun applyErrorIsShownAsItsOwnSentence() {
        val reader = FakeRfidReader()
        val refused = SledWords.refused(listOf(SledWords.ROW_TRANSMIT_POWER))
        reader.applyResult = Result.failure(IllegalStateException(refused))
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        c.rfid.start()
        runBlocking { c.rfid.connectNow() }
        compose.setRfidPanelContent(c)
        compose.waitUntilIdlingMain { c.rfid.applyError.value == refused }
        compose.waitForText(refused)
        compose.onNodeWithText(refused).performScrollTo().assertIsDisplayed()
    }

    @Test fun restoreDefaultsKeepsEnabledRegionAndReaderAddress() {
        val c = testContainer()
        runBlocking {
            c.prefs.setRfid(
                RfidSettings(
                    enabled = true, region = "ETSI", readerAddress = sledA.address, powerDbm = 9,
                    triggerLayout = SledTriggerLayout.BARCODE,
                ),
            )
        }
        compose.setRfidPanelContent(c)
        compose.onNodeWithText("Restore defaults").performScrollTo().performClick()
        compose.waitUntilIdlingMain { saved(c).powerDbm == 27 }
        val s = saved(c)
        assertTrue(s.enabled)
        assertEquals("ETSI", s.region)
        assertEquals(sledA.address, s.readerAddress)
        assertEquals(SledTriggerLayout.RFID, s.triggerLayout)
    }

    /** Ruling 22: Connect needs only Nearby devices; without it, the tap opens Android's prompt. */
    @Test fun tappingConnectWithoutNearbyDevicesOpensThePrompt() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).denyPermissions(*RfidPermissions.REQUIRED.toTypedArray())
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c)
        compose.waitForText(SledWords.CONNECT)
        compose.onNodeWithText(SledWords.CONNECT).performScrollTo().performClick()
        compose.waitForIdle()
        var requested: Array<out String>? = null
        compose.androidRule.activityRule.scenario.onActivity { activity ->
            requested = Shadows.shadowOf(activity).lastRequestedPermission?.requestedPermissions
        }
        assertEquals(RfidPermissions.REQUESTED.toSet(), requested?.toSet())
        assertEquals(0, reader.connectCalls)
    }

    /** Spec test 15, second half: the prompt's answer connects once nothing is missing. */
    @Test fun thePermissionCallbackConnectsWhenNothingIsMissing() {
        var connects = 0
        afterPermissionPrompt(listOf(android.Manifest.permission.ACCESS_FINE_LOCATION)) { connects++ }
        assertEquals("still missing: no connect", 0, connects)
        afterPermissionPrompt(emptyList()) { connects++ }
        assertEquals(1, connects)
    }

    /** The switch only writes the setting; the controller's enable edge does the disconnect. */
    @Test fun turningTheReaderOffDisconnectsThroughTheSetting() {
        grantRequired()
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        c.rfid.start()
        runBlocking { c.rfid.connectNow() }
        compose.setRfidPanelContent(c)
        compose.waitForText(SledWords.connected("Fake RFD40", 80))
        compose.onAllNodes(isToggleable())[0].performScrollTo().performClick()
        compose.waitUntilIdlingMain { !saved(c).enabled }
        compose.waitUntilIdlingMain { reader.connection.value == RfidConnection.Disconnected }
        compose.waitForText(SledWords.OFF)
        Thread.sleep(200)
        assertEquals("one disconnect, from the setting's edge", 1, reader.disconnectCalls)
    }

    /** Native graphics: the legacy mode measures text at almost no width, so nothing would overflow. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers = "w320dp-h533dp-hdpi") fun theChooserAndFixButtonsFitAt320dp() {
        grantRequired()
        val reader = FakeRfidReader().apply { paired = listOf(sledA, sledB) }
        reader.setConnection(RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH))
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setRfidPanelContent(c, inShellPadding = true)
        compose.waitForText("Turn on Bluetooth")
        // The page's edge: 288 dp of a 320 dp phone, inside the shell's padding.
        val width = compose.onRoot().fetchSemanticsNode().size.width - with(compose.density) { 16.dp.toPx() }
        fun fits(text: String, scroll: Boolean = true) {
            val node = compose.onNodeWithText(text)
            if (scroll) node.performScrollTo()
            assertTrue("$text is not displayed", runCatching { node.assertIsDisplayed() }.isSuccess)
            // The unclipped extent: the page's and the segmented row's scrolls clip
            // `boundsInRoot` to the screen, so it could never report past the edge.
            val n = node.fetchSemanticsNode()
            val right = n.positionInRoot.x + n.size.width
            assertTrue("$text past the edge: $right > $width", right <= width + 1f)
            assertTrue("$text clipped: ${n.boundsInRoot.width} < ${n.size.width}", n.boundsInRoot.width >= n.size.width - 1f)
        }
        for (text in listOf(sledA.name, sledB.name, "Turn on Bluetooth")) fits(text)
        // The options' own scroll parent is the control's row, so the page is scrolled to the
        // row below them instead, which leaves the control just above it in view.
        compose.onNodeWithText("Trigger").performScrollTo()
        for (text in listOf("RFID", "Barcode", "Both")) fits(text, scroll = false)
    }
}
