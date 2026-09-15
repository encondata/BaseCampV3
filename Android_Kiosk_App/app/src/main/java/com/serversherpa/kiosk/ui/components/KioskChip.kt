package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.ChipTone

/** The portal's `.chip.c-*`. */
@Composable
fun KioskChip(text: String, tone: ChipTone, dot: Boolean = true) {
    Row(
        Modifier.background(tone.bg, RoundedCornerShape(999.dp)).border(1.dp, tone.border, RoundedCornerShape(999.dp)).padding(horizontal = 9.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (dot) { androidx.compose.foundation.layout.Box(Modifier.size(6.dp).background(tone.text, CircleShape)); Spacer(Modifier.width(6.dp)) }
        Text(text, style = MaterialTheme.typography.labelMedium, color = tone.text)
    }
}
