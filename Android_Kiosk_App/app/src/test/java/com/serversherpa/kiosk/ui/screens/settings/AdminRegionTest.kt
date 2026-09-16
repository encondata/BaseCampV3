package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Admin tab's "RFID region" row: the compliance control from
 *  `2026-09-16-android-rfd40-region-design.md`. The list always comes from
 *  the reader, never a list this app keeps, so these tests drive
 *  [FakeRfidReader.reportedRegions] rather than asserting on a fixed set of
 *  region names. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class AdminRegionTest {
    @get:Rule val compose = createComposeRule()

    // Same reasoning as RfidPanelTest.setRfidPanelContent: KioskShell wraps
    // every real screen in its own Modifier.verticalScroll, so composing the
    // panel bare here would leave a row below the fold unreachable by a
    // click even though Compose can still find it by text.
    private fun ComposeContentTestRule.setAdminPanelContent(c: AppContainer) {
        setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme {
                    Column(Modifier.verticalScroll(rememberScrollState())) { AdminPanel() }
                }
            }
        }
    }

    private val usa = RfidRegion("USA", "United States", hoppingConfigurable = false, channels = emptyList())
    private val eu = RfidRegion("ETSI", "Europe", hoppingConfigurable = false, channels = emptyList())

    @Test fun withNoReaderConnectedTheRowSaysToConnectAndOffersNoChoice() {
        val c = testContainer()
        compose.setAdminPanelContent(c)
        compose.onNodeWithText("Connect the reader to see its regions.").performScrollTo().assertIsDisplayed()
    }

    @Test fun withExactlyOneReportedRegionTheRowStatesItAndOffersNoChoice() {
        val reader = FakeRfidReader()
        reader.reportedRegions = RfidRegions(listOf(usa), "USA")
        val c = testContainer(reader)
        runBlocking { c.rfid.connectNow() }
        compose.setAdminPanelContent(c)
        compose.waitForIdle()
        compose.onNodeWithText("This reader supports only United States (USA).").performScrollTo().assertIsDisplayed()
    }

    @Test fun withTwoReportedRegionsPickingTheOtherReachesTheReader() {
        val reader = FakeRfidReader()
        reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        val c = testContainer(reader)
        runBlocking { c.rfid.connectNow() }
        compose.setAdminPanelContent(c)
        compose.waitForIdle()

        compose.onNodeWithText("Europe").performScrollTo().performClick()
        compose.waitForIdle()

        assertEquals("ETSI" to null, reader.lastRegionSet)
    }

    @Test fun batteryPercentageChangeAloneDoesNotReloadRegions() {
        val reader = FakeRfidReader()
        reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        val c = testContainer(reader)
        runBlocking { c.rfid.connectNow() }
        compose.setAdminPanelContent(c)
        compose.waitForIdle()

        val initialCallCount = reader.regionsCalls
        // Initial load should have called regions()
        assertEquals(1, initialCallCount)

        // Simulate a battery level change by pushing a new Connected state
        // with a different battery percentage. This should not trigger a
        // regions() call because only the battery changed, not the
        // connection status itself.
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 75))
        compose.waitForIdle()

        assertEquals(initialCallCount, reader.regionsCalls)
    }
}
