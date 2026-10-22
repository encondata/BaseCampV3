package com.serversherpa.kiosk.ui.screens.labels

import android.app.Application
import android.bluetooth.BluetoothAdapter
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.labels.LabelBuildStatus
import com.serversherpa.kiosk.core.labels.LabelPick
import com.serversherpa.kiosk.core.labels.PrintEntry
import com.serversherpa.kiosk.core.labels.PrintState
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.printer.BLUETOOTH_DENIED_TEXT
import com.serversherpa.kiosk.core.printer.BLUETOOTH_OFF_TEXT
import com.serversherpa.kiosk.core.printer.BLUETOOTH_SCAN_HINT_TEXT
import com.serversherpa.kiosk.core.printer.LOCATION_OFF_TEXT
import com.serversherpa.kiosk.core.printer.pairingLostText
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.labels.LabelEngine
import com.serversherpa.kiosk.data.labels.LabelSettingsStore
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.printer.BluetoothAvailability
import com.serversherpa.kiosk.data.printer.FakeBluetoothPrinting
import com.serversherpa.kiosk.data.printer.FoundBluetoothPrinter
import com.serversherpa.kiosk.data.printer.PrinterGuard
import com.serversherpa.kiosk.data.printer.PrinterLock
import com.serversherpa.kiosk.data.printer.bluetoothUnavailableText
import com.serversherpa.kiosk.ui.theme.KioskTheme
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Bluetooth card and list on the 320 dp MC2200 (real fonts and native graphics, set on each
 * test so [NativeFontsSettled] sees it: only a real text layout can show a clipped line): Zebras
 * first with their signal and Connect, other devices folded away, the scan hint and Stop; and each
 * Bluetooth refusal with its message and a button that opens the right Android screen, on Printer
 * Setup's list, its checks and test labels, and Print Labels' card.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w320dp-h533dp-hdpi")
class BluetoothPrinterListTest {
    private val compose = createComposeRule()

    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    private val zebra = FoundBluetoothPrinter("AC:3F:A4:00:00:01", "D8J224508535", -52, advertisesZebra = false)
    private val renamed = FoundBluetoothPrinter("AC:3F:A4:00:00:02", "Dock 4 Zebra", -81, advertisesZebra = true)
    private val other = FoundBluetoothPrinter("11:22:33:44:55:66", "Jimmy's AirPods Pro", -40, advertisesZebra = false)

    private var ui by mutableStateOf(PrinterSetupUi())
    private val chosen = mutableListOf<FoundBluetoothPrinter>()
    private var stops = 0
    private var connects = 0

    /** Printer Setup's choose section as the screen lays it out, inside the shell's 16 dp gutters. */
    private fun show(saved: SavedPrinter? = null) = compose.setContent {
        KioskTheme {
            Column(Modifier.padding(horizontal = 16.dp)) {
                BluetoothCard(selected = ui.findMode == FindMode.BLUETOOTH, enabled = ui.bluetoothScanAllowed, onClick = {})
                BluetoothResults(ui, saved, onChoose = { chosen += it }, onStop = { stops++ }, onScanAgain = {})
                ui.pairingLost?.let { PairingLostNotice(it, onConnect = { connects++ }) }
            }
        }
    }

