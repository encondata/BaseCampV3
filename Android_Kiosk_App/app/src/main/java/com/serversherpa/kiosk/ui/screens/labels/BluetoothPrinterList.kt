package com.serversherpa.kiosk.ui.screens.labels

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.printer.BLUETOOTH_SCAN_HINT_TEXT
import com.serversherpa.kiosk.data.printer.FoundBluetoothPrinter
import com.serversherpa.kiosk.ui.components.LinkButton
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** "Strong signal (-52 dBm)": a Bluetooth device's signal in words (strong from -65 dBm, fair from
 *  -80), or "Signal unknown" when Android gave no reading. */
fun bluetoothSignalText(rssi: Int): String {
    if (rssi >= 0 || rssi <= -127) return "Signal unknown"
    val words = if (rssi >= -65) "Strong" else if (rssi >= -80) "Fair" else "Weak"
    return "$words signal ($rssi dBm)"
}

/** Printer Setup's Bluetooth card, beside Scan network and Enter IP: it opens the scan list. */
@Composable
fun BluetoothCard(selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    SetupCard(selected, onClick = onClick, enabled = enabled, modifier = Modifier.padding(bottom = 10.dp)) {
        CardText("Bluetooth", "Find a Zebra printer nearby over Bluetooth.")
    }
}

/**
 * What the Bluetooth scan heard: while it runs, a line with Stop; Bluetooth's refusal (with the
 * button that fixes it) or "no Zebra heard"; the Zebras (named like a serial, or advertising
 * Zebra) with their signal and Connect; every other named device folded under "Other devices";
 * the FEED hint; and Scan again once it has ended.
 */
@Composable
fun BluetoothResults(
    ui: PrinterSetupUi,
    saved: SavedPrinter?,
    onChoose: (FoundBluetoothPrinter) -> Unit,
    onStop: () -> Unit,
    onScanAgain: () -> Unit,
) {
    val c = LocalKioskColors.current
    var othersOpen by rememberSaveable { mutableStateOf(false) }
    if (ui.bluetoothScanning) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Looking for printers nearby…", style = MaterialTheme.typography.bodyMedium, color = c.textMute, modifier = Modifier.weight(1f))
            MiniButton("Stop", onStop)
        }
        LinearProgressIndicator(color = c.accent, trackColor = c.paperLine, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp))
    }
    BluetoothRefusal(ui.bluetoothMessage, error = ui.bluetoothError)
    for (p in ui.bluetoothZebras) BluetoothRow(p, ui, saved, onChoose)
    val others = ui.bluetoothOthers
    if (others.isNotEmpty()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Other devices (${others.size})", style = MaterialTheme.typography.titleSmall, color = c.textDark, modifier = Modifier.weight(1f))
            LinkButton(if (othersOpen) "Hide" else "Show") { othersOpen = !othersOpen }
        }
        if (othersOpen) for (p in others) BluetoothRow(p, ui, saved, onChoose)
    }
    Text(BLUETOOTH_SCAN_HINT_TEXT, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(vertical = 6.dp))
    if (!ui.bluetoothScanning && ui.bluetoothFound != null) MiniButton("Scan again", onScanAgain, enabled = !ui.busy)
}

/** A device the scan heard: its name (a Zebra's is its serial), its signal, and Connect. */
@Composable
private fun BluetoothRow(p: FoundBluetoothPrinter, ui: PrinterSetupUi, saved: SavedPrinter?, onChoose: (FoundBluetoothPrinter) -> Unit) {
    val c = LocalKioskColors.current
    SetupCard(isSaved(p, saved), onClick = { onChoose(p) }, enabled = !ui.busy, modifier = Modifier.padding(bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                p.name, fontFamily = FragmentMono, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                color = c.textDark, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Text(if (ui.choosing == p.address) "Connecting…" else "Connect", style = MaterialTheme.typography.labelLarge, color = c.accent)
        }
        Text(bluetoothSignalText(p.rssi), style = MaterialTheme.typography.bodySmall, color = c.textMute)
    }
}

/** The device is the saved Bluetooth printer (by the address it was saved with, or its name, which
 *  is its serial). */
private fun isSaved(p: FoundBluetoothPrinter, saved: SavedPrinter?): Boolean {
    val c = saved?.connection as? PrinterConnection.Bluetooth ?: return false
    return c.address.equals(p.address, ignoreCase = true) || c.serial.equals(p.name, ignoreCase = true)
}
