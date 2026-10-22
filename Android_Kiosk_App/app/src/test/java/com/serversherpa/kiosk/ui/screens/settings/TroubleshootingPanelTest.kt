package com.serversherpa.kiosk.ui.screens.settings

import android.app.Application
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.printer.BLUETOOTH_OFF_TEXT
import com.serversherpa.kiosk.core.printer.BLUETOOTH_SCAN_HINT_TEXT
import com.serversherpa.kiosk.core.printer.pairingLostText
import com.serversherpa.kiosk.core.printer.ZebraCommands
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.printer.BluetoothAvailability
import com.serversherpa.kiosk.data.printer.BluetoothDrop
import com.serversherpa.kiosk.data.printer.BluetoothLinkInfo
import com.serversherpa.kiosk.data.printer.BluetoothPairingLost
import com.serversherpa.kiosk.data.printer.BluetoothPermissions
import com.serversherpa.kiosk.data.printer.BluetoothPrinterInfo
import com.serversherpa.kiosk.data.printer.FakeBluetoothPrinting
import com.serversherpa.kiosk.data.printer.FoundBluetoothPrinter
import com.serversherpa.kiosk.data.printer.PrinterGuard
import com.serversherpa.kiosk.data.printer.PrinterLock
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.screens.labels.printerSummary
import com.serversherpa.kiosk.ui.theme.KioskTheme
import java.time.ZoneOffset
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
 * The Troubleshooting tab on the 320 dp MC2200 (real fonts and native graphics where a test must
 * see a clipped line): everything wraps inside the screen, the command box and the Cut-send test
 * follow the role, a Bluetooth refusal shows its fix, the scan asks for its permissions only when
 * tapped, and Share sends the report as plain text with nothing secret in it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w320dp-h533dp-hdpi")
class TroubleshootingPanelTest {
    private val compose = createAndroidComposeRule<ComponentActivity>()

    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    private val app: Application = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val bluetooth = FakeBluetoothPrinting()
    private val zebra = TroubleZebra()
    private val bluetoothPrinter =
        SavedPrinter(PrinterConnection.Bluetooth(ZD421_SERIAL, SAVED_ADDRESS), "ZD421", ZD421_SERIAL, 300)
    private var roles by mutableStateOf(false to false)
    private var printerSetupOpened = 0

    @After fun tearDown() = scope.cancel()

    private fun model(printer: SavedPrinter? = bluetoothPrinter, device: () -> String = { DEVICE_TEXT }) = TroubleshootingModel(
        settings = FixedSettings(printer), bluetooth = bluetooth, zebraFor = { zebra },
        printerLock = PrinterLock(), printerGuard = PrinterGuard(),
        isAdmin = { roles.first }, isDeveloper = { roles.second },
        pick = MutableStateFlow(null), device = device, scopeOverride = scope, zone = ZoneOffset.UTC,
    )

