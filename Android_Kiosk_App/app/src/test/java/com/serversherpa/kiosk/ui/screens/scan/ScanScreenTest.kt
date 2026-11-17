package com.serversherpa.kiosk.ui.screens.scan

import android.app.Application
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.Lifecycle
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidPermissions
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.waitUntilIdlingMain
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.core.scan.displayRfid
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.rules.RuleChain
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Scanning screen: the sled slot under the scan box (row 14: it replaces the
 * transition toast), the sled controls in its tool row, its buttons at 320 dp, and a burst
 * read while the activity is in the background still reaching the outbox (spec test 28, T6).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class ScanScreenTest {
    private val compose = createAndroidComposeRule<ComponentActivity>()

    // Waits out a font copy before a native-graphics test (see NativeFontsSettled).
    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    /** Robolectric grants nothing; with a permission missing every line would be the permission one. */
    @Before fun grant() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app).grantPermissions(*RfidPermissions.REQUIRED.toTypedArray())
    }

    private fun rig(reader: FakeRfidReader): AppContainer =
        testContainer(reader).also { c -> runBlocking { c.prefs.setRfid(RfidSettings(enabled = true)) } }

    /** The screen on a scrolling page with the page's 16 dp padding, as KioskShell hosts it. */
    private fun show(c: AppContainer) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) { ScanScreen(rememberNavController()) } }
            }
        }
        compose.waitForIdle()
    }

    private fun countTag(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().size
    private fun waitFor(tag: String, text: String) = compose.waitUntil(5_000) {
        compose.onAllNodes(hasTestTag(tag) and hasText(text)).fetchSemanticsNodes().isNotEmpty()
    }

    @Test fun aDropDuringTheVisitShowsTheRedLineOnce() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        show(rig(reader))
        assertEquals(0, countTag("sled-slot-red"))

        reader.dropLink("The sled stopped answering.")
        waitFor("sled-slot-red", "The sled stopped answering.")
        assertEquals(1, countTag("sled-slot-red"))
        assertEquals(1, compose.onAllNodesWithText("The sled stopped answering.").fetchSemanticsNodes().size)
    }

    /** A kiosk whose reader is enabled but whose sled is out of reach must not open Scanning
     *  under a red line it did nothing to cause: what was already there is muted. */
    @Test fun aStateAlreadyThereAtOpenShowsTheMutedLineNeverRed() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Failed(SledWords.couldNotReach("Fake RFD40")))
        show(rig(reader))
        waitFor("sled-slot-muted", SledWords.couldNotReach("Fake RFD40"))
        Thread.sleep(200)
        compose.waitForIdle()
        assertEquals(0, countTag("sled-slot-red"))
    }

    /** Spec test 28 (T6): the activity moved to CREATED (the screen off, the sled still in the
     *  hand) — a burst the controller emits then still lands in the outbox, one row per tag. */
    @Test fun aBurstEmittedWhileTheActivityIsCreatedReachesTheOutbox() {
        val reader = FakeRfidReader()
        val c = rig(reader)
        runBlocking {
            c.db.assets().insertAll(listOf(KioskAssetRow("a1", "A-1", "Rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity()))
            c.prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        }
        c.rfid.start()
        show(c)
        runBlocking { c.rfid.connectNow() }
        compose.waitForIdle()
        Thread.sleep(250)
        compose.waitForIdle()

        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        reader.emitTrigger(TriggerEvent.PRESSED)
        waitMain { reader.inventoryRunning }
        reader.emitTag("100348"); reader.emitTag("100999")
        Thread.sleep(100)
        reader.emitTrigger(TriggerEvent.RELEASED)
        waitMain { runBlocking { c.db.outbox().all().size } == 2 }
        val rows = runBlocking { c.db.outbox().all() }
        assertEquals(setOf("100348", "100999"), rows.map { displayRfid(it.scannedValue) }.toSet())
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
    }

    /** Polls [condition] while running the main looper, without Compose's idling (the activity may be stopped). */
    private fun waitMain(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            assertTrue("timed out", System.currentTimeMillis() < deadline)
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(20)
        }
    }

    /** Native graphics: the legacy mode measures text at almost no width, so all three would fit on one line. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers = "w320dp-h533dp-hdpi") fun theThreeButtonsWrapAt320dp() {
        show(rig(FakeRfidReader()))
        // The page's edge: 288 dp of a 320 dp phone, inside the shell's padding.
        val width = compose.onRoot().fetchSemanticsNode().size.width - with(compose.density) { 16.dp.toPx() }
        // The unclipped extent: the page's scroll clips `boundsInRoot` to the screen, so a
        // button squeezed or pushed past the edge would still pass on it.
        fun node(label: String) = compose.onNodeWithText(label).performScrollTo().assertIsDisplayed().fetchSemanticsNode()
        for (label in listOf("Retry failed", "Clear sent", "Discard failed")) {
            val n = node(label)
            val right = n.positionInRoot.x + n.size.width
            assertTrue("$label past the edge: $right > $width", right <= width + 1f)
            assertTrue("$label clipped: ${n.boundsInRoot.width} < ${n.size.width}", n.boundsInRoot.width >= n.size.width - 1f)
        }
        // The third button wraps onto a line of its own (both read after one scroll).
        val third = node("Discard failed")
        val first = compose.onNodeWithText("Retry failed").fetchSemanticsNode()
        assertTrue(
            "Discard failed is not on a second line: ${third.positionInRoot.y} < ${first.positionInRoot.y + first.size.height}",
            third.positionInRoot.y >= first.positionInRoot.y + first.size.height - 1f,
        )
    }

    /** Tapping Barcode brings up "Starting the sled's barcode scanner…" in the slot; the slot
     *  sits under the tool row, so the Sled triggers control under the operator's finger stays
     *  where it was while the line comes and goes. */
    @Test fun theSledControlsDoNotMoveWhenTheSlotLineAppears() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        show(rig(reader))
        val control = compose.onNodeWithText("Barcode").performScrollTo().assertIsDisplayed()
        val before = control.fetchSemanticsNode().positionInRoot.y

        reader.setScanner(SledScannerState.Opening)
        waitFor("sled-slot-muted", SledWords.SCANNER_STARTING)
        assertEquals("the control stays put", before, control.fetchSemanticsNode().positionInRoot.y, 0.5f)
        val slot = compose.onNodeWithText(SledWords.SCANNER_STARTING).fetchSemanticsNode().positionInRoot.y
        assertTrue("the slot line is under the tool row", slot > before)

        reader.setScanner(SledScannerState.Ready)
        compose.waitUntilIdlingMain { compose.onAllNodesWithText(SledWords.SCANNER_STARTING).fetchSemanticsNodes().isEmpty() }
        assertEquals(before, control.fetchSemanticsNode().positionInRoot.y, 0.5f)
    }

    @Test fun theSledControlsShowWhileTheSledIsConnected() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        show(rig(reader))
        compose.onNodeWithText("Barcode").performScrollTo().assertIsDisplayed()
    }
}
