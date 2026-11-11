package com.serversherpa.kiosk.ui.screens.settings

import android.app.Application
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
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
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

/** The Devices tab: the "RFID reader" row says what the RFID tab and the scan screens say. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class DevicesPanelTest {
    @get:Rule val compose = createComposeRule()

    private fun waitForText(text: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    @Test fun theRfidReaderRowShowsTheSledLine() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).grantPermissions(*RfidPermissions.REQUIRED.toTypedArray())
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH))
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { Column { DevicesPanel() } } } }
        waitForText(SledWords.BLUETOOTH_OFF)

        reader.setConnection(RfidConnection.Connected("RFD4031", 74))
        waitForText(SledWords.connected("RFD4031", 74))

        runBlocking { c.prefs.setRfid(RfidSettings(enabled = false)) }
        waitForText(SledWords.OFF)
    }

    /** The same rows as the RFID tab: a missing permission is what the row says, not the failure. */
    @Test fun theRfidReaderRowSaysAPermissionIsMissing() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).denyPermissions(*RfidPermissions.REQUIRED.toTypedArray())
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Failed(SledWords.BLUETOOTH_OFF, fix = SledFix.TURN_ON_BLUETOOTH))
        val c = testContainer(reader)
        runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { Column { DevicesPanel() } } } }
        waitForText(SledWords.PERMISSION_MISSING)
    }

    @Test fun theDataWedgeRowIsUnchanged() {
        val c = testContainer()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { Column { DevicesPanel() } } } }
        compose.onNodeWithText("Zebra DataWedge").assertIsDisplayed()
        compose.onNodeWithText("Scans from the built-in scan engine arrive through DataWedge as intents.").assertIsDisplayed()
        compose.onNodeWithText("Not installed on this device").assertIsDisplayed()
    }
}
