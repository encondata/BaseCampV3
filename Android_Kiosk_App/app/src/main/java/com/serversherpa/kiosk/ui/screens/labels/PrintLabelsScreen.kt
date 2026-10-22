package com.serversherpa.kiosk.ui.screens.labels

import com.serversherpa.kiosk.core.model.headerLine
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.labels.DEVICE_UNSUPPORTED_TEXT
import com.serversherpa.kiosk.core.labels.LabelBuildNeed
import com.serversherpa.kiosk.core.labels.LabelBuildPhase
import com.serversherpa.kiosk.core.labels.LabelBuildStatus
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.NO_PRINTER_TEXT
import com.serversherpa.kiosk.core.labels.NO_TEMPLATE_AT_DPI
import com.serversherpa.kiosk.core.labels.PrintEntry
import com.serversherpa.kiosk.core.labels.PrintState
import com.serversherpa.kiosk.core.labels.SYNC_NEEDED_TEXT
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.labels.TEMPLATE_FAILED
import com.serversherpa.kiosk.core.labels.TEMPLATE_UNSUPPORTED
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.input.camera.CameraScanSheet
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.CameraFieldButton
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.ScanInput
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.screens.scan.ScanTools
import com.serversherpa.kiosk.ui.screens.scan.scanTime
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** How the header describes the assets left without a label, by reason. */
private val PROBLEM_PHRASES = mapOf(
    NO_TEMPLATE_AT_DPI to "with no template at this DPI",
    TEMPLATE_FAILED to "whose template couldn't be built",
    TEMPLATE_UNSUPPORTED to "whose template needs an app update",
)

/** "12 labels ready · 2 with no template at this DPI, 1 whose template couldn't be built". */
internal fun readySummary(build: LabelBuildStatus): String {
    val ready = "${build.ready} ${if (build.ready == 1) "label" else "labels"} ready"
    val problems = build.problems.filterValues { it > 0 }
    if (problems.isEmpty()) return ready
    return "$ready · " + problems.entries.joinToString(", ") { (code, n) -> "$n ${PROBLEM_PHRASES[code] ?: "with no label"}" }
}

/**
 * Opening Print Labels with no printer saved goes straight on to Printer Setup, once per visit:
 * coming back from Printer Setup without saving leaves Print Labels showing its own "Printer
 * Setup" button rather than bouncing again. A device that can't make labels says so instead.
 */
internal fun opensPrinterSetupFirst(printer: SavedPrinter?, phase: LabelBuildPhase, alreadyOpened: Boolean): Boolean =
    printer == null && phase != LabelBuildPhase.UNSUPPORTED_DEVICE && !alreadyOpened

internal const val BUILD_FAILED_TEXT = "Labels couldn't be made. Try syncing again."

/** A failed label's button: "Retry", or "Connect" when the printer forgot this device (its steps
 *  end "…then come back and tap Connect."; [printerReachProblem] is the one rule). Both connect
 *  again and resend the same label. */
internal fun retryText(message: String?): String = if (printerReachProblem(message)?.offersConnect == true) "Connect" else "Retry"

internal fun statusText(e: PrintEntry<*>): String = when (e.state) {
    PrintState.QUEUED -> "Waiting to print"
    PrintState.SENDING -> "Printing"
    PrintState.PRINTED -> "Printed"
    PrintState.FAILED -> "Failed"
} + if (e.reprint) " (reprint)" else ""

private fun tone(s: PrintState) = when (s) {
    PrintState.PRINTED -> ChipTone.GREEN
    PrintState.QUEUED, PrintState.SENDING -> ChipTone.AMBER
    PrintState.FAILED -> ChipTone.RED
}

/** "A12 · RU 22", or a dash when the move has neither (the laptop's placement()). */
private fun placement(label: Map<String, String>, side: String): String =
    listOfNotNull(label["${side}_raw"]?.trim()?.takeIf { it.isNotEmpty() }, label["${side}_ru"]?.trim()?.takeIf { it.isNotEmpty() }?.let { "RU $it" })
        .joinToString(" · ").ifEmpty { "—" }

