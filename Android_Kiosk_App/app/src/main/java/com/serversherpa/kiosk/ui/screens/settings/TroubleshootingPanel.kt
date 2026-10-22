package com.serversherpa.kiosk.ui.screens.settings

import android.content.Context
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.printer.BLUETOOTH_SCAN_HINT_TEXT
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.printer.BluetoothAvailability
import com.serversherpa.kiosk.data.printer.BluetoothPermissions
import com.serversherpa.kiosk.data.printer.TransportSetupZebra
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.labels.BluetoothFix
import com.serversherpa.kiosk.ui.screens.labels.BluetoothRefusal
import com.serversherpa.kiosk.ui.screens.labels.PairingLostNotice
import com.serversherpa.kiosk.ui.screens.labels.Section
import com.serversherpa.kiosk.ui.screens.labels.bluetoothFixFor
import com.serversherpa.kiosk.ui.screens.labels.bluetoothSignalText
import com.serversherpa.kiosk.ui.screens.labels.isSavedPrinter
import com.serversherpa.kiosk.ui.screens.labels.printerSummary
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import java.util.Locale

/**
 * Settings › Troubleshooting (D13), for anyone signed in: the saved printer's connection and
 * details, ask-the-printer buttons, a speed test, a Bluetooth scan and a report to share; the
 * command box for admins and developers, the Cut-send test for developers (the model checks the
 * role again when either is used). Nothing here saves a printer; [openPrinterSetup] goes to Printer
 * Setup, where one is chosen.
 */
@Composable
fun TroubleshootingPanel(openPrinterSetup: () -> Unit = {}) {
    val container = LocalAppContainer.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val authed = auth as? AuthState.Authed
    val vm = kioskViewModel { troubleshootingModel(container) }
    TroubleshootingContent(vm, isAdmin = authed?.isAdmin == true, isDeveloper = authed?.isDeveloper == true, openPrinterSetup = openPrinterSetup)
}

/** The tab's model on the device: the saved printer the way its connection reaches it, under the
 *  app's one printer lock and guard, and the signed-in person's role read when it is needed. */
internal fun troubleshootingModel(container: AppContainer): TroubleshootingModel = TroubleshootingModel(
    settings = container.labelSettings,
    bluetooth = container.zebraBluetooth,
    zebraFor = { printer -> TransportSetupZebra(container.zebraFor(printer)) },
    printerLock = container.printerLock,
    printerGuard = container.printerGuard,
    isAdmin = { (container.auth.state.value as? AuthState.Authed)?.isAdmin == true },
    isDeveloper = { (container.auth.state.value as? AuthState.Authed)?.isDeveloper == true },
    pick = container.labelBuilder.pick,
)

/** The tab's sections, laid out like the other Settings panels. [isAdmin] and [isDeveloper] show
 *  the command box and the Cut-send test (hidden otherwise, not just turned off). */
@Composable
internal fun TroubleshootingContent(vm: TroubleshootingModel, isAdmin: Boolean, isDeveloper: Boolean, openPrinterSetup: () -> Unit) {
    val ui by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var confirmSpeed by remember { mutableStateOf(false) }

    // Showing (again) and gone: a scan stops, and a speed test stops after the label going out.
    DisposableEffect(vm) {
        vm.open()
        onDispose { vm.close() }
    }
    // Back from Settings (a permission allowed, Bluetooth or Location turned on): Android sends
    // nothing for a permission, so Bluetooth is read again.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, vm) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) vm.appResumed(permitted = BluetoothPermissions.granted(context))
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    // Bluetooth's permissions are asked when Scan is tapped, never when the tab opens (Printer
    // Setup's flow): all at once, the granted ones passing silently.
    val permissionPrompt = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        vm.scan(permitted = BluetoothPermissions.granted(context))
    }
    val scan = {
        if (BluetoothPermissions.missing(context).isNotEmpty() && ui.availability != BluetoothAvailability.UNSUPPORTED) {
            permissionPrompt.launch(BluetoothPermissions.REQUIRED.toTypedArray())
        } else {
            vm.scan()
        }
    }

    Column {
        ConnectionSection(vm, ui, openPrinterSetup)
        DetailsSection(vm, ui)
        AskSection(vm, ui, showsCommandBox = isAdmin || isDeveloper)
        SpeedSection(vm, ui, onPrint = { if (ui.speedNeedsConfirm) confirmSpeed = true else vm.startSpeedTest() })
        if (isDeveloper) CutSendSection(vm, ui)
        ScanSection(vm, ui, onScan = scan)
        ReportSection(vm, ui)
    }

    if (confirmSpeed) {
        AlertDialog(
            onDismissRequest = { confirmSpeed = false },
            title = { Text("Print ${ui.speedRuns} speed-test labels?") },
            text = { Text("Each label carries about ${ui.speedKb} KB of data and prints on the labels loaded in the printer.") },
            confirmButton = {
                TextButton({
                    confirmSpeed = false
                    vm.startSpeedTest()
                }) { Text("Print ${ui.speedRuns} labels") }
            },
            dismissButton = { TextButton({ confirmSpeed = false }) { Text("Cancel") } },
        )
    }
}

