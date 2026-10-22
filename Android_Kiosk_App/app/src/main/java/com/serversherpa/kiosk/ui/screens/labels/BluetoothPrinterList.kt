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
 * Zebra) with their signal and Connect (Connected on the saved printer while its link is up); every
 * other named device folded under "Other devices";
 * the FEED hint; and Scan again once it has ended.
 */
@Composable
fun BluetoothResults(
    ui: PrinterSetupUi,
    saved: SavedPrinter?,
    /** The link is up to [saved]. */
    connected: Boolean,
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
    for (p in ui.bluetoothZebras) BluetoothRow(p, ui, saved, connected, onChoose)
    val others = ui.bluetoothOthers
    if (others.isNotEmpty()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Other devices (${others.size})", style = MaterialTheme.typography.titleSmall, color = c.textDark, modifier = Modifier.weight(1f))
            LinkButton(if (othersOpen) "Hide" else "Show") { othersOpen = !othersOpen }
        }
        if (othersOpen) for (p in others) BluetoothRow(p, ui, saved, connected, onChoose)
    }
    Text(BLUETOOTH_SCAN_HINT_TEXT, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(vertical = 6.dp))
    if (!ui.bluetoothScanning && ui.bluetoothFound != null) MiniButton("Scan again", onScanAgain, enabled = ui.bluetoothScanAllowed)
}

/** A device the scan heard: its name (a Zebra's is its serial), its signal, and Connect, or
 *  Connected when it is the saved printer and the link is up to it. */
@Composable
private fun BluetoothRow(p: FoundBluetoothPrinter, ui: PrinterSetupUi, saved: SavedPrinter?, connected: Boolean, onChoose: (FoundBluetoothPrinter) -> Unit) {
    val c = LocalKioskColors.current
    val isSaved = isSavedPrinter(p, saved)
    SetupCard(isSaved, onClick = { onChoose(p) }, enabled = !ui.busy, modifier = Modifier.padding(bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                p.name, fontFamily = FragmentMono, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                color = c.textDark, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Text(bluetoothRowAction(ui.choosing == p.address, isSaved && connected), style = MaterialTheme.typography.labelLarge, color = c.accent)
        }
        Text(bluetoothSignalText(p.rssi), style = MaterialTheme.typography.bodySmall, color = c.textMute)
    }
}

/** What a scan row's action reads: Connecting… while it is being chosen, Connected while it is the
 *  saved printer with its link up, else Connect. */
internal fun bluetoothRowAction(choosing: Boolean, connected: Boolean): String = when {
    choosing -> "Connecting…"
    connected -> CONNECTED_TEXT
    else -> "Connect"
}

/** The saved Bluetooth printer's link is up: its scan row and Printer Setup's header say so. */
const val CONNECTED_TEXT = "Connected"

/** The device is the saved Bluetooth printer: by the address it was saved with, or, only when none
 *  was saved, by its name (a Zebra's is its serial). A look-alike advertising the saved serial at
 *  another address isn't it. */
internal fun isSavedPrinter(p: FoundBluetoothPrinter, saved: SavedPrinter?): Boolean {
    val c = saved?.connection as? PrinterConnection.Bluetooth ?: return false
    val address = c.address ?: return c.serial.equals(p.name, ignoreCase = true)
    return address.equals(p.address, ignoreCase = true)
}