@Composable
fun PrintLabelsScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val vm = kioskViewModel {
        PrintLabelsViewModel(
            container.db, container.sync, container.outbox, container.prefs, container.labelSettings,
            container.labelBuilder.status, container.labelEngine,
            sender = container.labelSender,
            flash = container.flash, sound = container.sound,
            bluetooth = container.zebraBluetooth,
        )
    }
    val ui by vm.state.collectAsStateWithLifecycle()
    val entries by vm.entries.collectAsStateWithLifecycle()
    val build by vm.build.collectAsStateWithLifecycle()
    val settings by vm.settings.collectAsStateWithLifecycle()
    val syncStatus by container.sync.status.collectAsStateWithLifecycle()
    val setup by container.prefs.setupSelection.collectAsStateWithLifecycle(initialValue = null)
    var camera by remember { mutableStateOf(false) }
    // Saved with this visit's back stack entry: a rotation, or the return from Printer Setup,
    // doesn't open it again; a new visit starts over.
    var openedPrinterSetup by rememberSaveable { mutableStateOf(false) }
    val empty = ui.loadStatus == LoadStatus.READY && ui.rosterSize == 0
    val disabled = ui.loadStatus != LoadStatus.READY || empty || setup == null

    LaunchedEffect(Unit) { container.scanBus.events.collect { vm.onScan(it.value) } }
    // The screen showing, and back from the background (which closed the link): a saved Bluetooth
    // printer's link comes up in the background; nothing waits for it.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) vm.warmUpPrinter() }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    // Once the stored settings are read (null until then).
    LaunchedEffect(settings == null) {
        val read = settings ?: return@LaunchedEffect
        if (opensPrinterSetupFirst(read.printer, build.phase, openedPrinterSetup)) {
            openedPrinterSetup = true
            nav.navigate(Routes.LABELS_PRINTER)
        }
    }

    if (camera) CameraScanSheet(onScan = { container.scanBus.publish(it) }, onDismiss = { camera = false })

    Column {
        PageHeader("Kiosk · Label Printing", "Print Labels", setup?.headerLine() ?: "Finish Kiosk Setup first.")
        LabelStatus(
            build, settings, syncing = syncStatus.phase == SyncPhase.RUNNING,
            onSync = { vm.syncNow() }, onPrinterSetup = { nav.navigate(Routes.LABELS_PRINTER) },
        )
        if (ui.loadStatus == LoadStatus.ERROR) KioskToast("Couldn't read this kiosk's local data.", error = true)
        if (empty) Text("No move data on this kiosk. Sync from Kiosk Setup.", color = c.textMute)
        ScanInput(
            ui.value, vm::setValue, onSubmit = { vm.onScan(it) },
            placeholder = "Scan or type an asset ID or serial", enabled = !disabled, keepFocus = !camera,
            trailingIcon = if (container.hasCamera) ({ CameraFieldButton(!disabled) { camera = true } }) else null,
        )
        if (ui.error != null && !empty) KioskToast(ui.error, error = true)
        ScanTools(showTrigger = container.hasDataWedge, onTrigger = { DataWedge.softScan(context, true) })

        val current = entries.firstOrNull()
        if (current != null) CurrentCard(current, onReprint = { vm.reprint(current.id) }, onRetry = { vm.retry(current.id) })
        if (entries.isEmpty()) {
            Text("Nothing printed yet.", color = c.textMute, modifier = Modifier.padding(vertical = 12.dp))
        } else {
            HorizontalDivider(color = c.paperLine, modifier = Modifier.padding(top = 12.dp))
            for (e in entries) PrintRow(e, showRetry = e.id != current?.id, onRetry = { vm.retry(e.id) })
        }
    }
}

