package com.serversherpa.kiosk.ui.theme

import android.app.Activity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/**
 * Sets the status bar icon color for the screen that calls it: [darkIcons] over a
 * light top edge (the login art), light icons over the shell's ink top bar.
 * Every top-level screen calls this on entry and nothing restores it on exit:
 * navigation composes the next screen before the old one leaves, so a restore
 * would undo the new screen's choice.
 */
@Composable
fun StatusBarIcons(darkIcons: Boolean) {
    val view = LocalView.current
    LaunchedEffect(view, darkIcons) {
        val window = (view.context as? Activity)?.window ?: return@LaunchedEffect
        WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = darkIcons
    }
}
