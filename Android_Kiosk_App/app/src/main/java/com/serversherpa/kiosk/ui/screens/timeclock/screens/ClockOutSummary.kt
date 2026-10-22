package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.ui.screens.timeclock.flow.formatPunch
import com.serversherpa.kiosk.ui.screens.timeclock.flow.formatWorked

private val TableBg = Color(0xFFF1F5F9).copy(alpha = .92f)
private val TotalRule = Color(0xFFCBD5E1)

/**
 * Clock Out: today so far (the big total and the day's punches), then Confirm Clock Out. In
 * landscape the total sits left of the table. A span that began before today shows its day
 * ("yesterday 10:00 PM"); a span still open reads "now".
 */
@Composable
fun ClockOutSummary(status: KioskTimeclockStatus, busy: Boolean, error: String?, onConfirm: () -> Unit, onRetry: () -> Unit) {
    val s = LocalTcSizes.current
    val worked = formatWorked(status.today_minutes)
    val total: @Composable (Modifier) -> Unit = { m ->
        Column(m, horizontalAlignment = if (s.landscape) Alignment.Start else Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = s.dp(8f, 2f, 24f))) {
                val ts = s.sp(28f, 6f, 64f)
                Icon(TcClockOutIcon, contentDescription = null, tint = TcColors.Amber, modifier = Modifier.size(s.dp(32f, 7f, 72f)).padding(end = 6.dp))
                Text("Clock Out", style = tcText(ts, FontWeight.ExtraBold))
            }
            val align = if (s.landscape) TextAlign.Start else TextAlign.Center
            TcLead("You've been working for", align = align)
            Text(worked, style = tcText(if (s.landscape) s.sp(56f, 14f, 150f) else s.sp(64f, 15f, 168f), FontWeight.ExtraBold, align = align).copy(letterSpacing = (-0.03).em))
            TcLead("today", align = align)
        }
    }
    val side: @Composable (Modifier) -> Unit = { m ->
        Column(m.widthIn(max = 680.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            val fs = s.sp(16f, 2.6f, 26f)
            val padH = s.dp(14f, 2.4f, 28f)
            val padV = s.dp(8f, 1.4f, 14f)
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(TableBg)) {
                @Composable
                fun Line(icon: ImageVector?, label: String, value: String, isTotal: Boolean = false) {
                    if (isTotal) Box(Modifier.fillMaxWidth().height(1.dp).background(TotalRule))
                    Row(Modifier.fillMaxWidth().padding(horizontal = padH, vertical = padV), verticalAlignment = Alignment.CenterVertically) {
                        if (icon != null) Icon(icon, contentDescription = null, tint = TcColors.Ink, modifier = Modifier.size(22.dp).padding(end = 0.dp))
                        Text(
                            label, Modifier.weight(1f).padding(start = if (icon != null) 14.dp else 0.dp),
                            style = tcText(fs, if (isTotal) FontWeight.Bold else FontWeight.Medium, if (isTotal) TcColors.Ink else TcColors.Muted, TextAlign.Start),
                        )
                        Text(value, maxLines = 1, style = tcText(fs, if (isTotal) FontWeight.Bold else FontWeight.SemiBold, align = TextAlign.End))
                    }
                }
                for (entry in status.today_entries) {
                    Line(TcClockInIcon, "Clock In", formatPunch(entry.clock_in_at))
                    Line(TcClockOutIcon, "Clock Out", entry.clock_out_at?.let { formatPunch(it) } ?: "now")
                }
                Line(null, "Total", worked, isTotal = true)
            }
            if (error != null) TcPunchError(error, busy, onRetry)
            TcButton("Confirm Clock Out", onConfirm, Modifier.fillMaxWidth(), enabled = !busy, trailing = TcArrowRightIcon)
        }
    }
    if (s.landscape) {
        Row(
            Modifier.widthIn(max = 1100.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(s.dp(24f, 5f, 72f), Alignment.CenterHorizontally),
        ) {
            total(Modifier.weight(1f))
            side(Modifier.weight(1f))
        }
    } else {
        Column(
            Modifier.widthIn(max = 820.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(s.dp(12f, 2.4f, 30f)),
        ) {
            total(Modifier)
            side(Modifier.fillMaxWidth())
        }
    }
}
