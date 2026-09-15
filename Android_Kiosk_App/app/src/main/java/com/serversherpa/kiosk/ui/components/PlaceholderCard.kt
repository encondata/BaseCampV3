package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.kiosk-placeholder`: a dashed card with one line and one action. */
@Composable
fun PlaceholderCard(text: String, actionText: String, onAction: () -> Unit) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth().border(1.dp, c.paperLine, RoundedCornerShape(14.dp)).padding(20.dp)) {
        Text(text, style = MaterialTheme.typography.bodyLarge, color = c.textMute)
        LinkButton(actionText, onAction)
    }
}
