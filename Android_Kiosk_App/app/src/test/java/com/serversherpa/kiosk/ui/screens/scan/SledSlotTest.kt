package com.serversherpa.kiosk.ui.screens.scan

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.rfid.SledConnectException
import com.serversherpa.kiosk.waitUntilIdlingMain
import org.junit.rules.RuleChain
import org.robolectric.annotation.GraphicsMode
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.rules.ActivityScenarioRule
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidPermissions
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

/** The scan-screen slot: one sled line under the scan box, red for a drop during the visit. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class SledSlotTest {
    private val compose = createComposeRule()

    // Waits out a font copy before a native-graphics test (see NativeFontsSettled).
    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    /** Robolectric grants nothing; with a permission missing every line would be the permission one. */
    @Before fun grant() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).grantPermissions(*RfidPermissions.REQUIRED.toTypedArray())
    }

    private fun rig(reader: FakeRfidReader, enabled: Boolean = true): AppContainer =
        testContainer(reader).also { c -> runBlocking { c.prefs.setRfid(RfidSettings(enabled = enabled)) } }

    /** With [inShellPadding], inside the 16 dp page padding KioskShell gives every screen. */
    private fun show(c: AppContainer, inShellPadding: Boolean = false) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { Column(if (inShellPadding) Modifier.padding(SHELL_PAD) else Modifier) { SledSlot() } }
            }
        }
        compose.waitForIdle()
    }

    private fun countTag(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().size
    private fun waitFor(tag: String, text: String) = compose.waitUntil(5_000) {
        compose.onAllNodes(hasTestTag(tag) and hasText(text)).fetchSemanticsNodes().isNotEmpty()
    }

    @Test fun aDropDuringTheVisitIsRed() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        show(rig(reader))
        assertEquals("nothing while connected and working", 0, countTag("sled-slot-red") + countTag("sled-slot-muted"))
        reader.dropLink("The sled stopped answering.")
        waitFor("sled-slot-red", "The sled stopped answering.")
        assertEquals(1, countTag("sled-slot-red"))
        assertEquals(0, countTag("sled-slot-muted"))
    }

    @Test fun aStateAlreadyThereAtOpenIsMuted() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Failed(SledWords.couldNotReach("Fake RFD40"), fix = SledFix.CONNECT))
        show(rig(reader))
        waitFor("sled-slot-muted", SledWords.couldNotReach("Fake RFD40"))
        assertEquals(0, countTag("sled-slot-red"))
        compose.onNodeWithText(SledWords.CONNECT).assertIsDisplayed()
    }

    /** Native graphics: the legacy mode measures text at almost no width, so nothing would
     *  overflow. Inside the shell's page padding, as on a real 320 dp phone: 288 dp to fit in. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers = "w320dp-h533dp-hdpi")
    fun theFixButtonSitsUnderTheSentenceAndFitsAt320dp() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH))
        show(rig(reader), inShellPadding = true)
        waitFor("sled-slot-muted", SledWords.BLUETOOTH_OFF)
        val edge = compose.onRoot().fetchSemanticsNode().size.width - with(compose.density) { SHELL_PAD.toPx() }
        // The unclipped extent: `boundsInRoot` is clipped to the root, so it could never
        // report past the edge.
        val sentence = compose.onNodeWithText(SledWords.BLUETOOTH_OFF).assertIsDisplayed().fetchSemanticsNode()
        val button = compose.onNodeWithText("Turn on Bluetooth").assertIsDisplayed().fetchSemanticsNode()
        val sentenceBottom = sentence.positionInRoot.y + sentence.size.height
        assertTrue("the button is under the sentence: ${button.positionInRoot.y} < $sentenceBottom", button.positionInRoot.y >= sentenceBottom - 1f)
        for ((label, n) in listOf("button" to button, "sentence" to sentence)) {
            val right = n.positionInRoot.x + n.size.width
            assertTrue("the $label is past the page's edge: $right > $edge", right <= edge + 1f)
            assertTrue("the $label is clipped: ${n.boundsInRoot.width} < ${n.size.width}", n.boundsInRoot.width >= n.size.width - 1f)
        }
    }

    /**
     * Row 14 with the controller running (hardware script step 14): the sled was already out
     * of reach when the screen opened, a retryable failure with no `info`. Opening the screen
     * starts the reconnect schedule, which changes the line to "Connecting to the sled…" with
     * Stop. That is not a drop during the visit: it stays muted, through a failed try and after
     * the schedule ends.
     */
    @Test fun aSledAlreadyOutOfReachStaysMutedThroughTheTriesOpeningTheScreenStarts() {
        val reader = FakeRfidReader()
        val unreachable = RfidConnection.Failed(SledWords.couldNotReach("Fake RFD40"), retryable = true, fix = SledFix.CONNECT)
        reader.connectResult = Result.failure(SledConnectException(unreachable))
        val c = rig(reader)
        c.rfid.start()
        c.rfid.connectForLifecycle { true }
        compose.waitUntilIdlingMain { reader.connection.value == unreachable && reader.connectCalls == 1 }
        show(c)
        waitFor("sled-slot-muted", unreachable.reason)
        // What SledScreenSignal does once the screen's first frame is in.
        c.rfid.setSledScreenOpen(true)
        waitFor("sled-slot-muted", SledWords.connectingTo(null))
        compose.onNodeWithText(SledWords.STOP).assertIsDisplayed()
        assertEquals(0, countTag("sled-slot-red"))
        // Try 1 (2 s on) fails too; the schedule goes on, muted.
        compose.waitUntilIdlingMain(5_000) { reader.connectCalls == 2 }
        compose.waitForIdle()
        assertTrue(c.rfid.reconnecting.value)
        assertEquals(0, countTag("sled-slot-red"))
        // The schedule ends (Stop here; giving up leaves the same state): the reason, muted.
        c.rfid.stopReconnecting()
        waitFor("sled-slot-muted", unreachable.reason)
        assertEquals(0, countTag("sled-slot-red"))
    }

    /** Granted in Android's Settings and back: the slot reads the permission again on resume. */
    @Test fun aPermissionGrantedWhileAwayIsReadAgainOnResume() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).denyPermissions(*RfidPermissions.REQUIRED.toTypedArray())
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH))
        show(rig(reader))
        compose.waitUntil(5_000) { compose.onAllNodes(hasText(SledWords.PERMISSION_MISSING)).fetchSemanticsNodes().isNotEmpty() }

        Shadows.shadowOf(app).grantPermissions(*RfidPermissions.REQUIRED.toTypedArray())
        compose.androidRule.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        compose.androidRule.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitUntil(5_000) { compose.onAllNodes(hasText(SledWords.BLUETOOTH_OFF)).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(0, compose.onAllNodes(hasText(SledWords.PERMISSION_MISSING)).fetchSemanticsNodes().size)
    }

    /** See `RfidPanelTest.androidRule`: the rule's activity, to drive its lifecycle. */
    @Suppress("UNCHECKED_CAST")
    private val ComposeContentTestRule.androidRule
        get() = this as AndroidComposeTestRule<ActivityScenarioRule<ComponentActivity>, ComponentActivity>

    @Test fun nothingShowsWhileTheReaderIsOff() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH))
        show(rig(reader, enabled = false))
        Thread.sleep(200)
        compose.waitForIdle()
        reader.dropLink("The sled stopped answering.")
        compose.waitForIdle()
        assertEquals(0, countTag("sled-slot-red") + countTag("sled-slot-muted"))
        assertEquals(0, compose.onAllNodes(hasText("Turn on Bluetooth")).fetchSemanticsNodes().size)
    }

    private companion object {
        /** KioskShell's page padding (KioskShell.kt). */
        val SHELL_PAD = 16.dp
    }
}