// --- Sections ---

@Composable
private fun ConnectionSection(vm: TroubleshootingModel, ui: TroubleshootingUi, openPrinterSetup: () -> Unit) {
    val c = LocalKioskColors.current
    Section("Connection")
    if (ui.settings == null) return
    val printer = ui.printer
    if (printer == null) {
        Text(NO_TROUBLESHOOTING_PRINTER_TEXT, style = MaterialTheme.typography.bodyMedium, color = c.textMute)
        MiniButton("Printer Setup", openPrinterSetup, modifier = Modifier.padding(top = 8.dp))
        return
    }
    Text(printerSummary(printer), style = MaterialTheme.typography.titleMedium, color = c.textDark, modifier = Modifier.padding(bottom = 6.dp))
    DetailLines(vm.connectionLines(ui))
    // The printer answered at another address: say so, and where it's chosen again. Never saved here.
    if (ui.foundElsewhere) {
        Text(FOUND_ELSEWHERE_TEXT, style = MaterialTheme.typography.bodySmall, color = ChipTone.AMBER.text, modifier = Modifier.padding(top = 8.dp))
        MiniButton("Printer Setup", openPrinterSetup, modifier = Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun DetailsSection(vm: TroubleshootingModel, ui: TroubleshootingUi) {
    val c = LocalKioskColors.current
    Section("Printer details")
    val bluetooth = ui.printer?.isBluetooth == true
    Text(
        "What the printer says it is (~HI)${if (bluetooth) ", and what it said when the Bluetooth link came up" else ""}.",
        style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(bottom = 6.dp),
    )
    val hostId = vm.hostIdLines(ui)
    if (hostId.isNotEmpty()) {
        DetailLines(hostId)
        ui.hostIdMilliseconds?.let {
            Text("Answered in $it ms", style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 2.dp))
        }
    }
    if (ui.reach?.action == TroubleAction.DETAILS) {
        ReachCard(vm, ui, TroubleAction.DETAILS)
    } else {
        ui.detailsError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ChipTone.RED.text) }
    }
    val deviceInfo = vm.deviceInfoLines(ui)
    if (deviceInfo.isNotEmpty()) {
        Text(
            "Device Information (Bluetooth)", style = MaterialTheme.typography.labelLarge, color = c.textDark,
            modifier = Modifier.padding(top = 10.dp, bottom = 4.dp),
        )
        DetailLines(deviceInfo)
    }
    Working(ui.running == TroubleAction.DETAILS)
    MiniButton(if (ui.hostId == null) "Read details" else "Read again", { vm.readDetails() }, enabled = ui.canCall, modifier = Modifier.padding(top = 8.dp))
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AskSection(vm: TroubleshootingModel, ui: TroubleshootingUi, showsCommandBox: Boolean) {
    val c = LocalKioskColors.current
    Section("Ask the printer")
    Text(
        "Each button sends one question and shows the reply as the printer sent it.",
        style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(bottom = 8.dp),
    )
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (ask in PrinterAsk.entries) MiniButton(ask.label, { vm.ask(ask) }, enabled = ui.canCall)
    }
    if (ui.running == TroubleAction.ASK || ui.running == TroubleAction.COMMAND) {
        Text("Waiting for the printer…", style = MaterialTheme.typography.bodyMedium, color = c.textMute, modifier = Modifier.padding(top = 8.dp))
        Working(true)
    }
    ReachCard(vm, ui, TroubleAction.ASK, TroubleAction.COMMAND)
    if (showsCommandBox) {
        SettingsRow("Send a command", "Admins and developers only: a command can change the printer's settings.") {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    ui.commandText, vm::setCommandText, singleLine = true,
                    placeholder = { Text("! U1 getvar \"device.languages\"", fontFamily = FragmentMono, fontSize = 14.sp) },
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FragmentMono),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Send,
                    ),
                    keyboardActions = KeyboardActions(onSend = { if (ui.canCall) vm.sendCommand() }),
                    modifier = Modifier.weight(1f).testTag("printer-command"),
                )
                MiniButton("Send", { vm.sendCommand() }, enabled = ui.canCall && ui.commandText.isNotBlank())
            }
            Text(
                "Sent as typed, with CR LF at the end. Curly quotes go as straight ones.",
                style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
    for (result in ui.asks.asReversed()) AskResultCard(vm, result)
}

