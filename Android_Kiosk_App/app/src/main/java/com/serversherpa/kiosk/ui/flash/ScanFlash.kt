package com.serversherpa.kiosk.ui.flash

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** Paints the whole window in the flash color, 85% opaque, fading out over the flash's duration. */
@Composable
fun ScanFlash(controller: FlashController) {
    val state by controller.state.collectAsStateWithLifecycle()
    val current = state ?: return
    val alpha = remember(current.id) { Animatable(0.85f) }
    LaunchedEffect(current.id) { alpha.animateTo(0f, tween(current.ms)) }
    Box(
        Modifier.fillMaxSize().zIndex(10f).testTag("scan-flash")
            .background(Color(current.argb).copy(alpha = alpha.value)),
    )
}