    /** The tab as Settings lays it out, inside the shell's scrolling 16 dp gutters. */
    private fun show(vm: TroubleshootingModel) {
        compose.setContent {
            KioskTheme {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
                    TroubleshootingContent(vm, isAdmin = roles.first, isDeveloper = roles.second, openPrinterSetup = { printerSetupOpened++ })
                }
            }
        }
        compose.waitUntil(5_000) { vm.state.value.settings != null }
        compose.waitForIdle()
    }

    private fun layoutOf(text: String): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        return layouts.single()
    }

    /** [text] shows in full on its lines (nothing ellipsized or cut off below), inside the screen. */
    private fun assertWhole(text: String) {
        compose.onNodeWithText(text, useUnmergedTree = true).performScrollTo()
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
    fun theTabFitsA320dpHandheld() {
        roles = true to true
        val vm = model()
        bluetooth.link.value = BluetoothLinkInfo(
            connected = true,
            info = BluetoothPrinterInfo(FOUND_ADDRESS, "Zebra Technologies", "ZD421", ZD421_SERIAL, "V93.21.38Z", "7.3"),
            chunkBytes = 244, mtu = 247, connectedAtMs = 1_792_000_000_000L, lastActivityMs = 1_792_000_065_000L,
            lastDrop = BluetoothDrop(1_791_999_000_000L, "The link timed out: the printer is off or out of range (status 8)"),
            savedAddress = SAVED_ADDRESS,
        )
        zebra.replies = mapOf(ZebraCommands.FONT_DIRECTORY to HW_REPLY, ZebraCommands.SERIAL_NUMBER to "\"$ZD421_SERIAL\"")
        show(vm)
        compose.waitUntil(5_000) { vm.state.value.link.connected }
        runBlocking {
            vm.readDetails()!!.join()
            vm.ask(PrinterAsk.FONTS)!!.join()
            vm.startSpeedTest()!!.join()
        }
        vm.scan()
        compose.waitUntil(5_000) { bluetooth.scanning }
        bluetooth.hear(
            FoundBluetoothPrinter(SAVED_ADDRESS, ZD421_SERIAL, -52, advertisesZebra = false),
            FoundBluetoothPrinter("11:22:33:44:55:66", "Jimmy's AirPods Pro Max (2nd generation)", -81, advertisesZebra = false),
        )
        compose.waitUntil(5_000) { vm.state.value.found?.size == 2 }
        vm.stopScan()
        compose.waitUntil(5_000) { !vm.state.value.scanning }
        compose.waitForIdle()

        for (text in listOf(
            printerSummary(bluetoothPrinter),
            "$FOUND_ADDRESS (saved $SAVED_ADDRESS)",
            FOUND_ELSEWHERE_TEXT,
            "17:30:00: The link timed out: the printer is off or out of range (status 8)",
            "244 bytes per chunk (MTU 247)",
            "Each button sends one question and shows the reply as the printer sent it.",
            "Admins and developers only: a command can change the printer's settings.",
            SPEED_END_TEXT,
            CUT_SEND_ABOUT_TEXT,
            "Jimmy's AirPods Pro Max (2nd generation)",
            "Weak signal (-81 dBm)",
            BLUETOOTH_SCAN_HINT_TEXT,
            "TT0003M_.TTF (169188 bytes)",
            "Read again", "Printer Setup", "Status", "Error report", "Peeler", "Send",
            "Print 1 label", "Run cut-send test", "Scan again", "Copy", "Share",
        )) {
            assertWhole(text)
        }
        // The ask's reply, raw, with its control bytes shown.
        compose.onNodeWithText("- DIR E:*.*", substring = true, useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        // The speed table's row.
        compose.onNodeWithText("KB/s", useUnmergedTree = true).performScrollTo().assertIsDisplayed()

        // The hint's button opens Printer Setup; nothing is saved here.
        compose.onNodeWithText("Printer Setup").performScrollTo().performClick()
        assertEquals(1, printerSetupOpened)
    }

    @Test fun commandBoxAndCutSendFollowTheRole() {
        val vm = model()
        zebra.replies = mapOf("~HI\r\n" to "\u0002ZD421-300dpi,V93.21.38Z,12,8176KB\u0003\r\n")
        show(vm)
        compose.onAllNodesWithText("Send a command").assertCountEquals(0)
        compose.onAllNodesWithText("Cut-send test").assertCountEquals(0)
        compose.onAllNodesWithText("Run cut-send test").assertCountEquals(0)

        roles = true to false
        compose.waitForIdle()
        compose.onNodeWithText("Send a command").performScrollTo().assertIsDisplayed()
        compose.onAllNodesWithText("Run cut-send test").assertCountEquals(0)
        compose.onNodeWithTag("printer-command").performScrollTo().performTextInput("~HI")
        compose.onNodeWithText("Send").performScrollTo().performClick()
        compose.waitUntil(5_000) { vm.state.value.asks.isNotEmpty() && !vm.state.value.busy }
        assertEquals(listOf("?~HI\r\n"), zebra.events.toList())

        roles = false to true
        compose.waitForIdle()
        compose.onNodeWithText("Send a command").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Run cut-send test").performScrollTo().assertIsDisplayed()

        roles = false to false
        compose.waitForIdle()
        compose.onAllNodesWithText("Send a command").assertCountEquals(0)
        compose.onAllNodesWithText("Run cut-send test").assertCountEquals(0)
    }

    /** A call Bluetooth refused shows what to do and the button that does it; a printer that forgot
     *  this device gets the steps, Bluetooth settings and Connect (which tries again). */
    @Test fun aRefusalShowsItsFix() {
        val vm = model()
        show(vm)
        zebra.failNext = BluetoothPairingLost(ZD421_SERIAL)
        compose.onNodeWithText("Read details").performScrollTo().performClick()
        compose.waitUntil(5_000) { vm.state.value.detailsError != null }
        compose.onNodeWithText(pairingLostText(ZD421_SERIAL)).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Bluetooth settings").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        compose.waitUntil(5_000) { zebra.events.contains("?~HI") && !vm.state.value.busy }
        compose.onAllNodesWithText(pairingLostText(ZD421_SERIAL)).assertCountEquals(0)

        zebra.failNext = com.serversherpa.kiosk.data.printer.BluetoothUnavailable(ZD421_SERIAL, BluetoothAvailability.POWERED_OFF)
        compose.onNodeWithText("Status").performScrollTo().performClick()
        compose.waitUntil(5_000) { vm.state.value.asks.lastOrNull()?.error == BLUETOOTH_OFF_TEXT }
        compose.waitForIdle()
        // The ask's card says it failed; the section's card says what to do, with its button.
        compose.onAllNodesWithText(BLUETOOTH_OFF_TEXT).assertCountEquals(2)
        compose.onNodeWithText("Turn on Bluetooth").performScrollTo().assertIsDisplayed()
        // The next call that gets through takes the button away.
        zebra.replies = mapOf(ZebraCommands.SERIAL_NUMBER to "\"$ZD421_SERIAL\"")
        compose.onNodeWithText("Serial number").performScrollTo().performClick()
        compose.waitUntil(5_000) { vm.state.value.reach == null && !vm.state.value.busy }
        compose.waitForIdle()
        compose.onAllNodesWithText("Turn on Bluetooth").assertCountEquals(0)
    }

    /** The scan asks for Bluetooth's permissions when Scan is tapped, never when the tab opens; with
     *  them allowed and Bluetooth off, it says so with Turn on Bluetooth. */
    @Test fun theScanAsksForPermissionOnlyWhenTapped() {
        Shadows.shadowOf(app).denyPermissions(*BluetoothPermissions.REQUIRED.toTypedArray())
        val vm = model()
        show(vm)
        assertNull(Shadows.shadowOf(compose.activity).lastRequestedPermission)
        assertEquals(0, bluetooth.scans)

        compose.onNodeWithText("Scan").performScrollTo().performClick()
        compose.waitForIdle()
        val requested = Shadows.shadowOf(compose.activity).lastRequestedPermission?.requestedPermissions
        assertEquals(BluetoothPermissions.REQUIRED.toSet(), requested?.toSet())
        assertEquals(0, bluetooth.scans)

        Shadows.shadowOf(app).grantPermissions(*BluetoothPermissions.REQUIRED.toTypedArray())
        bluetooth.availability.value = BluetoothAvailability.POWERED_OFF
        compose.onNodeWithText("Scan").performScrollTo().performClick()
        compose.waitUntil(5_000) { vm.state.value.scanMessage == BLUETOOTH_OFF_TEXT }
        assertEquals(1, bluetooth.scans)
        compose.onNodeWithText(BLUETOOTH_OFF_TEXT).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Turn on Bluetooth").performScrollTo().assertIsDisplayed()
    }

    /** Share hands Android the report as plain text (ACTION_SEND), Copy puts it on the clipboard,
     *  and neither carries the session's token, the station key or the person's email, though
     *  all three are on the device. */
    @Test fun shareSendsThePlainTextReportWithoutSecrets() {
        val token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0aW5hIn0.c2VjcmV0LXRva2VuLTdmM2E"
        val key = "sk-station-9c41d2e7b0"
        val c = testContainer()
        val session = fakeSession(roles = listOf("developer"), maxRank = 100)
        c.auth.completePair(session.copy(access_token = token, person = session.person.copy(email = "tina@example.com")))
        c.stationKeys.put(key, "http://127.0.0.1:1")
        runBlocking { c.labelSettings.setPrinter(SavedPrinter("10.0.0.5", "ZD421", "S1", 203)) }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) { TroubleshootingPanel() } }
            }
        }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("ZD421 at 10.0.0.5 · 203 dpi").fetchSemanticsNodes().isNotEmpty() }
        // A developer signed in: the command box and the Cut-send test show.
        compose.onNodeWithText("Send a command").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Run cut-send test").performScrollTo().assertIsDisplayed()

        compose.onNodeWithText("Share").performScrollTo().performClick()
        var started: Intent? = null
        compose.waitUntil(5_000) {
            started = started ?: Shadows.shadowOf(app).nextStartedActivity
            started != null
        }
        val chooser = started!!
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        @Suppress("DEPRECATION")
        val send = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("text/plain", send.type)
        val shared = send.getStringExtra(Intent.EXTRA_TEXT)!!
        assertTrue(shared.startsWith("ServerSherpa Kiosk · Printer troubleshooting report"))
        assertTrue(shared.contains("ZD421 at 10.0.0.5 · 203 dpi"))
        assertTrue(shared.contains("App: version "))
        for (secret in listOf(token, key, "tina@example.com")) assertFalse("shared $secret", shared.contains(secret))

        compose.onNodeWithText("Copy").performScrollTo().performClick()
        val clipboard = app.getSystemService(android.content.ClipboardManager::class.java)
        compose.waitUntil(5_000) { clipboard.primaryClip != null }
        val clip = clipboard.primaryClip!!.getItemAt(0).text.toString()
        assertTrue(clip.startsWith("ServerSherpa Kiosk · Printer troubleshooting report"))
        for (secret in listOf(token, key, "tina@example.com")) assertFalse("copied $secret", clip.contains(secret))
        compose.onNodeWithText(REPORT_COPIED_TEXT).performScrollTo().assertIsDisplayed()
    }

    /** Copy and Share build the report off the main thread (a long one would freeze the app), then
     *  hand it over. */
    @Test fun theReportIsBuiltOffTheMainThread() {
        var builtOnMain: Boolean? = null
        val vm = model(device = { builtOnMain = android.os.Looper.getMainLooper().isCurrentThread; DEVICE_TEXT })
        show(vm)
        compose.onNodeWithText("Copy").performScrollTo().performClick()
        val clipboard = app.getSystemService(android.content.ClipboardManager::class.java)
        compose.waitUntil(5_000) { clipboard.primaryClip != null }
        assertEquals(false, builtOnMain)
        assertTrue(clipboard.primaryClip!!.getItemAt(0).text.startsWith("ServerSherpa Kiosk · Printer troubleshooting report"))
        compose.onNodeWithText(REPORT_COPIED_TEXT).performScrollTo().assertIsDisplayed()
    }

    /** A report that fails to build (here, the device line overflows the stack) says so, and the
     *  app carries on: Copy and Share never crash it. */
    @Test fun aReportThatFailsToBuildSaysSoAndNothingCrashes() {
        val vm = model(device = { throw StackOverflowError() })
        show(vm)
        compose.onNodeWithText("Copy").performScrollTo().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText(REPORT_FAILED_TEXT).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Share").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText(REPORT_FAILED_TEXT).performScrollTo().assertIsDisplayed()
        assertEquals(null, Shadows.shadowOf(app).nextStartedActivity)
        // The tab still works.
        compose.onNodeWithText("Read details").performScrollTo().performClick()
        compose.waitUntil(5_000) { zebra.events.contains("?~HI") }
    }

    /** `~HS`'s third string is the printer's front-panel password: hidden on screen too. */
    @Test fun theStatusReplyHidesThePanelPassword() {
        val vm = model()
        zebra.replies = mapOf(ZebraCommands.HOST_STATUS to HS_REPLY)
        show(vm)
        compose.onNodeWithText("Status").performScrollTo().performClick()
        compose.waitUntil(5_000) { vm.state.value.asks.isNotEmpty() && !vm.state.value.busy }
        compose.waitForIdle()
        compose.onNodeWithText("␂****,0␃", substring = true, useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        compose.onAllNodesWithText("␂0000,0␃", substring = true, useUnmergedTree = true).assertCountEquals(0)
        // The first two strings still show as the printer sent them.
        compose.onNodeWithText("␂030,0,0,0612", substring = true, useUnmergedTree = true).assertExists()
    }

    /** Settings lists the tab between Devices and RFID, and opens it. */
    @Test fun settingsShowsTheTab() {
        val c = testContainer()
        c.auth.completePair(fakeSession())
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { Column(Modifier.verticalScroll(rememberScrollState())) { SettingsScreen(rememberNavController(), "troubleshooting") } }
            }
        }
        compose.waitUntil(5_000) { compose.onAllNodesWithText(NO_TROUBLESHOOTING_PRINTER_TEXT).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Printer connection, tests and a report to share.").assertIsDisplayed()
        compose.onAllNodesWithText("Troubleshooting").assertCountEquals(2) // the tab and the heading
    }
}