@Composable
private fun SpeedSection(vm: TroubleshootingModel, ui: TroubleshootingUi, onPrint: () -> Unit) {
    val c = LocalKioskColors.current
    val running = ui.running == TroubleAction.SPEED
    Section("Speed test")
    val size = vm.speedSize(ui)
    Text(
        "Prints labels of a set size and times how long each takes to send." +
            (size?.let { " They print on ${it.label} labels at ${it.dpi} dpi." } ?: ""),
        style = MaterialTheme.typography.bodySmall, color = c.textMute,
    )
    SettingsRow("Label data") {
        Segmented(TroubleshootingModel.SPEED_SIZES_KB.map { "$it" to "$it KB" }, ui.speedKb.toString()) { vm.setSpeedKb(it.toInt()) }
    }
    SettingsRow("Labels") {
        Segmented(TroubleshootingModel.SPEED_RUN_COUNTS.map { "$it" to "$it" }, ui.speedRuns.toString()) { vm.setSpeedRuns(it.toInt()) }
    }
    if (running) {
        Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            MiniButton(if (ui.speedStopping) "Stopping…" else "Stop", { vm.stopSpeedTest() }, enabled = !ui.speedStopping)
            Text(
                if (ui.speedStopping) "Stopping after label ${ui.speedRunNow} finishes sending…" else "Sending label ${ui.speedRunNow}…",
                style = MaterialTheme.typography.bodyMedium, color = c.textMute, modifier = Modifier.weight(1f),
            )
        }
        Working(true)
    } else {
        MiniButton(
            if (ui.speedRuns == 1) "Print 1 label" else "Print ${ui.speedRuns} labels", onPrint,
            enabled = ui.canCall, modifier = Modifier.padding(top = 10.dp),
        )
    }
    ReachCard(vm, ui, TroubleAction.SPEED)
    Text(SPEED_END_TEXT, style = MaterialTheme.typography.bodyMedium, color = ChipTone.AMBER.text, modifier = Modifier.padding(top = 8.dp))
    if (ui.speedRows.isNotEmpty()) {
        SpeedTable(ui.speedRows)
        ui.speedAverage?.let {
            Text(
                "Average ${String.format(Locale.US, "%.2f", it)} KB/s", style = MaterialTheme.typography.titleMedium, color = c.textDark,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun CutSendSection(vm: TroubleshootingModel, ui: TroubleshootingUi) {
    Section("Cut-send test")
    Text(CUT_SEND_ABOUT_TEXT, style = MaterialTheme.typography.bodySmall, color = LocalKioskColors.current.textMute)
    Working(ui.running == TroubleAction.CUT_SEND)
    MiniButton("Run cut-send test", { vm.runCutSendTest() }, enabled = ui.canCall, modifier = Modifier.padding(top = 8.dp))
    if (ui.reach?.action == TroubleAction.CUT_SEND) ReachCard(vm, ui, TroubleAction.CUT_SEND) else KioskToast(ui.cutSendMessage, error = ui.cutSendError)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScanSection(vm: TroubleshootingModel, ui: TroubleshootingUi, onScan: () -> Unit) {
    val c = LocalKioskColors.current
    Section("Bluetooth scan")
    Text(
        "Lists every Bluetooth device nearby with its signal, to see whether the printer can be heard. " +
            "Nothing is saved here: choose a printer in Printer Setup.",
        style = MaterialTheme.typography.bodySmall, color = c.textMute,
    )
    if (ui.scanning) {
        Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            MiniButton("Stop", { vm.stopScan() })
            Text("Listening for devices…", style = MaterialTheme.typography.bodyMedium, color = c.textMute, modifier = Modifier.weight(1f))
        }
        Working(true)
    } else {
        // Not during a speed test: a scan shares the radio and would lower its KB/s.
        MiniButton(
            if (ui.found == null) "Scan" else "Scan again", onScan,
            enabled = ui.running != TroubleAction.SPEED, modifier = Modifier.padding(top = 8.dp),
        )
    }
    // Bluetooth off, not allowed or missing, or Location off: what to do, with its button.
    BluetoothRefusal(ui.scanMessage, error = ui.scanError)
    for (device in ui.found.orEmpty()) {
        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(device.name, fontFamily = FragmentMono, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = c.textDark)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (isSavedPrinter(device, ui.printer)) KioskChip("Saved printer", ChipTone.AMBER, dot = false)
                if (device.isZebra) KioskChip("Zebra", ChipTone.GREEN, dot = false)
                Text(
                    bluetoothSignalText(device.rssi), style = MaterialTheme.typography.bodySmall, color = c.textMute,
                    modifier = Modifier.align(Alignment.CenterVertically),
                )
            }
        }
        HorizontalDivider(color = c.paperLine)
    }
    Text(BLUETOOTH_SCAN_HINT_TEXT, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 8.dp))
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReportSection(vm: TroubleshootingModel, ui: TroubleshootingUi) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    Section("Report")
    Text(
        "Copy or share everything above as text: this device and app, the printer, every reply and speed result, " +
            "and the latest log lines (${ui.logCount} so far).",
        style = MaterialTheme.typography.bodySmall, color = LocalKioskColors.current.textMute,
    )
    FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        MiniButton("Copy", {
            clipboard.setText(AnnotatedString(vm.report(maxChars = SHARE_MAX_CHARS).text))
            copied = true
        })
        MiniButton("Share", {
            copied = false
            shareReport(context, vm.report(maxChars = SHARE_MAX_CHARS))
        })
    }
    if (copied) KioskToast(REPORT_COPIED_TEXT)
}

