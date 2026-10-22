package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/*
 * The time clock's icons (kiosk/src/timeclock/icons.tsx), drawn in code so they stay sharp at any
 * size in either orientation. The "currentColor" ones are drawn black and tinted by the caller
 * (Icon); the two-color art is drawn in its own colors (Image). All decorative: the button or
 * heading beside each carries the words.
 */

private fun icon(name: String, viewport: Float, block: ImageVector.Builder.() -> Unit): ImageVector =
    ImageVector.Builder(name, viewport.dp, viewport.dp, viewport, viewport).apply(block).build()

private fun ImageVector.Builder.stroke(d: String, color: Color = Color.Black, width: Float, round: Boolean = true) {
    addPath(
        PathParser().parsePathString(d).toNodes(), stroke = SolidColor(color), strokeLineWidth = width,
        strokeLineCap = if (round) StrokeCap.Round else StrokeCap.Butt, strokeLineJoin = StrokeJoin.Round,
    )
}

private fun ImageVector.Builder.fill(d: String, color: Color = Color.Black) {
    addPath(PathParser().parsePathString(d).toNodes(), fill = SolidColor(color))
}

private fun rect(x: Float, y: Float, w: Float, h: Float) = "M$x ${y}h${w}v${h}h${-w}Z"

private fun rrect(x: Float, y: Float, w: Float, h: Float, r: Float) =
    "M${x + r} ${y}h${w - 2 * r}a$r $r 0 0 1 $r ${r}v${h - 2 * r}a$r $r 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a$r $r 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a$r $r 0 0 1 $r ${-r}Z"

private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0Z"

internal val TcQrIcon = icon("tc-qr", 48f) {
    stroke("M4 14V6h8M36 6h8v8M44 34v8h-8M12 42H4v-8", TcColors.Amber, 4f)
    stroke(rect(13f, 13f, 8f, 8f), TcColors.Ink, 3f, round = false)
    stroke(rect(27f, 13f, 8f, 8f), TcColors.Ink, 3f, round = false)
    stroke(rect(13f, 27f, 8f, 8f), TcColors.Ink, 3f, round = false)
    fill("M27 27h3v3h-3zM32 32h3v3h-3zM27 33h3v2h-3zM33 27h2v3h-2z", TcColors.Ink)
}

internal val TcKeyboardIcon = icon("tc-keyboard", 48f) {
    stroke(rrect(4f, 12f, 40f, 26f, 4f), TcColors.Ink, 3.5f)
    for (y in listOf(18f, 25f)) for (x in listOf(10f, 17f, 24f, 31f)) fill(rect(x, y, 4f, 4f), TcColors.Ink)
    fill(rect(15f, 31f, 18f, 3f), TcColors.Ink)
}

internal val TcChevronIcon = icon("tc-chevron", 24f) { stroke("M9 5l7 7-7 7", width = 2.4f) }
internal val TcArrowLeftIcon = icon("tc-arrow-left", 24f) { stroke("M19 12H5m6-6l-6 6 6 6", width = 2.4f) }
internal val TcArrowRightIcon = icon("tc-arrow-right", 24f) { stroke("M5 12h14m-6-6l6 6-6 6", width = 2.4f) }

internal val TcSearchIcon = icon("tc-search", 24f) {
    stroke(circle(10.5f, 10.5f, 6.5f), width = 2.4f)
    stroke("M15.5 15.5L21 21", width = 2.4f)
}

internal val TcGearIcon = icon("tc-gear", 24f) {
    stroke(circle(12f, 12f, 3.2f), width = 2f)
    stroke("M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1L5.3 5.3", width = 2f)
    stroke(circle(12f, 12f, 6.6f), width = 2f)
}

internal val TcShiftIcon = icon("tc-shift", 24f) { fill("M12 4l8 8h-4.5v8h-7v-8H4z") }

internal val TcBackspaceIcon = icon("tc-backspace", 24f) {
    stroke("M8 5h12a1 1 0 011 1v12a1 1 0 01-1 1H8l-6-7z", width = 2f)
    stroke("M11 9l6 6m0-6l-6 6", width = 2f)
}

/** A clock face: green on the Clock In tile. */
internal val TcClockInIcon = icon("tc-clock-in", 48f) {
    stroke(circle(24f, 24f, 18f), width = 4f)
    stroke("M24 13v12l7 4", width = 4f)
}

/** A clock face with a turning arrow: red on the Clock Out tile. */
internal val TcClockOutIcon = icon("tc-clock-out", 48f) {
    stroke("M41 26a17 17 0 11-5-14", width = 4f)
    stroke("M38 4v9h-9", width = 4f)
    stroke("M24 15v11l6 4", width = 4f)
}

internal val TcCheckIcon = icon("tc-check", 48f) {
    fill(circle(24f, 24f, 22f), TcColors.Green)
    stroke("M14 25l7 7 13-15", Color.White, 5f)
}

internal val TcPrinterIcon = icon("tc-printer", 64f) {
    fill(rrect(18f, 6f, 28f, 16f, 2f), Color.White); stroke(rrect(18f, 6f, 28f, 16f, 2f), TcColors.Ink, 3f)
    fill(rrect(6f, 20f, 52f, 26f, 6f), TcColors.Ink)
    fill(rrect(16f, 36f, 32f, 24f, 2f), Color.White); stroke(rrect(16f, 36f, 32f, 24f, 2f), TcColors.Ink, 3f)
    fill(circle(32f, 45f, 4f), TcColors.Ink)
    fill("M24 56c1-5 4-7 8-7s7 2 8 7", TcColors.Ink)
    fill(circle(50f, 28f, 2.5f), TcColors.Amber)
}

internal val TcBadgeTapIcon = icon("tc-badge-tap", 64f) {
    fill(rrect(6f, 10f, 30f, 44f, 5f), Color(0xFF334155))
    stroke("M15 26a9 9 0 0112 0M12 22a14 14 0 0118 0M18 30a4 4 0 016 0", Color.White, 2.4f)
    addGroup(rotate = 12f, pivotX = 41f, pivotY = 38f)
    fill(rrect(28f, 20f, 26f, 36f, 4f), Color.White); stroke(rrect(28f, 20f, 26f, 36f, 4f), TcColors.Ink, 2.5f)
    clearGroup()
    fill(circle(42f, 34f, 4f), TcColors.Ink)
    fill("M35 46c1.5-4 4-6 7-6s5.5 2 7 6", TcColors.Ink)
    stroke("M50 8l-4 6M56 14l-6 3", TcColors.Blue, 2.4f)
}