/** The header: what stops labels (device, printer, sync), the build's progress, and the counts. */
@Composable
private fun LabelStatus(
    build: LabelBuildStatus, settings: LabelSettings?, syncing: Boolean, onSync: () -> Unit, onPrinterSetup: () -> Unit,
) {
    val c = LocalKioskColors.current
    if (build.phase == LabelBuildPhase.UNSUPPORTED_DEVICE) {
        KioskToast(DEVICE_UNSUPPORTED_TEXT, error = true)
        return
    }
    if (settings != null && settings.printer == null) {
        KioskToast(NO_PRINTER_TEXT, error = true)
        MiniButton("Printer Setup", onPrinterSetup, modifier = Modifier.padding(bottom = 8.dp))
    }
    if (build.needs == LabelBuildNeed.SYNC) {
        Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(SYNC_NEEDED_TEXT, style = MaterialTheme.typography.bodyMedium, color = c.textDark, modifier = Modifier.weight(1f))
            MiniButton(if (syncing) "Syncing…" else "Sync now", onSync, enabled = !syncing)
        }
    }
    if (build.phase == LabelBuildPhase.RUNNING) {
        Text(
            "Making labels: ${build.done} of ${build.total}", fontFamily = FragmentMono,
            style = MaterialTheme.typography.labelMedium, color = c.textMute, modifier = Modifier.padding(top = 4.dp),
        )
        LinearProgressIndicator(
            progress = { build.progress }, color = c.accent, trackColor = c.paperLine,
            modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        )
    }
    // LabelBuilder logs the cause.
    if (build.phase == LabelBuildPhase.ERROR) KioskToast(BUILD_FAILED_TEXT, error = true)
    if (build.needs == null && build.phase != LabelBuildPhase.IDLE) {
        Text(readySummary(build), fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute, modifier = Modifier.padding(vertical = 6.dp))
    }
}

/** The latest scan, big: the asset, what happened, and Reprint or Retry (with, for a Bluetooth
 *  printer the crew must fix on the device first, the button that fixes it: turn Bluetooth on,
 *  allow it, or forget the printer in Bluetooth settings). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun CurrentCard(e: PrintEntry<AssetEntity>, onReprint: () -> Unit, onRetry: () -> Unit) {
    val c = LocalKioskColors.current
    val t = tone(e.state)
    Column(
        Modifier.fillMaxWidth().padding(top = 12.dp).background(c.paper, RoundedCornerShape(14.dp))
            .border(2.dp, t.border, RoundedCornerShape(14.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        val a = e.asset
        if (a != null) {
            Text(a.name?.takeIf { it.isNotBlank() } ?: a.assetId, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = c.textDark)
            val label = a.label()
            Detail("Asset ID", a.assetId, mono = true)
            Detail("Make / Model", a.makeModel.ifBlank { "—" })
            Detail("Serial", a.serialNumber?.takeIf { it.isNotBlank() } ?: "—", mono = true)
            Detail("Source", placement(label, "source"))
            Detail("Destination", placement(label, "destination"))
        } else {
            Text(e.scannedValue, fontFamily = FragmentMono, style = MaterialTheme.typography.titleMedium, color = c.textDark)
        }
        Row(Modifier.padding(top = 6.dp)) { KioskChip(statusText(e), t, dot = false) }
        e.message?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = ChipTone.RED.text) }
        e.recordWarning?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ChipTone.AMBER.text) }
        if (e.state == PrintState.PRINTED && a != null) MiniButton("Reprint", onReprint)
        if (e.state == PrintState.FAILED && a != null) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                MiniButton(retryText(e.message), onRetry)
                bluetoothFixFor(e.message)?.let { BluetoothFixButton(it) }
            }
        }
    }
}

@Composable
private fun Detail(name: String, value: String, mono: Boolean = false) {
    val c = LocalKioskColors.current
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(name, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.weight(0.4f))
        Text(value, style = MaterialTheme.typography.bodySmall, color = c.textDark, fontFamily = if (mono) FragmentMono else null, modifier = Modifier.weight(0.6f))
    }
}

@Composable
private fun PrintRow(e: PrintEntry<AssetEntity>, showRetry: Boolean, onRetry: () -> Unit) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(scanTime(e.scannedAt), fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute)
            Text(e.asset?.assetId ?: e.scannedValue, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
            KioskChip(statusText(e), tone(e.state), dot = false)
        }
        val a = e.asset
        Text(
            if (a == null) "No match" else listOfNotNull(a.name?.takeIf { it.isNotBlank() }, a.serialNumber?.takeIf { it.isNotBlank() }).joinToString(" · ").ifEmpty { "—" },
            style = MaterialTheme.typography.bodySmall, color = if (a == null) ChipTone.RED.text else c.textDark,
        )
        if (e.state == PrintState.FAILED) e.message?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = ChipTone.RED.text) }
        e.recordWarning?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = ChipTone.AMBER.text) }
        if (showRetry && e.state == PrintState.FAILED && a != null) MiniButton(retryText(e.message), onRetry, modifier = Modifier.padding(top = 4.dp))
    }
    HorizontalDivider(color = c.paperLine)
}
