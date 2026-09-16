package com.serversherpa.kiosk.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/** Small line icons drawn the same way as the launcher tiles (FeatureIcons.kt):
 *  path data traced by hand, stroked in the caller's tint. The app pulls in no
 *  icon font or the material-icons-extended artifact for these. */
private fun lineIcon(name: String, paths: List<String>, fills: List<String> = emptyList()): ImageVector {
    val b = ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
    for (d in paths) {
        b.addPath(
            PathParser().parsePathString(d).toNodes(),
            stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f,
            strokeLineJoin = StrokeJoin.Round, strokeLineCap = StrokeCap.Round,
        )
    }
    for (d in fills) b.addPath(PathParser().parsePathString(d).toNodes(), fill = SolidColor(Color.Black))
    return b.build()
}

/** A camera seen head-on: body, the lens, and the shutter bump on top. */
val CameraIcon: ImageVector = lineIcon(
    "camera",
    listOf(
        "M4 8h3.2l1.6-2.6h6.4L16.8 8H20a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
        "M12 10.6a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6z",
    ),
)
