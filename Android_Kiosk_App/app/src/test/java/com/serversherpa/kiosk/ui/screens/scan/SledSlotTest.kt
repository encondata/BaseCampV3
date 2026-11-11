package com.serversherpa.kiosk.ui.screens.scan

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
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

/** The scan-screen slot: one sled line under the scan box, red for a change during the visit. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class SledSlotTest {
    @get:Rule val compose = createComposeRule()

    /** Robolectric grants nothing; with a permission missing every line would be the permission one. */
    @Before fun grant() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).grantPermissions(*RfidPermissions.REQUIRED.toTypedArray())
    }

    private fun rig(reader: FakeRfidReader, enabled: Boolean = true): AppContainer =
        testContainer(reader).also { c -> runBlocking { c.prefs.setRfid(RfidSettings(enabled = enabled)) } }

    private fun show(c: AppContainer) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { Column { SledSlot() } } }
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

    @Test @Config(qualifiers = "w320dp-h533dp-hdpi") fun theFixButtonSitsUnderTheSentenceAndFitsAt320dp() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH))
        show(rig(reader))
        waitFor("sled-slot-muted", SledWords.BLUETOOTH_OFF)
        val width = compose.onRoot().fetchSemanticsNode().size.width
        val sentence = compose.onNodeWithText(SledWords.BLUETOOTH_OFF).assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val button = compose.onNodeWithText("Turn on Bluetooth").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("the button is under the sentence: ${button.top} < ${sentence.bottom}", button.top >= sentence.bottom - 1f)
        assertTrue("clipped: ${button.right} > $width", button.right <= width + 1f)
        assertTrue("clipped: ${sentence.right} > $width", sentence.right <= width + 1f)
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
}
