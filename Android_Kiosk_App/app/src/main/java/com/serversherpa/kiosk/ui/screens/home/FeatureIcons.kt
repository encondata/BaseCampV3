package com.serversherpa.kiosk.ui.screens.home

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.core.features.FeatureId

private fun icon(name: String, strokes: List<String> = emptyList(), fills: List<String> = emptyList()): ImageVector {
    val b = ImageVector.Builder(name = name, defaultWidth = 40.dp, defaultHeight = 40.dp, viewportWidth = 40f, viewportHeight = 40f)
    for (d in strokes) b.addPath(PathParser().parsePathString(d).toNodes(), stroke = SolidColor(Color.Black), strokeLineWidth = 2.5f, strokeLineJoin = StrokeJoin.Round, strokeLineCap = StrokeCap.Round)
    for (d in fills) b.addPath(PathParser().parsePathString(d).toNodes(), fill = SolidColor(Color.Black))
    return b.build()
}

private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r},$cy a$r,$r 0 1,0 ${2 * r},0 a$r,$r 0 1,0 ${-2 * r},0"

val FEATURE_ICONS: Map<FeatureId, ImageVector> = mapOf(
    FeatureId.SETUP to icon("setup", strokes = listOf(circle(20f, 20f, 4.5f), "M32.3 23.3a2.8 2.8 0 0 0 .6 3.1l.2.2a3.3 3.3 0 1 1-4.7 4.7l-.2-.2a2.8 2.8 0 0 0-3.1-.6 2.8 2.8 0 0 0-1.7 2.6V34a3.3 3.3 0 1 1-6.6 0v-.3a2.8 2.8 0 0 0-1.8-2.6 2.8 2.8 0 0 0-3.1.6l-.2.2a3.3 3.3 0 1 1-4.7-4.7l.2-.2a2.8 2.8 0 0 0 .6-3.1 2.8 2.8 0 0 0-2.6-1.7H4.7a3.3 3.3 0 1 1 0-6.6H5a2.8 2.8 0 0 0 2.6-1.8 2.8 2.8 0 0 0-.6-3.1l-.2-.2a3.3 3.3 0 1 1 4.7-4.7l.2.2a2.8 2.8 0 0 0 3.1.6H15a2.8 2.8 0 0 0 1.7-2.6V4.7a3.3 3.3 0 1 1 6.6 0V5a2.8 2.8 0 0 0 1.7 2.6 2.8 2.8 0 0 0 3.1-.6l.2-.2a3.3 3.3 0 1 1 4.7 4.7l-.2.2a2.8 2.8 0 0 0-.6 3.1V15a2.8 2.8 0 0 0 2.6 1.7h.3a3.3 3.3 0 1 1 0 6.6h-.3a2.8 2.8 0 0 0-2.6 1.7Z")),
    FeatureId.SCAN to icon("scan", fills = listOf("M5 8h3v24H5z", "M11 8h1.5v24H11z", "M15 8h4v24h-4z", "M22 8h1.5v24H22z", "M26 8h3v24h-3z", "M32 8h3v24h-3z")),
    FeatureId.ENROLL to icon("enroll", strokes = listOf("M4 9h11l9 11-9 11H4V9z", "M29 14a8 8 0 0 1 0 12M33.5 10a13.5 13.5 0 0 1 0 20"), fills = listOf(circle(10.5f, 15.5f, 2f))),
    FeatureId.CONTAINERS to icon("containers", strokes = listOf("M6 11h28a2 2 0 0 1 2 2v19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2z", "M4 17h32", "M14 17v17M26 17v17", "M13 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3")),
    FeatureId.TRUCKS to icon("trucks", strokes = listOf("M2 10h19v17H2V10z", "M21 16h7l5 6v5h-12v-11z", circle(12f, 30f, 3.5f), circle(28f, 30f, 3.5f), "M2 27h6.5M15.5 27h9M31.5 27H38")),
    FeatureId.LABELS to icon("labels", strokes = listOf("M6 6h15l13 13-15 15L6 21V6z"), fills = listOf(circle(14f, 14f, 2.5f))),
    FeatureId.TIMECLOCK to icon("timeclock", strokes = listOf(circle(20f, 20f, 15f), "M20 11v9l7 4")),
    FeatureId.SETTINGS to icon("settings", strokes = listOf("M6 12h20M31 12h3", circle(26f, 12f, 3.5f), "M6 28h9M20 28h14", circle(15f, 28f, 3.5f))),
)

@Composable
fun FeatureIcon(id: FeatureId, tint: Color, size: Dp = 40.dp) {
    Image(FEATURE_ICONS.getValue(id), contentDescription = null, colorFilter = ColorFilter.tint(tint), modifier = Modifier.size(size))
}
