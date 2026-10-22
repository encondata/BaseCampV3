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
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.ui.theme.ChipTone

/**
 * The amber "Net test" chip for the top bar (design 4.3). It shows only while
 * someone is signed in and Internet Test is on; otherwise it renders nothing.
 * [onClick] should open Settings › Developer.
 *
 * A compact pill in the app's amber chip colors (no dot, small type, tight
 * padding). It leads the bar's second line, ahead of the kiosk name, because a
 * Row measures its unweighted children in order. That way the chip always gets
 * its full label first, however long the kiosk name is (up to 80 characters).
 * The bar's comment says the kiosk name is never clipped. That holds except
 * while an Internet Test runs: then a long kiosk name ellipsizes after the
 * chip, after the person's name has given way. On the top line, even this
 * small a chip would cut the brand off on a 320 dp handheld.
 *
 * The press highlight hugs the pill, and the pill adds no height to the bar.
 * Compose extends a small clickable's touch bounds toward the 48 dp minimum,
 * so the chip's tap area reaches 48 dp within the bar. Past the bar's bottom
 * edge, though, the page below takes the taps. A
 * minimumInteractiveComponentSize() here would reserve the full 48 dp in
 * layout and make the two-line bar about 26 dp taller.
 */
@Composable
fun NetTestChip(onClick: () -> Unit) {
    val container = LocalAppContainer.current
    val s by container.internetTest.settings.collectAsStateWithLifecycle()
    val auth by container.auth.state.collectAsStateWithLifecycle()
    if (!s.enabled || auth !is AuthState.Authed) return
    val tone = ChipTone.AMBER
    val shape = RoundedCornerShape(999.dp)
    Text(
        "Net test",
        style = MaterialTheme.typography.labelSmall,
        color = tone.text,
        maxLines = 1,
        modifier = Modifier.padding(end = 4.dp)
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
