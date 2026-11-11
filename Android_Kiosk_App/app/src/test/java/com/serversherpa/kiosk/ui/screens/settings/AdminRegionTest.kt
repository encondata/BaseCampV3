package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegion
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.SledConnectRequest
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.waitUntilIdlingMain
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
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

    /** A region load is a job on the controller's queue, answered from its
     *  consumer's thread, so the list shows a moment after the panel idles. */
    private fun ComposeContentTestRule.waitForText(text: String) {
        waitUntil(5_000) { onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
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
        compose.waitForText("This reader supports only United States (USA).")
        compose.onNodeWithText("This reader supports only United States (USA).").performScrollTo().assertIsDisplayed()
    }

    @Test fun withTwoReportedRegionsPickingTheOtherReachesTheReader() {
        val reader = FakeRfidReader()
        reader.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        val c = testContainer(reader)
        runBlocking { c.rfid.connectNow() }
        compose.setAdminPanelContent(c)
        compose.waitForText("Europe")

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
        compose.waitForText("Europe")

        val initialCallCount = reader.regionsCalls
        // Initial load should have called regions()
        assertEquals(1, initialCallCount)

        // Simulate a battery level change by pushing a new Connected state
        // with a different battery percentage. This should not trigger a
        // regions() call because only the battery changed, not the
        // connection status itself.
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 75))
        compose.waitForIdle()
        // Region loads run one at a time, in the order queued, so a load
        // awaited here finishes after any load the battery change queued.
        runBlocking { c.rfid.loadRegions() }

        assertEquals("only the load just awaited", initialCallCount + 1, reader.regionsCalls)
    }

    /** The fake, with a region list that can fail and a connect that can be held open. */
    private class AdminReader(val inner: FakeRfidReader = FakeRfidReader()) : RfidReader by inner {
        @Volatile var regionsFailure: Throwable? = null
        @Volatile var connectGate: CompletableDeferred<Unit>? = null

        override suspend fun regions(): Result<RfidRegions> = regionsFailure?.let { Result.failure(it) } ?: inner.regions()

        override suspend fun connect(request: SledConnectRequest): Result<Unit> {
            connectGate?.await()
            return inner.connect(request)
        }
    }

    @Test fun aFailedRegionLoadOffersRetry() {
        val reader = AdminReader()
        reader.inner.reportedRegions = RfidRegions(listOf(usa, eu), "USA")
        reader.regionsFailure = IllegalStateException(SledWords.REGIONS_FAILED)
        val c = testContainer(reader)
        runBlocking { c.rfid.connectNow() }
        compose.setAdminPanelContent(c)
        compose.waitForText(SledWords.REGIONS_FAILED)

        reader.regionsFailure = null
        compose.onNodeWithText(SledWords.RETRY).performScrollTo().performClick()
        compose.waitForText("Europe")
        assertEquals(0, compose.onAllNodesWithText(SledWords.REGIONS_FAILED).fetchSemanticsNodes().size)
    }

    /** A sled with no region set is up but cannot read: its region list is what fixes it. */
    @Test fun regionsLoadInNeedsRegion() {
        val reader = FakeRfidReader()
        reader.needsRegion = true
        reader.reportedRegions = RfidRegions(listOf(usa, eu), null)
        val c = testContainer(reader)
        runBlocking { c.rfid.connectNow() }
        assertEquals(RfidConnection.NeedsRegion("Fake RFD40"), reader.connection.value)
        compose.setAdminPanelContent(c)
        compose.waitForText("Europe")
    }

    /** After the first region is set the sled has to be set up again: the row says so until
     *  the reconnect is done, then shows the list again, and the region is saved. */
    @Test fun settingARegionOnASledWithNoneSaysReconnecting() {
        val reader = AdminReader()
        reader.inner.needsRegion = true
        reader.inner.reportedRegions = RfidRegions(listOf(usa, eu), null)
        val c = testContainer(reader)
        runBlocking { c.rfid.connectNow() }
        compose.setAdminPanelContent(c)
        compose.waitForText("Europe")

        reader.inner.needsRegion = false
        val gate = CompletableDeferred<Unit>()
        reader.connectGate = gate
        compose.onNodeWithText("Europe").performScrollTo().performClick()
        compose.waitForText(SledWords.REGION_SET_RECONNECTING)
        assertEquals("ETSI" to null, reader.inner.lastRegionSet)

        gate.complete(Unit)
        compose.waitUntil(5_000) { compose.onAllNodesWithText(SledWords.REGION_SET_RECONNECTING).fetchSemanticsNodes().isEmpty() }
        compose.waitForText("Europe")
        assertEquals(RfidConnection.Connected("Fake RFD40", 80), reader.connection.value)
        compose.waitUntilIdlingMain { runBlocking { c.prefs.rfid.first() }.region == "ETSI" }
    }
}
