package com.serversherpa.kiosk.ui.screens.enroll

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.core.scan.padRfid
import com.serversherpa.kiosk.input.camera.CameraScanSheet
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.ScanInput
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.screens.scan.ScanTools
import com.serversherpa.kiosk.ui.screens.scan.scanTime
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

@Composable
fun EnrollScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val vm = kioskViewModel { EnrollViewModel(container.db, container.sync, container.api, container.prefs, container.identity, container.flash, container.sound) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val setup by container.prefs.setupSelection.collectAsStateWithLifecycle(initialValue = null)
    var camera by remember { mutableStateOf(false) }
    val empty = ui.loadStatus == LoadStatus.READY && ui.rosterSize == 0
    val disabled = ui.loadStatus != LoadStatus.READY || empty || setup == null

    LaunchedEffect(Unit) { container.scanBus.events.collect { vm.onScan(it.value) } }

    if (camera) { CameraScanSheet(onScan = { container.scanBus.publish(it) }, onDismiss = { camera = false }); return }

    Column {
        PageHeader("Kiosk · RFID Enroll", "RFID Enroll", setup?.let { "${it.initiativeName} · ${it.siteName}" } ?: "Finish Kiosk Setup first.")
        if (ui.loadStatus == LoadStatus.ERROR) KioskToast("Couldn't read this kiosk's local data.", error = true)
        if (empty) Text("No move data on this kiosk. Sync it from Kiosk Setup.", color = c.textMute)
        KioskToast(ui.toast)
        val asset = ui.asset
        if (asset != null) {
            SetupCard(selected = true, onClick = {}) {
                Text(asset.name ?: "Unnamed asset", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Fact("Asset ID", asset.assetId.ifBlank { "—" }); Fact("Serial", asset.serialNumber ?: "—"); Fact("Make / Model", asset.makeModel.ifBlank { "—" })
                asset.rfid?.let { Fact("Current tag", displayRfid(it)); Text("This asset already has a tag — scanning a new one replaces it.", style = MaterialTheme.typography.bodySmall, color = c.textMute) }
            }
            ScanInput(ui.tagValue, vm::setTagValue, onSubmit = { vm.submitTag(it) }, placeholder = "Scan the RFID tag", enabled = !ui.saving, keepFocus = !camera, modifier = Modifier.padding(top = 12.dp))
            val preview = padRfid(ui.tagValue).tag
            if (preview != null) Row { Text("Will be stored as ", style = MaterialTheme.typography.bodySmall, color = c.textMute); Text(preview, fontFamily = FragmentMono, style = MaterialTheme.typography.bodySmall) }
            else Text("24 characters, zero-padded.", style = MaterialTheme.typography.bodySmall, color = c.textMute)
            ScanTools(container.hasCamera, { camera = true }, container.hasDataWedge) { DataWedge.softScan(context, true) }
            KioskToast(ui.error, error = true)
            MiniButton("Cancel", { vm.cancel() })
        } else {
            ScanInput(ui.value, vm::setValue, onSubmit = { vm.submitAsset(it) }, placeholder = "Scan a serial or asset ID", enabled = !disabled, keepFocus = !camera)
            ScanTools(container.hasCamera, { camera = true }, container.hasDataWedge) { DataWedge.softScan(context, true) }
            KioskToast(ui.error, error = true)
        }
        if (ui.enrollments.isNotEmpty()) {
            Text("This session", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp, bottom = 6.dp))
            HorizontalDivider(color = c.paperLine)
            for (e in ui.enrollments) {
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Text(scanTime(e.at), fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute, modifier = Modifier.padding(end = 8.dp))
                    Text("${e.name}${e.serial?.let { " · $it" } ?: ""} → ${displayRfid(e.rfid)}${if (e.replaced) " (replaced)" else ""}", style = MaterialTheme.typography.bodySmall)
                }
                HorizontalDivider(color = c.paperLine)
            }
        }
    }
}

@Composable
private fun Fact(label: String, value: String) {
    Row(Modifier.padding(top = 4.dp)) {
        Text(label.uppercase(), fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = LocalKioskColors.current.textMute, modifier = Modifier.padding(end = 8.dp))
        Text(value, fontFamily = FragmentMono, style = MaterialTheme.typography.bodySmall)
    }
}
