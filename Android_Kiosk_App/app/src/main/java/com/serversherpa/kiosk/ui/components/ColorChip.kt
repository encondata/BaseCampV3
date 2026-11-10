package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `#rrggbb` (as the API sends status and level colors) to a Color; null for anything else. */
fun hexColor(value: String?): Color? {
    val v = value?.trim()?.removePrefix("#") ?: return null
    if (v.length != 6 || v.any { it.lowercaseChar() !in "0123456789abcdef" }) return null
    return Color(0xFF000000L or v.toLong(16))
}

/** A pill in the status's own color (statuses can be customized in the portal); slate without one.
 *  Shared by the Rolodex and Asset Lookup. */
@Composable
fun ColorChip(text: String, color: Color?, modifier: Modifier = Modifier) {
    val c = LocalKioskColors.current
    val base = color ?: ChipTone.SLATE.text
    // The status colors are bright: on light paper the words take a darker shade to stay legible.
    val ink = if (c.isDark) base else lerp(base, Color.Black, 0.4f)
    Text(
        text, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, color = ink, maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier.background(base.copy(alpha = 0.14f), RoundedCornerShape(999.dp))
            .border(1.dp, base.copy(alpha = 0.4f), RoundedCornerShape(999.dp)).padding(horizontal = 9.dp, vertical = 2.dp),
    )
}
