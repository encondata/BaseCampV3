package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.settings-row`: label, hint, then the control below (stacked for portrait). */
@Composable
fun SettingsRow(label: String, hint: String? = null, control: @Composable () -> Unit) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
        Text(label, style = MaterialTheme.typography.titleMedium, color = c.textDark)
        if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 2.dp, bottom = 8.dp))
        control()
    }
    HorizontalDivider(color = c.paperLine)
}
