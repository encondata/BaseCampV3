package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.SledBarcode
import com.serversherpa.kiosk.core.rfid.SledInfo
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.waitUntilIdlingMain
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.rules.RuleChain
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowBuild

/** Spec tests 36 and 37 (T14): the sled's controls in the scan screens' tool row, per host. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class ScanToolsTest {
    private val compose = createComposeRule()

    // Waits out a font copy before a native-graphics test (see NativeFontsSettled).
    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    /** With [inShellPadding], inside the 16 dp page padding KioskShell gives every screen. */
    private fun show(c: AppContainer, inShellPadding: Boolean = false) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { Column(if (inShellPadding) Modifier.padding(16.dp) else Modifier) { ScanTools(showTrigger = false, onTrigger = {}) } }
            }
        }
        compose.waitForIdle()
    }

    private fun count(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().size
    private fun countTag(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().size

    @Test fun aPhoneShowsTheSledTriggersWhileConnected() {
        val reader = FakeRfidReader()
        val c = testContainer(reader)
        show(c)
        assertEquals("nothing while not connected", 0, count("Both"))
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        compose.waitForIdle()
        compose.onNodeWithText("Sled triggers").assertIsDisplayed()
        for (label in listOf("RFID", "Barcode", "Both")) compose.onNodeWithText(label).assertIsDisplayed()
    }

    @Test fun aSledKnownToLackAScannerShowsNoTriggers() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        reader.setInfo(SledInfo(generation = reader.generation, name = "Fake RFD40", hasScanner = false))
        show(testContainer(reader))
        assertEquals(0, count("Both"))
        assertEquals(0, count("Sled triggers"))
    }

    @Test fun theSledScanButtonShowsOnlyWhileTheScannerIsReady() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        show(testContainer(reader))
        assertEquals("not while the scanner is off", 0, countTag("sled-scan"))
        reader.setScanner(SledScannerState.Opening)
        compose.waitForIdle()
        assertEquals("not while it is starting", 0, countTag("sled-scan"))
        reader.setScanner(SledScannerState.Ready)
        compose.waitForIdle()
        compose.onNodeWithTag("sled-scan").assertIsDisplayed().performClick()
        compose.waitUntilIdlingMain { reader.softScans.isNotEmpty() }
        assertEquals(listOf(true), reader.softScans)
        // The first barcode lets go of the soft trigger.
        reader.emitBarcode(SledBarcode("102466", "Code 128"))
        compose.waitUntilIdlingMain { reader.softScans.size == 2 }
        assertEquals(listOf(true, false), reader.softScans)
    }

    @Test fun pickingBothWritesTheSplitLayout() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        val c = testContainer(reader)
        show(c)
        compose.onNodeWithText("Both").performClick()
        compose.waitUntilIdlingMain { runBlocking { c.prefs.rfid.first() }.triggerLayout == SledTriggerLayout.SPLIT }
        assertEquals(SledTriggerLayout.SPLIT, runBlocking { c.prefs.rfid.first() }.triggerLayout)
    }

    /** The MC2200 (API 30, a Zebra manufacturer): its own scanner reads barcodes, so the scan
     *  screens show no sled control at all. `isZebraHost` is read once, when the container is built. */
    @Test @Config(sdk = [30]) fun aZebraHostShowsNoSledControl() {
        ShadowBuild.setManufacturer("Zebra Technologies")
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        reader.setScanner(SledScannerState.Ready)
        val c = testContainer(reader)
        assertTrue(c.isZebraHost)
        show(c)
        assertEquals(0, count("Both"))
        assertEquals(0, count("Sled triggers"))
        assertEquals(0, countTag("sled-scan"))
    }

    /** Native graphics: the legacy mode measures text at almost no width, so nothing would
     *  overflow. Inside the shell's page padding, as on a real 320 dp phone: 288 dp to fit in. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) @Config(qualifiers = "w320dp-h533dp-hdpi") fun everySledControlFitsAt320dp() {
        val reader = FakeRfidReader()
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        reader.setScanner(SledScannerState.Ready)
        show(testContainer(reader), inShellPadding = true)
        val width = compose.onRoot().fetchSemanticsNode().size.width - with(compose.density) { 16.dp.toPx() }
        // The unclipped extent: `boundsInRoot` is clipped by the segmented row's own
        // horizontal scroll, so an option pushed half out of view would still pass on it.
        fun SemanticsNodeInteraction.inside() = apply {
            val n = assertIsDisplayed().fetchSemanticsNode()
            val right = n.positionInRoot.x + n.size.width
            assertTrue("past the page's edge: $right > $width", right <= width + 1f)
            assertTrue("clipped: ${n.boundsInRoot.width} < ${n.size.width}", n.boundsInRoot.width >= n.size.width - 1f)
        }
        for (label in listOf("RFID", "Barcode", "Both")) compose.onNodeWithText(label).inside()
        compose.onNodeWithTag("sled-scan").inside()
    }
}
