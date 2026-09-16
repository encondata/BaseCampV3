package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class DeveloperRfidBurstTest {
    @get:Rule val compose = createComposeRule()

    /** The point of the control: prove the RFID path on a phone with no sled.
     *  The controller is armed here (as `RfidControllerTest` arms it directly)
     *  purely so the burst has somewhere to land while we watch it — it is
     *  NOT how the button behaves inside the real app; see the second test
     *  below for that. */
    @Test fun theSyntheticBurstRunsAnInventoryOnTheFakeReader() {
        val c = testContainer()
        runBlocking { c.prefs.setDevMode(true) }
        c.rfid.start(); c.rfid.arm()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { DeveloperPanel() } } }
        compose.onNodeWithText("Simulate an RFID sweep").performClick()
        compose.waitForIdle()
        Thread.sleep(200)
        val fake = c.rfidReader as FakeRfidReader
        assertTrue("the fake should have been driven", fake.connectCalls > 0)
    }

    /** The honest scope of the button: `DeveloperPanel` lives on the Settings
     *  screen, and only `ScanScreen` ever calls `container.rfid.arm()`. So in
     *  the real app the controller is never armed while this button is
     *  visible, and the burst it drives must not reach the live panel or
     *  queue anything to the outbox — it only proves the reader adapter and
     *  its settings push work. This is a regression guard against routing
     *  the button through `arm()`/`disarm()` to fake a panel demo. */
    @Test fun theSimulatedBurstNeverReachesTheLivePanelOrTheOutbox() {
        val c = testContainer()
        runBlocking { c.prefs.setDevMode(true) }
        c.rfid.start() // deliberately NOT armed — matches how Settings actually renders this panel.
        val bursts = mutableListOf<List<String>>()
        val observer = CoroutineScope(Dispatchers.Default + SupervisorJob())
        observer.launch { c.rfid.bursts.collect { bursts += it } }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { DeveloperPanel() } } }
        compose.onNodeWithText("Simulate an RFID sweep").performClick()
        compose.waitForIdle()
        Thread.sleep(400)
        val fake = c.rfidReader as FakeRfidReader
        assertTrue("the fake should still have been driven", fake.connectCalls > 0)
        assertTrue("no burst should have reached the outbox: the controller is never armed on Settings", bursts.isEmpty())
        assertTrue("the live panel's session should never have opened", c.rfid.session.value == null)
        observer.cancel()
    }
}
