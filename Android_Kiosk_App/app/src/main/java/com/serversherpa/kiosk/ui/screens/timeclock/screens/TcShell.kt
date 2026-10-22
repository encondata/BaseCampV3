package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.serversherpa.kiosk.R
import com.serversherpa.kiosk.nettest.NetTestChip // INTERNET-TEST
import com.serversherpa.kiosk.ui.screens.timeclock.flow.formatClock
import com.serversherpa.kiosk.ui.screens.timeclock.flow.formatHeaderDate
import com.serversherpa.kiosk.ui.theme.FragmentMono
import java.time.Instant
import kotlin.math.max
import kotlin.math.sin
import kotlinx.coroutines.delay

/** The clock reads to the minute; checking a few times a minute keeps it within seconds of the turn. */
private const val CLOCK_TICK_MS = 10_000L

private const val TOPO_W = 1672f
private const val TOPO_H = 1900f

/** login-mountains-light.webp is 1022x611. */
private const val MOUNTAINS_W = 1022f
private const val MOUNTAINS_H = 611f

/* Faint contour lines in a fixed frame that covers the screen (slice, centered): TcShell.tsx's
   `contour(i)`, the portal sign-in page's recipe. Deterministic; built once. */
private val Contours: List<Path> = List(28) { i ->
    val base = -30 + i * 70
    Path().apply {
        var x = -40
        while (x <= 1720) {
            val y = (base + 26 * sin(x / 230.0 + i * 0.8) + 11 * sin(x / 91.0 + i * 1.9)).toFloat()
            if (x == -40) moveTo(x.toFloat(), y) else lineTo(x.toFloat(), y)
            x += 24
        }
    }
}

@Composable
private fun TcTopo(modifier: Modifier) {
    Canvas(modifier) {
        val scale = max(size.width / TOPO_W, size.height / TOPO_H)
        val dx = (size.width - TOPO_W * scale) / 2f
        val dy = (size.height - TOPO_H * scale) / 2f
        withTransform({ translate(dx, dy); scale(scale, scale, Offset.Zero) }) {
            val stroke = Stroke(width = 1.dp.toPx() / scale)
            for (p in Contours) drawPath(p, TcColors.Amber.copy(alpha = .12f), style = stroke)
        }
    }
}

/** The mountain scene, `object-fit: cover` at `center 72%`, its top fading into the paper. No route line. */
@Composable
private fun TcMountains(modifier: Modifier) {
    val painter = painterResource(R.drawable.login_mountains_light)
    Canvas(
        modifier
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .drawWithContent {
                drawContent()
                drawRect(Brush.verticalGradient(0f to Color.Transparent, .42f to Color.Black, 1f to Color.Black), blendMode = BlendMode.DstIn)
            },
    ) {
        val s = max(size.width / MOUNTAINS_W, size.height / MOUNTAINS_H)
        val w = MOUNTAINS_W * s
        val h = MOUNTAINS_H * s
        withTransform({ translate((size.width - w) / 2f, (size.height - h) * .72f) }) {
            with(painter) { draw(Size(w, h)) }
        }
    }
}

@Composable
private fun rememberNow(): Instant {
    val now by produceState(Instant.now()) {
        while (true) { delay(CLOCK_TICK_MS); value = Instant.now() }
    }
    return now
}

/** The logo and wordmark with the live date and time; the gear only when [onSettings] is set. */
@Composable
private fun TcHeader(onSettings: (() -> Unit)?) {
    val s = LocalTcSizes.current
    val now = rememberNow()
    Row(
        Modifier.fillMaxWidth().padding(start = s.pad, end = s.pad, top = s.pad),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(s.dp(10f, 1.8f, 20f))) {
            val logo = s.dp(44f, 7.5f, 92f)
            Image(painterResource(R.drawable.login_logo), contentDescription = null, modifier = Modifier.size(logo).clip(CircleShape))
            Column {
                val word = s.sp(22f, 3.8f, 44f)
                Text(
                    buildAnnotatedString {
                        append("Server")
                        withStyle(SpanStyle(color = TcColors.Amber)) { append("Sherpa") }
                    },
                    style = tcText(word, FontWeight.ExtraBold, align = TextAlign.Start).copy(letterSpacing = (-0.01).em, lineHeight = word),
                    maxLines = 1,
                )
                val tag = s.sp(8.5f, 1.25f, 13f)
                Text(
                    "DATACENTER RELOCATION TOOLS", maxLines = 1, softWrap = false,
                    modifier = Modifier.padding(top = with(LocalDensity.current) { (word * .5f).toDp() }),
                    style = tcText(tag, color = TcColors.Slate, align = TextAlign.Start).copy(fontFamily = FragmentMono, letterSpacing = .22.em),
                )
            }
        }
        Column(horizontalAlignment = Alignment.End) {
            NetTestChip(onLightPaper = true) // INTERNET-TEST
            Text(formatHeaderDate(now), style = tcText(s.sp(11f, 1.6f, 17f), color = TcColors.Slate, align = TextAlign.End))
            Text(formatClock(now.toString()), style = tcText(s.sp(20f, 3.6f, 40f), FontWeight.Bold, align = TextAlign.End))
        }
        if (onSettings != null) {
            Box(
                Modifier.size(56.dp).clip(CircleShape).clickable(role = Role.Button, onClick = onSettings).testTag("tc-gear"),
                contentAlignment = Alignment.Center,
            ) { Icon(TcGearIcon, contentDescription = "Settings", tint = TcColors.Slate, modifier = Modifier.size(26.dp)) }
        }
    }
}

