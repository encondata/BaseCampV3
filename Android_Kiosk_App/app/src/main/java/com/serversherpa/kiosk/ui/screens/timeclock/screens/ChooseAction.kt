package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus

private class TileLook(val ink: Color, val edge: Color, val top: Color, val bottom: Color)

private val InLook = TileLook(Color(0xFF15803D), Color(0xFF86D3A3), Color(0xFFF3FCF6), Color(0xFFE4F7EB))
private val OutLook = TileLook(Color(0xFFDC2626), Color(0xFFF5A9A3), Color(0xFFFFF6F5), Color(0xFFFFE9E7))
/** A dimmed tile reads gray (the web's grayscale filter). */
private val DimLook = TileLook(Color(0xFF64748B), Color(0xFFCBD5E1), Color(0xFFF8FAFC), Color(0xFFEEF2F6))

/**
 * What would you like to do? Clock In and Clock Out side by side, in both orientations; only the
 * one that fits the person's status can be tapped, the other is dimmed. Clock In punches at once.
 */
@Composable
fun ChooseAction(
    status: KioskTimeclockStatus,
    /** A punch (or a status re-read) is in flight. */
    busy: Boolean,
    notice: String?,
    error: String?,
    onIn: () -> Unit,
    onOut: () -> Unit,
    onRetry: () -> Unit,
) {
    val s = LocalTcSizes.current
    Column(
        Modifier.widthIn(max = if (s.landscape) 1000.dp else 820.dp).fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(s.dp(12f, 2.4f, 30f)),
    ) {
        TcTitle("What would you like to do?")
        if (notice != null) TcNotice(notice)
        if (error != null) TcPunchError(error, busy, onRetry)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(s.dp(14f, 2.6f, 30f))) {
            Tile(TcClockInIcon, "Clock In", "Start your work day", InLook, enabled = !busy && !status.clocked_in, onIn, Modifier.weight(1f).testTag("tc-tile-in"))
            Tile(TcClockOutIcon, "Clock Out", "End your work day", OutLook, enabled = !busy && status.clocked_in, onOut, Modifier.weight(1f).testTag("tc-tile-out"))
        }
    }
}

@Composable
private fun Tile(icon: ImageVector, title: String, sub: String, look: TileLook, enabled: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val s = LocalTcSizes.current
    val shape = RoundedCornerShape(22.dp)
    val l = if (enabled) look else DimLook
    Column(
        modifier.heightIn(min = if (s.landscape) s.dp(170f, 32f, 360f) else s.dp(200f, 30f, 400f))
            .alpha(if (enabled) 1f else .45f)
            .then(if (enabled) Modifier.shadow(6.dp, shape, ambientColor = TcColors.Ink.copy(alpha = .06f), spotColor = TcColors.Ink.copy(alpha = .06f)) else Modifier)
            .clip(shape).background(Brush.verticalGradient(listOf(l.top, l.bottom))).border(2.dp, l.edge, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(s.dp(6f, 1.4f, 14f), Alignment.CenterVertically),
    ) {
        Icon(icon, contentDescription = null, tint = l.ink, modifier = Modifier.size(s.dp(64f, 13f, 150f)))
        Text(title, style = tcText(s.sp(24f, 5f, 52f), FontWeight.Bold, l.ink))
        Text(sub, style = tcText(s.sp(14f, 2.4f, 24f), FontWeight.Medium, l.ink))
    }
}
