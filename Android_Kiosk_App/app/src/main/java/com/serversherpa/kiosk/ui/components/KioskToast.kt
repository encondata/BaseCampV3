package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.tc-toast` (status) and `.form-error` (alert) lines. */
@Composable
fun KioskToast(text: String?, error: Boolean = false) {
    if (text == null) return
    val c = LocalKioskColors.current
    val tone = if (error) ChipTone.RED else ChipTone.GREEN
    Text(text, style = MaterialTheme.typography.bodyMedium, color = if (error) tone.text else c.textDark,
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp).background(tone.bg, RoundedCornerShape(10.dp)).padding(12.dp))
}