// --- Pieces ---

/** Label and value rows, the value monospaced, selectable and wrapping. */
@Composable
private fun DetailLines(lines: List<DetailLine>) {
    val c = LocalKioskColors.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (line in lines) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(line.label, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.width(112.dp))
                SelectionContainer(Modifier.weight(1f)) {
                    Text(line.value, fontFamily = FragmentMono, fontSize = 13.sp, color = c.textDark)
                }
            }
        }
    }
}

/** One ask's result: the command, bytes and time, what it means or why it failed, and the reply. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AskResultCard(vm: TroubleshootingModel, result: AskResult) {
    val c = LocalKioskColors.current
    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp).clip(shape).background(c.paper).border(1.dp, c.paperLine, shape).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(result.label, style = MaterialTheme.typography.titleMedium, color = c.textDark, modifier = Modifier.align(Alignment.CenterVertically))
            // A command that replies nothing (a setvar) went out: "Sent", not "Failed".
            when {
                result.error != null -> KioskChip("Failed", ChipTone.RED, dot = false)
                result.reply.isEmpty() -> KioskChip("Sent", ChipTone.SLATE, dot = false)
                else -> KioskChip("Answered", ChipTone.GREEN, dot = false)
            }
            Text(
                vm.clockText(result.atMs), style = MaterialTheme.typography.bodySmall, color = c.textMute,
                modifier = Modifier.align(Alignment.CenterVertically),
            )
        }
        Text("Command: ${visibleCommand(result.command)}", fontFamily = FragmentMono, fontSize = 12.sp, color = c.textDark)
        Text("${result.bytes} B in ${result.milliseconds ?: "?"} ms", style = MaterialTheme.typography.bodySmall, color = c.textMute)
        result.meaning?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textDark) }
        result.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ChipTone.RED.text) }
        if (result.reply.isNotEmpty()) ReplyBox(visibleBytes(result.reply))
    }
}

/** A raw reply, monospaced and selectable; a long one scrolls in a 240 dp box. */
@Composable
private fun ReplyBox(text: String) {
    val c = LocalKioskColors.current
    val shape = RoundedCornerShape(8.dp)
    val long = text.length > 1200 || text.count { it == '\n' } > 14
    val box = Modifier.fillMaxWidth().clip(shape).background(c.paper2).border(1.dp, c.paperLine, shape)
    SelectionContainer(if (long) box.heightIn(max = 240.dp).verticalScroll(rememberScrollState()) else box) {
        Text(text, fontFamily = FragmentMono, fontSize = 12.sp, color = c.textDark, modifier = Modifier.padding(8.dp))
    }
}

