package com.serversherpa.kiosk.ui.screens.labels

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.printer.BluetoothPermissions
import com.serversherpa.kiosk.data.printer.FoundPrinter
import com.serversherpa.kiosk.data.printer.TransportSetupZebra
import com.serversherpa.kiosk.data.printer.ZebraScanner
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import java.io.File

/** "ZD421 · Serial XYZ · 203 DPI", or what to say when the printer wouldn't. */
internal fun foundDetails(p: FoundPrinter): String =
    listOfNotNull(p.model, p.serial?.let { "Serial $it" }, p.dpi?.let { "$it DPI" }).joinToString(" · ")
        .ifEmpty { "Didn't say what it is" }

private fun tone(state: CheckState) = when (state) {
    CheckState.OK -> ChipTone.GREEN
    CheckState.WARN, CheckState.RUNNING -> ChipTone.AMBER
    CheckState.FAIL -> ChipTone.RED
}

private fun chipText(state: CheckState) = when (state) {
    CheckState.RUNNING -> "Checking"
    CheckState.OK -> "OK"
    CheckState.WARN -> "Check"
    CheckState.FAIL -> "Fix"
}

/** Printer Setup: find a Zebra (network or Bluetooth), check it, fonts, test labels, offsets and peel/tear. */
@Composable
fun PrinterSetupScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val vm = kioskViewModel {
        val app = context.applicationContext
        PrinterSetupViewModel(
            container.labelSettings, container.labelBuilder.pick, container.labelBuilder.status, container.labelEngine,
            container.db, File(app.filesDir, "label-fonts"),
            scanner = { ZebraScanner(app).scan() },
            bluetooth = container.zebraBluetooth,
            zebraFor = { printer -> TransportSetupZebra(container.zebraFor(printer)) },
            printerLock = container.printerLock, printerGuard = container.printerGuard,
            saveScope = container.scope,
        )
    }
    val ui by vm.state.collectAsStateWithLifecycle()
    val settings by vm.settings.collectAsStateWithLifecycle()
    val pick by vm.currentPick.collectAsStateWithLifecycle()
    var testOpen by remember { mutableStateOf(false) }
    val printer = settings?.printer
    val mode = ui.findMode

    // Bluetooth's permissions are asked for the first time Bluetooth is picked, never before.
    val permissionPrompt = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        vm.scanBluetooth(permitted = BluetoothPermissions.granted(context))
    }
    fun pickBluetooth() {
        val missing = BluetoothPermissions.missing(context)
        if (missing.isEmpty()) vm.scanBluetooth() else permissionPrompt.launch(missing.toTypedArray())
    }
    // Back from Settings (a permission allowed, Bluetooth or Location turned on): Android sends
    // nothing for a permission, so Bluetooth is read again.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) vm.appResumed(permitted = BluetoothPermissions.granted(context))
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    if (testOpen && printer != null) {
        TestLabelSheet(vm, ui, vm.alignmentSize(settings), pick?.templateName, onDismiss = { testOpen = false })
    }

    Column {
        PageHeader(
            "Kiosk · Label Printing", "Printer Setup",
            when {
                printer != null -> printerSummary(printer)
                settings != null -> "No printer set up yet."
                else -> null
            },
        )

        Section("Choose a printer")
        SetupCard(mode == FindMode.SCAN, onClick = { vm.scan() }, enabled = !ui.busy, modifier = Modifier.padding(bottom = 10.dp)) {
            CardText("Scan network", "Find Zebra printers on this device's Wi-Fi or Ethernet network.")
        }
        SetupCard(mode == FindMode.IP, onClick = { vm.enterIp() }, enabled = !ui.busy, modifier = Modifier.padding(bottom = 10.dp)) {
            CardText("Enter IP", "Type the printer's IP address.")
        }
        BluetoothCard(selected = mode == FindMode.BLUETOOTH, enabled = !ui.busy, onClick = { pickBluetooth() })

        if (mode == FindMode.SCAN) {
            if (ui.scanning) {
                Text("Scanning the network…", style = MaterialTheme.typography.bodyMedium, color = c.textMute)
                LinearProgressIndicator(color = c.accent, trackColor = c.paperLine, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp))
            }
            KioskToast(ui.scanMessage, error = ui.scanMessage == SCAN_FAILED_TEXT)
            for (p in ui.found.orEmpty()) {
                val saving = ui.choosing == p.host
                SetupCard(printer?.host == p.host, onClick = { vm.choose(p) }, enabled = !ui.busy && !ui.scanning, modifier = Modifier.padding(bottom = 8.dp)) {
                    Text(p.host, fontFamily = FragmentMono, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = c.textDark)
                    Text(if (saving) "Saving…" else foundDetails(p), style = MaterialTheme.typography.bodySmall, color = c.textMute)
                }
            }
            if (ui.found != null && !ui.scanning) MiniButton("Scan again", { vm.scan() }, enabled = !ui.busy)
        }
        if (mode == FindMode.BLUETOOTH) {
            BluetoothResults(ui, printer, onChoose = vm::chooseBluetooth, onStop = vm::stopBluetoothScan, onScanAgain = { pickBluetooth() })
        }
        if (mode == FindMode.IP) {
            OutlinedTextField(
                ui.ipText, vm::setIpText, singleLine = true, label = { Text("Printer IP") }, placeholder = { Text("192.168.1.50") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { vm.useIp() }),
                modifier = Modifier.fillMaxWidth(),
            )
            MiniButton(
                if (ui.choosing != null && mode == FindMode.IP) "Connecting…" else "Use this printer", { vm.useIp() },
                enabled = !ui.busy && ui.ipText.isNotBlank(), modifier = Modifier.padding(top = 8.dp),
            )
        }
        KioskToast(ui.chooseError, error = true)
        // The printer forgot this device (choosing it, a check or a test label): forget it in
        // Android's Bluetooth settings too, then Connect.
        ui.pairingLost?.let { PairingLostNotice(it, onConnect = vm::connectAgain, connectEnabled = !ui.busy && !ui.checking) }

        if (printer != null) {
            Section("Checks")
            Checks(ui)
            if (ui.installing) InstallProgress(ui, onCancel = vm::cancelInstall)
            ui.fontFix?.let { fix ->
                val failed = ui.checks.any { it.key == CheckKey.FONTS && it.state == CheckState.FAIL }
                if (failed && fix.installable.isNotEmpty() && !ui.installing) {
                    val n = fix.installable.size
                    MiniButton(
                        "Install $n missing font${if (n == 1) "" else "s"}",
                        { vm.installFonts() }, enabled = !ui.busy && !ui.checking, modifier = Modifier.padding(top = 8.dp),
                    )
                }
                for (name in fix.notInLibrary) {
                    Text(
                        "$name isn't in the font library. Upload it in the portal's font library, then sync this kiosk.",
                        style = MaterialTheme.typography.bodySmall, color = ChipTone.RED.text, modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            KioskToast(ui.fontMessage, error = ui.fontError)
            MiniButton(
                if (ui.checking) "Checking…" else if (ui.checkRuns == 0) "Check printer" else "Check again", { vm.checkAgain() },
                enabled = !ui.busy && !ui.checking, modifier = Modifier.padding(top = 8.dp),
            )

            Section("Test labels")
            Text(
                "Print an alignment label or a sample label to check where labels print.",
                style = MaterialTheme.typography.bodySmall, color = c.textMute,
            )
            MiniButton("Print test labels", { testOpen = true }, enabled = !ui.busy, modifier = Modifier.padding(top = 8.dp))

            Section("Print settings")
            OffsetFields(vm, ui, printer.dpi)
            SettingsRow(
                "Peel off",
                "On: the printer holds each label until it's taken off the peeler. Off: labels tear off.",
            ) {
                Switch(checked = settings?.peel == true, onCheckedChange = { vm.setPeel(it) }, enabled = ui.peelAllowed)
                if (!ui.peelAllowed) {
                    Text(NO_PEELER_TEXT, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }

        MiniButton("Back", { nav.popBackStack() }, modifier = Modifier.padding(top = 16.dp))
    }
}

@Composable
private fun Section(title: String) {
    val c = LocalKioskColors.current
    Text(
        title.uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textMute,
        modifier = Modifier.padding(top = 16.dp, bottom = 8.dp),
    )
}

@Composable
internal fun CardText(title: String, description: String) {
    val c = LocalKioskColors.current
    Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = c.textDark)
    Text(description, style = MaterialTheme.typography.bodySmall, color = c.textMute)
}

@Composable
private fun Checks(ui: PrinterSetupUi) {
    val c = LocalKioskColors.current
    if (ui.checks.isEmpty()) {
        Text("Not checked yet.", style = MaterialTheme.typography.bodySmall, color = c.textMute)
        return
    }
    for (row in ui.checks) {
        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(row.key.label, style = MaterialTheme.typography.titleSmall, color = c.textDark, modifier = Modifier.weight(1f))
                KioskChip(chipText(row.state), tone(row.state), dot = false)
            }
            row.detail?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = if (row.state == CheckState.FAIL) ChipTone.RED.text else c.textMute)
            }
            for (note in row.notes) Text(note, style = MaterialTheme.typography.bodySmall, color = ChipTone.AMBER.text)
            // Bluetooth off or not allowed: the button that fixes it, beside what it says.
            if (row.state == CheckState.FAIL) bluetoothFixFor(row.detail)?.let { BluetoothFixButton(it, Modifier.padding(top = 4.dp)) }
        }
        HorizontalDivider(color = c.paperLine)
    }
}

