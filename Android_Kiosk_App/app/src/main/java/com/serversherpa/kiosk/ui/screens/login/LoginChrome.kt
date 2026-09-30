package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.serversherpa.kiosk.R
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.Geologica
import kotlin.math.max
import kotlin.math.sin

/** login-mountains-light.webp is 1022x611. */
internal const val MOUNTAINS_W = 1022f
internal const val MOUNTAINS_H = 611f
internal const val MOUNTAINS_ASPECT = MOUNTAINS_W / MOUNTAINS_H

/**
 * The route over the peaks, in the artwork's own pixels: from the lower ridge up to the
 * sunlit summit (the portal's `lx-route` / `lx-pin`, moved onto this art's peaks).
 */
private val RoutePath = Path().apply {
    moveTo(474f, 458f)
    cubicTo(436f, 396f, 318f, 372f, 262f, 318f)
    cubicTo(228f, 286f, 214f, 258f, 197f, 234f)
}
private val RoutePins = listOf(Offset(474f, 458f), Offset(197f, 234f))

private const val TOPO_W = 1672f
private const val TOPO_H = 941f

/**
 * The web scene's faint contour lines (LoginScene.tsx `contour(i)`), same formula:
 * 17 wavy lines in a fixed 1672x941 frame that covers the screen (slice, centered),
 * 1 px strokes at 14% orange. Built once; drawing is 17 stroked paths.
 */
private val Contours: List<Path> = List(17) { i ->
    val base = -30 + i * 64
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
internal fun LoginTopo(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val scale = max(size.width / TOPO_W, size.height / TOPO_H)
        val dx = (size.width - TOPO_W * scale) / 2f
        val dy = (size.height - TOPO_H * scale) / 2f
        withTransform({ translate(dx, dy); scale(scale, scale, Offset.Zero) }) {
            // The stroke is drawn in the scaled frame; divide so it stays 1 dp on screen.
            val stroke = Stroke(width = 1.dp.toPx() / scale)
            for (p in Contours) drawPath(p, LoginPalette.Orange.copy(alpha = .14f), style = stroke)
        }
    }
}

/**
 * The artwork at full strength, like the portal's desktop scene. The image is anchored at its
 * bottom-left, so when the band is narrower than the art (every phone) the crop keeps the
 * sunlit peaks and drops the mist on the right. The top 26% fades into the canvas; the left
 * edge fades only when the art sits inside a wider screen ([fadeLeft]), as on the web.
 */
@Composable
internal fun LoginMountains(modifier: Modifier = Modifier, fadeLeft: Boolean = false) {
    val painter = painterResource(R.drawable.login_mountains_light)
    Canvas(
        modifier
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .drawWithContent {
                drawContent()
                drawRect(Brush.verticalGradient(0f to Color.Transparent, .26f to Color.Black, 1f to Color.Black), blendMode = BlendMode.DstIn)
                if (fadeLeft) drawRect(Brush.horizontalGradient(0f to Color.Transparent, .16f to Color.Black, 1f to Color.Black), blendMode = BlendMode.DstIn)
                // The route and pins go on after the masks, so they never fade.
                val s = max(size.width / MOUNTAINS_W, size.height / MOUNTAINS_H)
                withTransform({ translate(0f, size.height - MOUNTAINS_H * s); scale(s, s, Offset.Zero) }) {
                    val dash = 6.dp.toPx() / s
                    drawPath(
                        RoutePath, LoginPalette.Orange,
                        style = Stroke(width = 2.dp.toPx() / s, cap = StrokeCap.Round, pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash * .85f))),
                    )
                }
                for (p in RoutePins) {
                    val c = Offset(p.x * s, size.height - (MOUNTAINS_H - p.y) * s)
                    drawCircle(LoginPalette.Orange.copy(alpha = .22f), radius = 16.dp.toPx(), center = c)
                    drawCircle(Color.White, radius = 9.dp.toPx(), center = c)
                    drawCircle(LoginPalette.Orange, radius = 9.dp.toPx(), center = c, style = Stroke(2.5.dp.toPx()))
                    drawCircle(LoginPalette.Orange, radius = 5.dp.toPx(), center = c, style = Stroke(2.dp.toPx()))
                    drawCircle(LoginPalette.Orange, radius = 2.5.dp.toPx(), center = c)
                }
            },
    ) {
        val s = max(size.width / MOUNTAINS_W, size.height / MOUNTAINS_H)
        withTransform({ translate(0f, size.height - MOUNTAINS_H * s) }) {
            with(painter) { draw(Size(MOUNTAINS_W * s, MOUNTAINS_H * s)) }
        }
    }
}

/** The logo mark, the wordmark, the tagline and (kept from the old band) which kiosk this is. */
@Composable
internal fun LoginBrand(kioskName: String, modifier: Modifier = Modifier) {
    // The right 28 dp is left for the settings gear, which LoginContent pins in the corner.
    Box(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(end = 28.dp), verticalAlignment = Alignment.CenterVertically) {
            Image(painterResource(R.drawable.login_logo), contentDescription = "ServerSherpa logo", modifier = Modifier.size(52.dp))
            Column(Modifier.padding(start = 14.dp)) {
                Text(
                    buildAnnotatedString {
                        append("Server")
                        withStyle(SpanStyle(color = LoginPalette.Orange)) { append("Sherpa") }
                    },
                    color = LoginPalette.Ink, fontFamily = Geologica, fontWeight = FontWeight.ExtraBold,
                    fontSize = 22.sp, letterSpacing = (-0.22).sp, lineHeight = 24.sp,
                )
                Text(
                    "DATACENTER RELOCATION TOOLS", fontFamily = FragmentMono, fontSize = 10.sp, letterSpacing = 2.sp, lineHeight = 14.sp,
                    color = LoginPalette.Slate, modifier = Modifier.padding(top = 6.dp),
                )
                if (kioskName.isNotBlank()) {
                    Text(kioskName, fontFamily = FragmentMono, fontSize = 11.sp, color = LoginPalette.Ink, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
    }
}

/**
 * The settings gear. An unpaired kiosk needs Settings before anyone can sign in, so it is
 * pinned over the scrolling form rather than scrolling away with the logo.
 */
@Composable
internal fun LoginGear(onSettings: () -> Unit, modifier: Modifier = Modifier) {
    IconButton(
        onClick = onSettings,
        modifier = modifier.size(48.dp).background(LoginPalette.Canvas.copy(alpha = .9f), CircleShape),
    ) {
        Icon(GearIcon, contentDescription = "Kiosk settings", tint = LoginPalette.Ink, modifier = Modifier.size(24.dp))
    }
}
