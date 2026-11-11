package com.serversherpa.kiosk.ui.theme

import android.app.Activity
import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/** True when the night-mode bits of two `Configuration.uiMode` values differ (ruling 15: the
 *  only change after which edge-to-edge and the status-bar icons are set up again). */
fun uiModeNightChanged(old: Int, new: Int): Boolean =
    (old and Configuration.UI_MODE_NIGHT_MASK) != (new and Configuration.UI_MODE_NIGHT_MASK)

/**
 * Sets the status bar icon color for the screen that calls it: [darkIcons] over a
 * light top edge (the login art), light icons over the shell's ink top bar.
 * Every top-level screen calls this on entry and nothing restores it on exit:
 * navigation composes the next screen before the old one leaves, so a restore
 * would undo the new screen's choice. It applies again after a night-mode change,
 * since MainActivity's `enableEdgeToEdge()` then resets the color.
 */
@Composable
fun StatusBarIcons(darkIcons: Boolean) {
    val view = LocalView.current
    val night = LocalConfiguration.current.uiMode and Configuration.UI_MODE_NIGHT_MASK
    LaunchedEffect(view, darkIcons, night) {
        val window = (view.context as? Activity)?.window ?: return@LaunchedEffect
        WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = darkIcons
    }
}
