package com.serversherpa.kiosk.ui.flash

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.serversherpa.kiosk.core.rfid.SLED_FLASH_FADE_MS
import com.serversherpa.kiosk.core.rfid.SLED_FLASH_HOLD_MS
import com.serversherpa.kiosk.core.rfid.SledFlash
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.settings.Appearance
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.hslToArgb
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow

internal const val SLED_FLASH_TAG = "sled-flash"

/** One flash on screen; compared by identity, so the same kind again is a new one. */
private class ShownSledFlash(val flash: SledFlash)

/**
 * The full-screen sled messages (task H7): red "Sled disconnected" or green "Ready to scan",
 * large and white on the kiosk's not-found and good scan-flash colors. Each holds for
 * [SLED_FLASH_HOLD_MS], then fades over [SLED_FLASH_FADE_MS]; a newer one replaces the one
 * showing, and a tap anywhere dismisses it (the tap goes no further). Only while the app is in
 * front: [flashes] has no replay, so one sent meanwhile is gone. It sits above the scan flash,
 * which it leaves alone, and blocks nothing but touches: scans and sweeps go on underneath.
 */
@Composable
fun SledFlashOverlay(flashes: Flow<SledFlash>, appearance: Flow<Appearance>) {
    val look by appearance.collectAsStateWithLifecycle(initialValue = DEFAULT_APPEARANCE)
    var shown by remember { mutableStateOf<ShownSledFlash?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(flashes, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            flashes.collect { shown = ShownSledFlash(it) }
        }
    }
    val current = shown ?: return
    val alpha = remember(current) { Animatable(1f) }
    LaunchedEffect(current) {
        delay(SLED_FLASH_HOLD_MS.toLong())
        alpha.animateTo(0f, tween(SLED_FLASH_FADE_MS))
        if (shown === current) shown = null
    }
    val (text, hsl) = when (current.flash) {
        SledFlash.DROPPED -> SledWords.FLASH_DISCONNECTED to look.notFoundScan
        SledFlash.READY -> SledWords.FLASH_READY to look.goodScan
    }
    Box(
        Modifier.fillMaxSize().zIndex(11f).testTag(SLED_FLASH_TAG)
            .graphicsLayer { this.alpha = alpha.value }
            .background(Color(hslToArgb(hsl)))
            .pointerInput(current) { detectTapGestures { if (shown === current) shown = null } },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 16.dp),
            color = Color.White,
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.displaySmall.copy(fontSize = 36.sp, lineHeight = 44.sp),
        )
    }
}
