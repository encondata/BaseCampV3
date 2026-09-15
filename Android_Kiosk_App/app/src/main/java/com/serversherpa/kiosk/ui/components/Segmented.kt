package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.segmented`: a row of tabs/radios; `options` are (value, label). Scrolls when narrow. */
@Composable
fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    val c = LocalKioskColors.current
    Row(
        Modifier.horizontalScroll(rememberScrollState()).background(c.paper2, RoundedCornerShape(10.dp)).border(1.dp, c.paperLine, RoundedCornerShape(10.dp)).padding(3.dp),
    ) {
        for ((value, label) in options) {
            val on = value == selected
            Text(
                label,
                style = MaterialTheme.typography.labelLarge,
                color = if (on) c.ink else c.textDark,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(if (on) c.accent else c.paper2)
                    .clickable { onSelect(value) }.heightIn(min = 42.dp).padding(horizontal = 14.dp, vertical = 10.dp)
                    .wrapContentHeight(Alignment.CenterVertically),
            )
        }
    }
}
