package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.eyebrow` + `.page-title` + `.page-hint`. */
@Composable
fun PageHeader(eyebrow: String, title: String, hint: String? = null) {
    val c = LocalKioskColors.current
    Column(Modifier.padding(bottom = 12.dp)) {
        Text(eyebrow.uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textMute)
        Text(title, style = MaterialTheme.typography.displaySmall, color = c.textDark, modifier = Modifier.padding(top = 4.dp))
        if (hint != null) Text(hint, style = MaterialTheme.typography.bodyMedium, color = c.textMute, modifier = Modifier.padding(top = 6.dp))
    }
}