    private fun layoutOf(text: String): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        return layouts.single()
    }

    /** [text] shows in full on its lines (nothing ellipsized or cut off below), inside the screen. */
    private fun assertWhole(text: String) {
        val layout = layoutOf(text)
        val last = layout.lineCount - 1
        assertTrue("$text is ellipsized", !layout.isLineEllipsized(last))
        assertTrue("$text is cut off below", !layout.didOverflowHeight)
        assertEquals("$text lost characters", text.length, layout.getLineEnd(last, visibleEnd = true))
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("$text runs off the screen: $node in $root", node.left >= root.left && node.right <= root.right)
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theBluetoothListFitsA320dpHandheld() {
        ui = PrinterSetupUi(findMode = FindMode.BLUETOOTH, bluetoothScanning = true, bluetoothFound = listOf(zebra, renamed, other))
        show()

        for (text in listOf(
            "Bluetooth", "Find a Zebra printer nearby over Bluetooth.", "Looking for printers nearby…", "Stop",
            "D8J224508535", "Strong signal (-52 dBm)", "Dock 4 Zebra", "Weak signal (-81 dBm)",
            "Other devices (1)", "Show", BLUETOOTH_SCAN_HINT_TEXT,
        )) {
            compose.onNodeWithText(text).assertIsDisplayed()
            assertWhole(text)
        }
        compose.onAllNodesWithText("Connect").assertCountEquals(2)
        // Zebras first, in the scan's order.
        val first = compose.onNodeWithText("D8J224508535", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        val second = compose.onNodeWithText("Dock 4 Zebra", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top
        assertTrue(first < second)
        // Other devices stay folded until asked for.
        compose.onAllNodesWithText("Jimmy's AirPods Pro").assertCountEquals(0)
        compose.onNodeWithText("Show").performClick()
        compose.onNodeWithText("Jimmy's AirPods Pro").assertIsDisplayed()
        assertWhole("Jimmy's AirPods Pro")
        compose.onNodeWithText("Hide").assertIsDisplayed()

        compose.onNodeWithText("Stop").performClick()
        assertEquals(1, stops)
        compose.onNodeWithText("Dock 4 Zebra").performClick()
        assertEquals(listOf(renamed), chosen)

        // While one is being chosen, it says so, and nothing else can be picked.
        ui = ui.copy(bluetoothScanning = false, choosing = renamed.address)
        compose.onNodeWithText("Connecting…").assertIsDisplayed()
        assertWhole("Connecting…")
        compose.onNodeWithText("D8J224508535").performClick()
        assertEquals(listOf(renamed), chosen)
    }

    /** Off, not allowed and (API 30) Location off: the message, and a button that opens the screen
     *  that fixes it. No Bluetooth LE: the message alone (nothing on the device can fix it). */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun eachBluetoothRefusalHasAWorkingButton() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        ui = PrinterSetupUi(findMode = FindMode.BLUETOOTH, bluetoothFound = emptyList())
        show()
        val cases = listOf(
            Triple(BLUETOOTH_OFF_TEXT, "Turn on Bluetooth", BluetoothAdapter.ACTION_REQUEST_ENABLE),
            Triple(BLUETOOTH_DENIED_TEXT, "Open Settings", Settings.ACTION_APPLICATION_DETAILS_SETTINGS),
            Triple(LOCATION_OFF_TEXT, "Location settings", Settings.ACTION_LOCATION_SOURCE_SETTINGS),
        )
        for ((message, button, action) in cases) {
            ui = ui.copy(bluetoothMessage = message)
            compose.onNodeWithText(message).assertIsDisplayed()
            assertWhole(message)
            assertWhole(button)
            compose.onNodeWithText(button).assertHasClickAction().performClick()
            compose.waitForIdle()
            val started = Shadows.shadowOf(app).nextStartedActivity
            assertEquals(button, action, started?.action)
            if (action == Settings.ACTION_APPLICATION_DETAILS_SETTINGS) assertEquals(Uri.parse("package:" + app.packageName), started?.data)
        }

        val unsupported = bluetoothUnavailableText(BluetoothAvailability.UNSUPPORTED)!!
        ui = ui.copy(bluetoothMessage = unsupported)
        compose.onNodeWithText(unsupported).assertIsDisplayed()
        for (button in listOf("Turn on Bluetooth", "Open Settings", "Location settings")) compose.onAllNodesWithText(button).assertCountEquals(0)
    }

    /** A font install going out (Printer Setup's checks): which font, the time left, the bar, and
     *  Cancel with what it does, all whole on the handheld; Cancel turns into Stopping…. */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theFontInstallProgressFitsA320dpHandheld() {
        var cancels = 0
        ui = PrinterSetupUi(installing = true, installFont = InstallingFont("ROBOTO-CONDENSED.TTF", 2, 3), installProgress = 0.4f, installEta = "about 2 min left")
        compose.setContent {
            KioskTheme { Column(Modifier.padding(horizontal = 16.dp)) { InstallProgress(ui, onCancel = { cancels++ }) } }
        }
        for (text in listOf("Installing ROBOTO-CONDENSED.TTF (2 of 3)…", "about 2 min left", "Cancel", "Cancel lets the font being sent finish, then stops.")) {
            assertWhole(text)
        }
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(1, cancels)
        ui = ui.copy(installStopping = true)
        assertWhole("Stopping after ROBOTO-CONDENSED.TTF…")
        assertWhole("Stopping…")
    }

    /** Print Labels' latest scan, failed over Bluetooth: Retry beside the button that fixes it, or
     *  Connect when the printer forgot this device (its steps say to tap Connect), whole on the
     *  handheld. */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun printLabelsRetryAndFixButtonsFitA320dpHandheld() {
        val asset: AssetEntity = KioskAssetRow("a1", "A-1", "Rack 1", serial_number = "SN1", make_model = "Dell").toEntity()
        var entry by mutableStateOf(PrintEntry("e1", asset, "A-1", "2026-10-22T13:00:00Z", reprint = false, PrintState.FAILED, BLUETOOTH_OFF_TEXT))
        var retries = 0
        compose.setContent {
            KioskTheme { Column(Modifier.padding(horizontal = 16.dp)) { CurrentCard(entry, onReprint = {}, onRetry = { retries++ }) } }
        }
        assertWhole(BLUETOOTH_OFF_TEXT)
        assertWhole("Retry")
        assertWhole("Turn on Bluetooth")
        compose.onNodeWithText("Retry").performClick()
        assertEquals(1, retries)

        entry = entry.copy(message = pairingLostText("D8J224508535"))
        assertWhole(pairingLostText("D8J224508535"))
        assertWhole("Connect")
        assertWhole("Bluetooth settings")
        compose.onAllNodesWithText("Retry").assertCountEquals(0)
        compose.onNodeWithText("Connect").performClick()
        assertEquals(2, retries)

        // Any other failure keeps Retry alone.
        entry = entry.copy(message = "Can't reach the printer D8J224508535 over Bluetooth.")
        assertWhole("Retry")
        for (button in listOf("Turn on Bluetooth", "Open Settings", "Location settings", "Bluetooth settings", "Connect")) {
            compose.onAllNodesWithText(button).assertCountEquals(0)
        }
    }

    /** A check that met Bluetooth off says so on its Answers row, with Turn on Bluetooth under it. */
    @Test fun aChecksRowRefusalHasItsButton() {
        ui = PrinterSetupUi(checks = listOf(CheckRow(CheckKey.ANSWERS, CheckState.FAIL, BLUETOOTH_OFF_TEXT)))
        compose.setContent { KioskTheme { Column(Modifier.padding(horizontal = 16.dp)) { Checks(ui) } } }
        compose.onNodeWithText(BLUETOOTH_OFF_TEXT).assertIsDisplayed()
        compose.onNodeWithText("Turn on Bluetooth").assertIsDisplayed().assertHasClickAction()
        ui = ui.copy(checks = listOf(CheckRow(CheckKey.ANSWERS, CheckState.FAIL, "No Zebra printer answered over Bluetooth as D8J224508535.")))
        compose.onAllNodesWithText("Turn on Bluetooth").assertCountEquals(0)
    }

    /** A test label refused because Bluetooth isn't allowed: the sheet shows Open Settings. */
    @Test fun theTestLabelSheetShowsTheFixButton() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val db = KioskDatabase.inMemory(app)
        try {
            val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(app.cacheDir, "sheet-${UUID.randomUUID()}.preferences_pb") })
            val vm = PrinterSetupViewModel(
                LabelSettingsStore(prefs), MutableStateFlow<LabelPick?>(null), MutableStateFlow(LabelBuildStatus()),
                object : LabelEngine { override suspend fun call(fn: String, argsJson: String): String = error("not used") },
                db, app.cacheDir, scanner = { emptyList() }, bluetooth = FakeBluetoothPrinting(),
                zebraFor = { error("not used") }, printerLock = PrinterLock(), printerGuard = PrinterGuard(), scopeOverride = scope,
            )
            ui = PrinterSetupUi(testMessage = BLUETOOTH_DENIED_TEXT, testError = true)
            compose.setContent { KioskTheme { TestLabelSheet(vm, ui, AlignmentSize(4.0, 2.0, 203), "Vegas Top", onDismiss = {}) } }
            // The sheet scrolls on the handheld: bring each into view first.
            compose.onNodeWithText(BLUETOOTH_DENIED_TEXT).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("Open Settings").performScrollTo().assertIsDisplayed().assertHasClickAction()
            ui = ui.copy(testMessage = "Alignment label (4x2) sent to the printer.", testError = false)
            compose.onAllNodesWithText("Open Settings").assertCountEquals(0)
        } finally {
            scope.cancel()
            db.close()
        }
    }

    /** The saved printer is highlighted by the address it was saved with: a look-alike advertising
     *  its serial elsewhere isn't. Only a printer saved with no address is matched by its name. */
    @Test fun theSavedPrinterIsMatchedByItsAddress() {
        val saved = SavedPrinter(PrinterConnection.Bluetooth("D8J224508535", zebra.address), "ZD421", "D8J224508535", 203)
        assertTrue(isSavedPrinter(zebra, saved))
        assertFalse(isSavedPrinter(zebra.copy(address = "66:55:44:33:22:11"), saved))
        assertTrue(isSavedPrinter(renamed.copy(address = zebra.address.lowercase()), saved))
        val noAddress = saved.copy(connection = PrinterConnection.Bluetooth("D8J224508535", null))
        assertTrue(isSavedPrinter(zebra.copy(address = "66:55:44:33:22:11"), noAddress))
        assertFalse(isSavedPrinter(renamed, noAddress))
        assertFalse(isSavedPrinter(zebra, SavedPrinter("10.0.0.5", "ZD421", "S1", 203)))
    }

    /** While a check asks the printer, the Bluetooth card is off (its scan would be ended by it). */
    @Test fun theBluetoothCardIsOffWhileChecksRun() {
        ui = PrinterSetupUi(checking = true)
        show()
        compose.onNode(hasClickAction() and hasText("Bluetooth")).assertIsNotEnabled()
    }

    /** A printer that forgot this device: the steps, Bluetooth settings (where it's forgotten) and
     *  Connect, side by side on the handheld. */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun pairingLostOffersBluetoothSettingsAndConnect() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val saved = SavedPrinter(PrinterConnection.Bluetooth("D8J224508535", zebra.address), "ZD421", "D8J224508535", 203)
        ui = PrinterSetupUi(findMode = FindMode.BLUETOOTH, bluetoothFound = emptyList(), pairingLost = pairingLostText("D8J224508535"))
        show(saved)
        assertWhole(pairingLostText("D8J224508535"))
        assertWhole("Bluetooth settings")
        assertWhole("Connect")
        compose.onNodeWithText("Bluetooth settings").performClick()
        compose.waitForIdle()
        assertEquals(Settings.ACTION_BLUETOOTH_SETTINGS, Shadows.shadowOf(app).nextStartedActivity?.action)
        compose.onNodeWithText("Connect").performClick()
        assertEquals(1, connects)
    }
}
