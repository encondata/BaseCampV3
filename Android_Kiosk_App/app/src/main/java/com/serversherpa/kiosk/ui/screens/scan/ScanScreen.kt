package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.input.camera.CameraScanSheet
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.ScanInput
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

private fun tone(s: OutboxStatus) = when (s) {
    OutboxStatus.ACCEPTED -> ChipTone.GREEN
    OutboxStatus.QUEUED, OutboxStatus.SENDING, OutboxStatus.RETRYING -> ChipTone.AMBER
    OutboxStatus.FAILED, OutboxStatus.NOMATCH -> ChipTone.RED
}

@Composable
fun ScanScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val vm = kioskViewModel { ScanViewModel(container.db, container.sync, container.outbox, container.prefs, container.flash, container.sound) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val snapshot by vm.outboxSnapshot.collectAsStateWithLifecycle()
    val setup by container.prefs.setupSelection.collectAsStateWithLifecycle(initialValue = null)
    var camera by remember { mutableStateOf(false) }
    val empty = ui.loadStatus == LoadStatus.READY && ui.rosterSize == 0
    val disabled = ui.loadStatus != LoadStatus.READY || empty || setup == null

    LaunchedEffect(Unit) { container.scanBus.events.collect { vm.onScan(it.value) } }

    if (camera) { CameraScanSheet(onScan = { container.scanBus.publish(it) }, onDismiss = { camera = false }); return }

    Column {
        PageHeader("Kiosk · Scanning", "Scanning", setup?.let { "${it.initiativeName} · ${it.siteName} · ${it.scanLabel}" } ?: "Finish Kiosk Setup first.")
        if (ui.loadStatus == LoadStatus.ERROR) KioskToast("Couldn't read this kiosk's local data.", error = true)
        if (empty) Text("No move data on this kiosk. Sync from Kiosk Setup.", color = c.textMute)
        ScanInput(ui.value, vm::setValue, onSubmit = { vm.onScan(it) }, placeholder = "Scan or type an asset ID, serial, or tag", enabled = !disabled, keepFocus = !camera)
        KioskToast(ui.storageError, error = true)
        ScanTools(showCamera = container.hasCamera, onCamera = { camera = true }, showTrigger = container.hasDataWedge, onTrigger = { DataWedge.softScan(context, true) })
        val counts = snapshot.counts
        Text("Queued ${counts.queued} · Sent ${counts.accepted} · Failed ${counts.failed} · No match ${counts.nomatch}", fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute, modifier = Modifier.padding(top = 8.dp))
        Row(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MiniButton("Retry failed", { vm.retryFailed() }, enabled = counts.failed > 0)
            MiniButton("Clear sent", { vm.clearSent() }, enabled = counts.accepted + counts.nomatch > 0)
            MiniButton("Discard failed", { vm.askDiscard() }, enabled = counts.failed > 0)
        }
        if (ui.confirmDiscard) AlertDialog(
            onDismissRequest = { vm.cancelDiscard() },
            title = { Text("Discard failed scans?") },
            text = { Text("These scans never reached the portal. Discarding them throws them away for good.") },
            confirmButton = { TextButton({ vm.discardFailed() }) { Text("Discard") } },
            dismissButton = { TextButton({ vm.cancelDiscard() }) { Text("Keep") } },
        )
        HorizontalDivider(color = c.paperLine)
        for (row in snapshot.rows) ScanRow(row)
    }
}

@Composable
private fun ScanRow(row: OutboxRow) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(scanTime(row.scannedAt), fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute)
            Text(if (row.scanType == "rfid") displayRfid(row.scannedValue) else row.scannedValue, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
            KioskChip(row.status.wire, tone(row.status), dot = false)
        }
        val a = row.asset
        Text(if (a == null) "No match" else listOfNotNull(a.assetId.takeIf { it.isNotBlank() }, a.name, a.makeModel.takeIf { it.isNotBlank() }).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall, color = if (a == null) ChipTone.RED.text else c.textDark)
        row.lastError?.let { if (row.status == OutboxStatus.FAILED) Text(it, fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = ChipTone.RED.text) }
    }
    HorizontalDivider(color = c.paperLine)
}