/** A font install going out: which font, its progress, about how long the install has left, and
 *  Cancel (which lets the font being sent finish: one cut off part-way leaves the printer waiting
 *  for the rest of it). */
@Composable
internal fun InstallProgress(ui: PrinterSetupUi, onCancel: () -> Unit) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(ui.installStatus, style = MaterialTheme.typography.labelMedium, color = c.textMute, modifier = Modifier.weight(1f))
            ui.installEta?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = c.textMute) }
        }
        LinearProgressIndicator(progress = { ui.installProgress ?: 0f }, color = c.accent, trackColor = c.paperLine, modifier = Modifier.fillMaxWidth())
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            MiniButton(if (ui.installStopping) "Stopping…" else "Cancel", onCancel, enabled = !ui.installStopping)
            Text(
                "Cancel lets the font being sent finish, then stops.",
                style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.weight(1f),
            )
        }
    }
}

/** Top and left offsets in dots, saved as they're typed (Printer Setup and the test labels share them). */
@Composable
internal fun OffsetFields(vm: PrinterSetupViewModel, ui: PrinterSetupUi, dpi: Int) {
    val perMm = "${Math.round(dpi / 25.4)} dots ≈ 1 mm at $dpi DPI."
    OffsetField("Top offset (dots)", "+ moves the printing down, − moves it up. $perMm", ui.offsetYText, vm::setOffsetY, vm::tidyOffsets)
    OffsetField("Left offset (dots)", "+ moves the printing right, − moves it left. $perMm", ui.offsetXText, vm::setOffsetX, vm::tidyOffsets)
}

@Composable
private fun OffsetField(label: String, hint: String, value: String, onChange: (String) -> Unit, onDone: () -> Unit) {
    val c = LocalKioskColors.current
    var focused by remember { mutableStateOf(false) }
    OutlinedTextField(
        value, onChange, singleLine = true, label = { Text(label) },
        // The phone pad has a minus sign; Compose's number pad is unsigned.
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp).onFocusChanged {
            if (focused && !it.isFocused) onDone()
            focused = it.isFocused
        },
    )
    Text(hint, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 2.dp))
}
