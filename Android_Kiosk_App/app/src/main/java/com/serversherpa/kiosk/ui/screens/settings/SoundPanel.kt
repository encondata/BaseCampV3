package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.settings.BuiltinSound
import com.serversherpa.kiosk.core.settings.DEFAULT_SOUND_SETTINGS
import com.serversherpa.kiosk.core.settings.SoundChoice
import com.serversherpa.kiosk.core.settings.SoundSettings
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
import kotlinx.coroutines.launch

private val OPTIONS = listOf("none" to "None") + BuiltinSound.entries.map { it.wire to it.label }
private fun SoundChoice.wire() = when (this) { SoundChoice.None -> "none"; is SoundChoice.Builtin -> id.wire }
private fun choiceOf(wire: String): SoundChoice = BuiltinSound.fromWire(wire)?.let { SoundChoice.Builtin(it) } ?: SoundChoice.None

@Composable
fun SoundPanel() {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()
    val s by container.prefs.sound.collectAsStateWithLifecycle(initialValue = DEFAULT_SOUND_SETTINGS)
    fun save(next: SoundSettings) { scope.launch { container.prefs.setSound(next) } }
    @Composable fun row(label: String, hint: String, value: SoundChoice, set: (SoundChoice) -> Unit) {
        SettingsRow(label, hint) {
            Column {
                Segmented(OPTIONS, value.wire()) { set(choiceOf(it)) }
                MiniButton("Play", { container.sound.preview(value) }, modifier = Modifier.padding(top = 8.dp))
            }
        }
    }
    Column {
        row("Good scan", "Played when a scan matches.", s.good) { save(s.copy(good = it)) }
        row("Not-found scan", "Played when a scan matches nothing.", s.notFound) { save(s.copy(notFound = it)) }
        row("Duplicate scan", "Played when a scan changes nothing.", s.duplicate) { save(s.copy(duplicate = it)) }
        SettingsRow("Volume") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Slider(s.volume.toFloat(), { save(s.copy(volume = it.toDouble())) }, valueRange = 0f..1f, modifier = Modifier.weight(1f))
                Text("${Math.round(s.volume * 100)}%", fontFamily = FragmentMono)
            }
        }
    }
}
