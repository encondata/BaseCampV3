package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.ui.components.MiniButton
import kotlinx.coroutines.launch

/**
 * The scan screens' tool row, in a `FlowRow` so it wraps at 320 dp. The
 * Zebra soft trigger ([showTrigger], DataWedge's Scan button, unchanged),
 * and, on a phone that is not a Zebra host, the sled's own controls: Sled
 * triggers while the sled is connected and not known to lack a scanner, and
 * the sled's Scan button while its barcode scanner is ready (ruling 12).
 * The camera moved into the scan box itself (see CameraFieldButton), so with
 * none of these the row is not there at all and the list starts right under
 * the box.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ScanTools(showTrigger: Boolean, onTrigger: () -> Unit) {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()
    val connection by container.rfid.connection.collectAsStateWithLifecycle()
    val info by container.rfid.info.collectAsStateWithLifecycle()
    val scanner by container.rfid.scanner.collectAsStateWithLifecycle()
    val sledHost = !container.isZebraHost
    val showTriggers = sledHost && connection is RfidConnection.Connected && info?.hasScanner != false
    val showSledScan = sledHost && scanner == SledScannerState.Ready
    if (!showTrigger && !showTriggers && !showSledScan) return
    FlowRow(
        Modifier.padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (showTrigger) MiniButton("Scan", onTrigger)
        if (showTriggers) SledTriggersControl(caption = true)
        if (showSledScan) {
            MiniButton(SledWords.SCAN, { scope.launch { container.rfid.softScanOnce() } }, modifier = Modifier.testTag("sled-scan"))
        }
    }
}
