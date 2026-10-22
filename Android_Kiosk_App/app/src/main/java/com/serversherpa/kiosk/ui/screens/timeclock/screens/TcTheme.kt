package com.serversherpa.kiosk.ui.screens.timeclock.screens

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.serversherpa.kiosk.ui.theme.Geologica

/** kiosk/src/styles/timeclock.css `.tcx` tokens. Always light, whatever the person's theme. */
internal object TcColors {
    val Ink = Color(0xFF0F172A)
    val Amber = Color(0xFFFF6A00)
    val AmberTop = Color(0xFFFF7A1A)
    val Paper = Color(0xFFFFF9F2)
    val Slate = Color(0xFF64748B)
    val Muted = Color(0xFF4A5D7E)
    val Line = Color(0xFFDDE3EA)
    val Green = Color(0xFF16A34A)
    val Blue = Color(0xFF1677F2)
    val BlueTop = Color(0xFF2A86F7)
    val Motto = Color(0xFF334155)
    val Placeholder = Color(0xFF94A3B8)
    val ErrorText = Color(0xFFB42318)
    val NoticeBg = Color(0xFFFFF1E3)
    val PunchErrorBg = Color(0xFFFEF2F2)
    val PunchErrorText = Color(0xFF991B1B)
    val Red = Color(0xFFE5372B)
    val Ghost = Color(0xFFEEF1F5)
}

/**
 * The stylesheet's `clamp(min, N vmin, max)` sizes. In landscape the web switches several sizes
 * to `vh`, which on a landscape screen is the short side, i.e. vmin, so one scale covers both.
 */
@Immutable
internal class TcSizes(val vmin: Float, val heightDp: Float, val landscape: Boolean) {
    fun dp(min: Float, vmin: Float, max: Float): Dp = (this.vmin * vmin / 100f).coerceIn(min, max).dp
    fun sp(min: Float, vmin: Float, max: Float): TextUnit = (this.vmin * vmin / 100f).coerceIn(min, max).sp
    /** The page's side padding (`--tcx-pad`). */
    val pad: Dp get() = if (landscape) dp(14f, 2.4f, 32f) else dp(16f, 3f, 40f)
    /** The mountain band (`--tcx-foot-h`): 30vh, 36vh in landscape. */
    val footHeight: Dp get() = (heightDp * if (landscape) .36f else .30f).dp
}

internal val LocalTcSizes = staticCompositionLocalOf { TcSizes(800f, 1280f, landscape = false) }

/** Layout A is chosen from the orientation (spec section 5). */
@Composable
@ReadOnlyComposable
internal fun tcSizesFor(config: Configuration = LocalConfiguration.current): TcSizes {
    val w = config.screenWidthDp.toFloat().takeIf { it > 0 } ?: 800f
    val h = config.screenHeightDp.toFloat().takeIf { it > 0 } ?: 1280f
    return TcSizes(minOf(w, h), h, config.orientation == Configuration.ORIENTATION_LANDSCAPE)
}

internal fun tcText(size: TextUnit, weight: FontWeight = FontWeight.Normal, color: Color = TcColors.Ink, align: TextAlign = TextAlign.Center) =
    TextStyle(fontFamily = Geologica, fontSize = size, fontWeight = weight, color = color, textAlign = align, lineHeight = size * 1.15f)

/** `.tcx-title`. */
@Composable
internal fun TcTitle(text: String, modifier: Modifier = Modifier) {
    val s = LocalTcSizes.current
    Text(text, modifier, style = tcText(s.sp(28f, 6f, 64f), FontWeight.ExtraBold).copy(letterSpacing = (-0.015).em))
}

/** `.tcx-hero`. */
@Composable
internal fun TcHero(text: String, modifier: Modifier = Modifier, done: Boolean = false) {
    val s = LocalTcSizes.current
    val size = if (done) s.sp(36f, 8f, 92f) else s.sp(40f, 10f, 112f)
    Text(text, modifier, style = tcText(size, FontWeight.ExtraBold))
}

