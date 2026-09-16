package com.serversherpa.kiosk.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/** The portal's CSS tokens (portal/src/styles/portal-theme.css), restated
 *  by name so a Compose screen and a web screen read the same color. */
@Immutable
data class KioskColors(
    val ink: Color = Color(0xFF0C1117),
    val ink2: Color = Color(0xFF121925),
    val inkLine: Color = Color(0xFF243140),
    val snow: Color = Color(0xFFE8EDF4),
    val paper: Color,
    val paper2: Color,
    val paperLine: Color,
    val textDark: Color,
    val textMute: Color,
    val ok: Color = Color(0xFF3ECF8E),
    val accent: Color,
    val accentSoft: Color,
    val isDark: Boolean,
)

val LightPalette = KioskColors(
    paper = Color(0xFFFBFCFD), paper2 = Color(0xFFF1F4F7), paperLine = Color(0xFFE4E8EE),
    textDark = Color(0xFF1B2129), textMute = Color(0xFF667085),
    accent = Color(0xFFFFA12E), accentSoft = Color(0xFFFFC06B), isDark = false,
)

val DarkPalette = KioskColors(
    paper = Color(0xFF10151F), paper2 = Color(0xFF0B0F17), paperLine = Color(0x17FFFFFF),
    textDark = Color(0xFFE8EDF4), textMute = Color(0xFF8A97AA),
    accent = Color(0xFFFFA12E), accentSoft = Color(0xFFFFC06B), isDark = true,
)

/** `.portal-shell[data-accent=…]` — a named accent, or a custom #rrggbb
 *  (the soft variant of a custom color is the color itself at 70% white). */
fun accentFor(name: String): Pair<Color, Color> = when (name.trim().lowercase()) {
    "aqua" -> Color(0xFF35E0C8) to Color(0xFF6AF0DD)
    "blue" -> Color(0xFF4DD0FF) to Color(0xFF86E0FF)
    "violet" -> Color(0xFFA78BFA) to Color(0xFFC4B5FD)
    "pink" -> Color(0xFFFF6FAE) to Color(0xFFFF9EC9)
    "green" -> Color(0xFF3DDC84) to Color(0xFF74E8A8)
    else -> parseHex(name)?.let { it to lighten(it) } ?: (Color(0xFFFFA12E) to Color(0xFFFFC06B))
}

private fun parseHex(value: String): Color? {
    val v = value.trim().removePrefix("#")
    if (v.length != 6 || v.any { it.lowercaseChar() !in "0123456789abcdef" }) return null
    return Color(0xFF000000L or v.toLong(16))
}

private fun lighten(c: Color): Color = Color(
    red = c.red + (1f - c.red) * 0.3f,
    green = c.green + (1f - c.green) * 0.3f,
    blue = c.blue + (1f - c.blue) * 0.3f,
)

/** The portal's `.chip.c-*` tones: text color, background, border. */
enum class ChipTone(val text: Color, val bg: Color, val border: Color) {
    GREEN(Color(0xFF3DDC84), Color(0x1F3DDC84), Color(0x403DDC84)),
    AMBER(Color(0xFFFFB84D), Color(0x1FFFB84D), Color(0x40FFB84D)),
    RED(Color(0xFFFF5D6C), Color(0x1FFF5D6C), Color(0x40FF5D6C)),
    BLUE(Color(0xFF4DD0FF), Color(0x1F4DD0FF), Color(0x404DD0FF)),
    VIOLET(Color(0xFFA78BFA), Color(0x1FA78BFA), Color(0x40A78BFA)),
    AQUA(Color(0xFF35E0C8), Color(0x1F35E0C8), Color(0x4035E0C8)),
    SLATE(Color(0xFF8A97AA), Color(0x1F8A97AA), Color(0x408A97AA)),
}

val LocalKioskColors = staticCompositionLocalOf { LightPalette }
