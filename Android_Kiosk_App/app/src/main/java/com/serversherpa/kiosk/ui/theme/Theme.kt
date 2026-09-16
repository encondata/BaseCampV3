package com.serversherpa.kiosk.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember

/**
 * The kiosk's theme. `theme` and `accent` are the signed-in person's
 * `preferences.theme` ("light" | "dark"; anything else follows the OS)
 * and `preferences.accent` (a named accent or #rrggbb), exactly what the
 * portal's applyPreferences() stamps on `.portal-shell`.
 */
@Composable
fun KioskTheme(theme: String = "light", accent: String = "amber", content: @Composable () -> Unit) {
    val systemDark = isSystemInDarkTheme()
    val dark = when (theme) { "dark" -> true; "light" -> false; else -> systemDark }
    val colors = remember(dark, accent) {
        val (a, soft) = accentFor(accent)
        (if (dark) DarkPalette else LightPalette).copy(accent = a, accentSoft = soft)
    }
    // The surfaceContainer roles matter: dialogs and menus paint themselves with
    // them, and Material's untouched defaults are a lilac that has nothing to do
    // with this palette. Point them all at paper so a dialog reads as kiosk paper.
    val scheme = if (dark) darkColorScheme(
        primary = colors.accent, onPrimary = colors.ink, background = colors.paper2,
        onBackground = colors.textDark, surface = colors.paper, onSurface = colors.textDark,
        surfaceVariant = colors.paper2, onSurfaceVariant = colors.textMute, outline = colors.paperLine,
        surfaceTint = colors.paper,
        surfaceContainerLowest = colors.paper2, surfaceContainerLow = colors.paper,
        surfaceContainer = colors.paper, surfaceContainerHigh = colors.paper,
        surfaceContainerHighest = colors.paper2,
    ) else lightColorScheme(
        primary = colors.accent, onPrimary = colors.ink, background = colors.paper2,
        onBackground = colors.textDark, surface = colors.paper, onSurface = colors.textDark,
        surfaceVariant = colors.paper2, onSurfaceVariant = colors.textMute, outline = colors.paperLine,
        surfaceTint = colors.paper,
        surfaceContainerLowest = colors.paper2, surfaceContainerLow = colors.paper,
        surfaceContainer = colors.paper, surfaceContainerHigh = colors.paper,
        surfaceContainerHighest = colors.paper2,
    )
    CompositionLocalProvider(LocalKioskColors provides colors) {
        MaterialTheme(colorScheme = scheme, typography = KioskTypography, content = content)
    }
}