/** `.tcx-lead`. */
@Composable
internal fun TcLead(text: String, modifier: Modifier = Modifier, align: TextAlign = TextAlign.Center) {
    val s = LocalTcSizes.current
    Text(text, modifier, style = tcText(s.sp(16f, 3.6f, 38f), color = TcColors.Muted, align = align))
}

/** `.tcx-error-text`. */
@Composable
internal fun TcErrorText(text: String) {
    val s = LocalTcSizes.current
    Text(text, style = tcText(s.sp(17f, 2.6f, 24f), FontWeight.SemiBold, TcColors.ErrorText))
}

/** `.tcx-notice`: a note with an amber left edge. */
@Composable
internal fun TcNotice(text: String) {
    val s = LocalTcSizes.current
    val fs = s.sp(16f, 2.4f, 22f)
    Text(
        text,
        Modifier.widthIn(max = 720.dp).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(TcColors.NoticeBg)
            .drawBehind { drawRect(TcColors.Amber, size = Size(4.dp.toPx(), size.height)) }
            .padding(start = 22.dp, end = 18.dp, top = 14.dp, bottom = 14.dp),
        style = tcText(fs, align = TextAlign.Start).copy(lineHeight = fs * 1.4f),
    )
}

enum class TcButtonKind { PRIMARY, GHOST, BLUE }

/** `.tcx-btn`: primary (amber), ghost (gray) or blue; [small] for Try again. */
@Composable
internal fun TcButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: TcButtonKind = TcButtonKind.PRIMARY,
    enabled: Boolean = true,
    small: Boolean = false,
    trailing: ImageVector? = null,
) {
    val s = LocalTcSizes.current
    val shape = RoundedCornerShape(14.dp)
    val (bg, fg) = when (kind) {
        TcButtonKind.PRIMARY -> Brush.verticalGradient(listOf(TcColors.AmberTop, TcColors.Amber)) to Color.White
        TcButtonKind.GHOST -> Brush.verticalGradient(listOf(TcColors.Ghost, TcColors.Ghost)) to TcColors.Ink
        TcButtonKind.BLUE -> Brush.verticalGradient(listOf(TcColors.BlueTop, TcColors.Blue)) to Color.White
    }
    val shadowColor = when (kind) { TcButtonKind.PRIMARY -> TcColors.Amber; TcButtonKind.BLUE -> TcColors.Blue; TcButtonKind.GHOST -> Color.Transparent }
    val size = if (small) s.sp(16f, 2.2f, 20f) else s.sp(19f, 3f, 30f)
    Row(
        modifier
            .heightIn(min = if (small) 56.dp else 64.dp)
            .alpha(if (enabled) 1f else .55f)
            .then(if (enabled && kind != TcButtonKind.GHOST) Modifier.shadow(8.dp, shape, ambientColor = shadowColor, spotColor = shadowColor) else Modifier)
            .clip(shape)
            .background(bg)
            .then(if (kind == TcButtonKind.GHOST) Modifier.border(1.dp, TcColors.Line, shape) else Modifier)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = if (small) 22.dp else 28.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = tcText(size, FontWeight.Bold, fg))
        if (trailing != null) Icon(trailing, contentDescription = null, tint = fg, modifier = Modifier.size(with(LocalDensity.current) { (size * 1.1f).toDp() }))
    }
}

/** A punch that failed: what happened, and Try again (the same punch, after a status re-read). */
@Composable
internal fun TcPunchError(error: String, busy: Boolean, onRetry: () -> Unit) {
    val s = LocalTcSizes.current
    val fs = s.sp(16f, 2.4f, 22f)
    Row(
        Modifier.widthIn(max = 720.dp).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(TcColors.PunchErrorBg)
            .drawBehind { drawRect(TcColors.Red, size = Size(4.dp.toPx(), size.height)) }
            .padding(start = 22.dp, end = 18.dp, top = 14.dp, bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(error, Modifier.weight(1f), style = tcText(fs, color = TcColors.PunchErrorText, align = TextAlign.Start).copy(lineHeight = fs * 1.35f))
        TcButton("Try again", onRetry, enabled = !busy, small = true)
    }
}
