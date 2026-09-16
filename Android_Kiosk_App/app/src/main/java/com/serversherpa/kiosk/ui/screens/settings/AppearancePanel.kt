package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.settings.Appearance
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.FLASH_MS_MAX
import com.serversherpa.kiosk.core.settings.FLASH_MS_MIN
import com.serversherpa.kiosk.core.settings.FLASH_MS_STEP
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.ui.components.HslPicker
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
import kotlinx.coroutines.launch

@Composable
fun AppearancePanel() {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()
    val a by container.prefs.appearance.collectAsStateWithLifecycle(initialValue = DEFAULT_APPEARANCE)
    fun save(next: Appearance) { scope.launch { container.prefs.setAppearance(next) } }
    Column {
        SettingsRow("Good scan flash", "The color the whole screen flashes when a scan matches this kiosk's local move data. Stored on this kiosk only.") {
            HslPicker("Good scan flash", a.goodScan, { save(a.copy(goodScan = it)) }) { container.flash.flash(hslToArgb(a.goodScan), a.flashMs) }
        }
        SettingsRow("Not-found scan flash", "The color the whole screen flashes when a scan matches nothing. Stored on this kiosk only.") {
            HslPicker("Not-found scan flash", a.notFoundScan, { save(a.copy(notFoundScan = it)) }) { container.flash.flash(hslToArgb(a.notFoundScan), a.flashMs) }
        }
        SettingsRow("Duplicate scan flash", "Shown when a scan changes nothing — an asset already in this container, or a container already on this truck.") {
            HslPicker("Duplicate scan flash", a.duplicateScan, { save(a.copy(duplicateScan = it)) }) { container.flash.flash(hslToArgb(a.duplicateScan), a.flashMs) }
        }
        SettingsRow("Flash duration", "How long the screen flashes after a scan.") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Slider(a.flashMs.toFloat(), { save(a.copy(flashMs = (Math.round(it / FLASH_MS_STEP) * FLASH_MS_STEP))) }, valueRange = FLASH_MS_MIN.toFloat()..FLASH_MS_MAX.toFloat(), modifier = Modifier.weight(1f))
                Text("${a.flashMs} ms", fontFamily = FragmentMono)
            }
        }
    }
}