/** The speed test's labels: size, seconds and KB/s (or why one failed, under its row). Fixed
 *  columns that fit a 320 dp handheld. */
@Composable
private fun SpeedTable(rows: List<SpeedRow>) {
    val c = LocalKioskColors.current
    val widths = listOf(48.dp, 36.dp, 64.dp, 68.dp, 56.dp)
    Column(Modifier.padding(top = 8.dp)) {
        Row {
            listOf("Label", "KB", "Bytes", "Seconds", "KB/s").forEachIndexed { i, heading ->
                Text(heading, style = MaterialTheme.typography.labelSmall, color = c.textMute, modifier = Modifier.width(widths[i]))
            }
        }
        for (row in rows) {
            val cells = listOf("${row.run}", "${row.targetKb}", "${row.bytes}") +
                if (row.error == null) listOf(decimalText(row.seconds), decimalText(row.kbPerSecond)) else emptyList()
            Row(Modifier.padding(top = 6.dp)) {
                cells.forEachIndexed { i, cell ->
                    Text(cell, fontFamily = FragmentMono, fontSize = 12.sp, color = c.textDark, modifier = Modifier.width(widths[i]))
                }
            }
            row.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ChipTone.RED.text, modifier = Modifier.padding(top = 2.dp)) }
        }
    }
}

/** What the last call met in one of [sections] and the crew fixes on the handheld, as on Print
 *  Labels: its words with the button that fixes it (Turn on Bluetooth, Open Settings, Location
 *  settings), or for a printer that forgot this device the steps with Bluetooth settings and Connect
 *  (which reads the printer's details, connecting first). */
@Composable
private fun ReachCard(vm: TroubleshootingModel, ui: TroubleshootingUi, vararg sections: TroubleAction) {
    val reach = ui.reach?.takeIf { it.action in sections } ?: return
    if (bluetoothFixFor(reach.text) == BluetoothFix.FORGET) {
        PairingLostNotice(reach.text, onConnect = { vm.connectAgain() }, connectEnabled = ui.canCall)
    } else {
        BluetoothRefusal(reach.text)
    }
}

/** A thin bar while the tab waits on the printer. */
@Composable
private fun Working(on: Boolean) {
    if (!on) return
    val c = LocalKioskColors.current
    LinearProgressIndicator(color = c.accent, trackColor = c.paperLine, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp))
}

/** Hands the report to Android's share sheet as plain text. */
private fun shareReport(context: Context, report: TroubleshootingReport) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, "Printer report ${report.name.removePrefix("printer-report-").removeSuffix(".txt")}")
        putExtra(Intent.EXTRA_TEXT, report.text)
    }
    context.startActivity(Intent.createChooser(send, "Share the printer report"))
}

private fun decimalText(value: Double?): String = value?.let { String.format(Locale.US, "%.2f", it) } ?: "-"
