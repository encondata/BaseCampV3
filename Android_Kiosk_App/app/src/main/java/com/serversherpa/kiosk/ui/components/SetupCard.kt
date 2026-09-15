package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.setup-card` / `.kiosk-tile`: paper card, accent border when selected, big tap target. */
@Composable
fun SetupCard(selected: Boolean, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = LocalKioskColors.current
    Column(
        modifier.fillMaxWidth().heightIn(min = 96.dp).clip(RoundedCornerShape(14.dp)).background(c.paper)
            .border(if (selected) 2.dp else 1.dp, if (selected) c.accent else c.paperLine, RoundedCornerShape(14.dp))
            .clickable(enabled = enabled, onClick = onClick).alpha(if (enabled) 1f else 0.45f).padding(16.dp),
        content = content,
    )
}
