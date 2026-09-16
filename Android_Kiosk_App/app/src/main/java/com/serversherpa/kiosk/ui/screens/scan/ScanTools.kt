package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.components.MiniButton

/** The Zebra soft trigger, and nothing else: the camera moved into the scan box
 *  itself (see CameraFieldButton), so a phone with no DataWedge shows no tool row
 *  at all and the list starts right under the box. */
@Composable
fun ScanTools(showTrigger: Boolean, onTrigger: () -> Unit) {
    if (!showTrigger) return
    Row(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        MiniButton("Scan", onTrigger)
    }
}
