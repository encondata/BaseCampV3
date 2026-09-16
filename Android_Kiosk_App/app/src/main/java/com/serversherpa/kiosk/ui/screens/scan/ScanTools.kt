package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.components.MiniButton

/** The camera button (devices with a camera) and the DataWedge soft trigger (Zebra). */
@Composable
fun ScanTools(showCamera: Boolean, onCamera: () -> Unit, showTrigger: Boolean, onTrigger: () -> Unit) {
    if (!showCamera && !showTrigger) return
    Row(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (showCamera) MiniButton("Camera", onCamera)
        if (showTrigger) MiniButton("Scan", onTrigger)
    }
}
