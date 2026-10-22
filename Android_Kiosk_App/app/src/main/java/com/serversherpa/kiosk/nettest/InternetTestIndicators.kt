package com.serversherpa.kiosk.nettest

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.theme.ChipTone

/**
 * The amber "Net test" chip for the top bar (design 4.3), shown only while
 * Internet Test is on. [onClick] should open Settings › Developer. The tap
 * target is the bar's full 48 dp height, though the chip itself stays small.
 */
@Composable
fun NetTestChip(onClick: () -> Unit) {
    val s by LocalAppContainer.current.internetTest.settings.collectAsStateWithLifecycle()
    if (!s.enabled) return
    Box(
        Modifier.padding(start = 8.dp).heightIn(min = 48.dp).clip(RoundedCornerShape(999.dp))
            .clickable(onClickLabel = "Open Developer settings", role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        KioskChip("Net test", ChipTone.AMBER, dot = false)
    }
}

/**
 * The footer's Net test value while Internet Test is on, naming both dials'
 * presets ("3G · Custom"), or null while it is off.
 */
@Composable
fun netTestFootValue(): String? {
    val s by LocalAppContainer.current.internetTest.settings.collectAsStateWithLifecycle()
    if (!s.enabled) return null
    return "${s.internet.selectedPreset(Dial.INTERNET).label} · ${s.local.selectedPreset(Dial.LOCAL).label}"
}
