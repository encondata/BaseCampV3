package com.serversherpa.kiosk.nettest

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.ui.theme.ChipTone

/**
 * The amber "Net test" chip for the top bar (design 4.3), shown only while
 * Internet Test is on. [onClick] should open Settings › Developer.
 *
 * A compact pill in the app's amber chip colors (no dot, small type, tight
 * padding) at the end of the bar's second line, after the person's name, which
 * gives way first. Even this small a chip, beside Sign out on the top line,
 * would cut the brand off on a 320 dp handheld.
 *
 * The press highlight hugs the pill. The pill takes no extra height, so the
 * bar stays as tall as it is. Its tap target still reaches 48 dp, because
 * Compose extends a small clickable's touch bounds to the minimum touch-target
 * size. A layout-padding minimum here would make the two-line bar 48 dp taller.
 */
@Composable
fun NetTestChip(onClick: () -> Unit) {
    val s by LocalAppContainer.current.internetTest.settings.collectAsStateWithLifecycle()
    if (!s.enabled) return
    val tone = ChipTone.AMBER
    val shape = RoundedCornerShape(999.dp)
    Text(
        "Net test",
        style = MaterialTheme.typography.labelSmall,
        color = tone.text,
        maxLines = 1,
        modifier = Modifier.padding(start = 4.dp)
            .clip(shape).background(tone.bg).border(1.dp, tone.border, shape)
            .clickable(onClickLabel = "Open Developer settings", role = Role.Button, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
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