/** Back, bottom-left: white, bordered, raised. */
@Composable
internal fun TcBackButton(enabled: Boolean, onClick: () -> Unit) {
    val s = LocalTcSizes.current
    val shape = RoundedCornerShape(14.dp)
    Row(
        Modifier.heightIn(min = 56.dp).alpha(if (enabled) 1f else .55f)
            .shadow(8.dp, shape, ambientColor = TcColors.Ink.copy(alpha = .12f), spotColor = TcColors.Ink.copy(alpha = .12f))
            .clip(shape).background(Color.White).border(1.dp, TcColors.Line, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).testTag("tc-back")
            .padding(horizontal = 24.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val size = s.sp(17f, 2.4f, 24f)
        Icon(TcArrowLeftIcon, contentDescription = null, tint = TcColors.Ink, modifier = Modifier.size(22.dp))
        Text("Back", style = tcText(size, FontWeight.SemiBold))
    }
}

/**
 * The time clock's full-screen frame (kiosk/src/timeclock/TcShell.tsx): faint topo lines on the
 * light paper, the logo and wordmark with the live date and time on top, the mountain scene with
 * "TRACK | MONITOR | VERIFY | COMPLETE" along the bottom, and Back pinned bottom-left. No kiosk
 * top bar or footer: the flow owns the whole screen (spec section 5). Always light.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TcShell(
    modifier: Modifier = Modifier,
    back: (@Composable () -> Unit)? = null,
    onSettings: (() -> Unit)? = null,
    /** The step lays itself out in the space between the header and the keyboard (Enter Your
     *  Name): no page scroll, and only a small margin above the keyboard. */
    fixed: Boolean = false,
    /** False drops the logo and clock (Enter Your Name on a short screen with the keyboard up). */
    header: Boolean = true,
    /** A small top margin (with [header] off). */
    compactTop: Boolean = false,
    content: @Composable () -> Unit,
) {
    val s = tcSizesFor()
    val imeVisible = WindowInsets.isImeVisible
    CompositionLocalProvider(LocalTcSizes provides s) {
        Box(modifier.fillMaxSize().background(TcColors.Paper)) {
            TcTopo(Modifier.fillMaxSize())
            TcFooter(s)
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                if (header) TcHeader(onSettings)
                Column(
                    Modifier.weight(1f).fillMaxWidth()
                        .then(if (fixed) Modifier else Modifier.verticalScroll(rememberScrollState()))
                        .padding(
                            start = 16.dp, end = 16.dp,
                            top = if (compactTop) 8.dp else if (s.landscape) s.dp(8f, 4f, 64f) else s.dp(16f, 5f, 96f),
                            bottom = if (fixed) 8.dp else s.footHeight * (if (s.landscape) .45f else .55f),
                        ),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) { content() }
            }
            if (back != null) {
                Box(
                    Modifier.align(Alignment.BottomStart).safeDrawingPadding()
                        .padding(start = s.pad, bottom = tcBackBottom(s, imeVisible)),
                ) { back() }
            }
        }
    }
}

@Composable
private fun BoxScope.TcFooter(s: TcSizes) {
    Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(s.footHeight)) {
        TcMountains(Modifier.fillMaxSize())
        Text(
            "TRACK | MONITOR | VERIFY | COMPLETE", maxLines = 1, softWrap = false,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = s.dp(8f, 1.6f, 20f)),
            style = tcText(s.sp(10f, 1.5f, 15f), color = TcColors.Motto).copy(
                fontFamily = FragmentMono, letterSpacing = .24.em,
                shadow = Shadow(Color.White.copy(alpha = .9f), blurRadius = 12f),
            ),
        )
    }
}

