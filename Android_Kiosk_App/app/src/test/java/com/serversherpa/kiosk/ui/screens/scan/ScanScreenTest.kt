package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * I7: a screen-level test for just the one finding this task fixes — the
 * Scanning screen never said anything when the reader dropped mid-visit.
 * `ScanScreen` otherwise has no screen-level Compose test coverage yet (a
 * known gap noted on the branch's own ledger); this deliberately does not
 * try to cover the rest of the screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class ScanScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun aDisconnectWhileArmedShowsAToastOnScreen() {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { ScanScreen(rememberNavController()) }
            }
        }
        compose.waitForIdle()

        reader.setConnection(RfidConnection.Failed("The reader disconnected."))
        compose.waitForIdle()

        compose.onNodeWithText("The reader disconnected.").assertIsDisplayed()
    }
}
