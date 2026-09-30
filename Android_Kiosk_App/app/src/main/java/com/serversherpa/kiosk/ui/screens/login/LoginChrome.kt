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
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
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
internal const val MOUNTAINS_ASPECT = 1022f / 611f

/**
 * The mountains at the web's phone-width opacity (login-light.css, under 900px:
 * `.lx-mountains { width: 100%; opacity: .45 }`), because the form scrolls over them here too.
 */
internal const val MOUNTAINS_ALPHA = 0.45f

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

/** The artwork, with the web's mask: the top 26% and the left 16% fade into the canvas. */
@Composable
internal fun LoginMountains(modifier: Modifier = Modifier) {
    Image(
        painterResource(R.drawable.login_mountains_light), contentDescription = null,
        contentScale = ContentScale.Crop, alignment = Alignment.BottomEnd, alpha = MOUNTAINS_ALPHA,
        modifier = modifier
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .drawWithContent {
                drawContent()
                drawRect(Brush.verticalGradient(0f to Color.Transparent, .26f to Color.Black, 1f to Color.Black), blendMode = BlendMode.DstIn)
                drawRect(Brush.horizontalGradient(0f to Color.Transparent, .16f to Color.Black, 1f to Color.Black), blendMode = BlendMode.DstIn)
            },
    )
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
