package com.serversherpa.kiosk.nettest

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.theme.ChipTone
import kotlinx.coroutines.flow.MutableSharedFlow

/**
 * The amber "Net test" chip (design 4.3). It shows only while someone is
 * signed in and Internet Test is on; otherwise it renders nothing. A tap
 * should open Settings › Developer. Pass [onClick] where the screen has a
 * NavHostController to hand (the kiosk's top bar). Where it doesn't (the Time
 * Clock's header, several composables below its screen), leave [onClick] out:
 * the tap then goes to the [NetTestChipNavigation] on that screen.
 *
 * A compact pill: no dot, small type, tight padding. The press highlight hugs
 * the pill. Compose extends a small clickable's touch bounds toward the 48 dp
 * minimum, so the chip's tap area reaches 48 dp within the space around it;
 * a minimumInteractiveComponentSize() here would reserve the full 48 dp in
 * layout and make the top bar about 26 dp taller.
 *
 * In the top bar, which is always ink, the chip uses the app's amber
 * [ChipTone], with a small gap after it, and adds no height to the bar. It
 * leads the bar's second line, ahead of the kiosk name, because a Row
 * measures its unweighted children in order. That way the chip always gets
 * its full label first, however long the kiosk name is (up to 80 characters).
 * The bar's comment says the kiosk name is never clipped. That holds except
 * while an Internet Test runs: then a long kiosk name ellipsizes after the
 * chip, after the person's name has given way. On the top line, even this
 * small a chip would cut the brand off on a 320 dp handheld. Past the bar's
 * bottom edge, the page below takes the taps.
 *
 * [onLightPaper] is the Time Clock header's chip. The Time Clock is always
 * light paper, where the top bar's pale amber text would hardly show, so it
 * uses the portal's amber chip for a light surface (`.chip.c-amber` in
 * directory.css): dark amber text on the same translucent amber, with a small
 * gap below it. It sits above the date in the clock's column, so it never
 * takes width from the wordmark (a 320 dp handheld can't show the whole
 * wordmark as it is). While a test runs, the header is up to about 16 dp
 * taller.
 */
@Composable
fun NetTestChip(onClick: () -> Unit = ::requestDeveloperSettings, onLightPaper: Boolean = false) {
    val container = LocalAppContainer.current
    val s by container.internetTest.settings.collectAsStateWithLifecycle()
    val auth by container.auth.state.collectAsStateWithLifecycle()
    if (!s.enabled || auth !is AuthState.Authed) return
    val tone = if (onLightPaper) LightPaperAmber else DarkBarAmber
    val shape = RoundedCornerShape(999.dp)
    Text(
        "Net test",
        style = MaterialTheme.typography.labelSmall,
        color = tone.text,
        maxLines = 1,
        modifier = Modifier.padding(if (onLightPaper) PaddingValues(bottom = 2.dp) else PaddingValues(end = 4.dp))
            .clip(shape).background(tone.bg).border(1.dp, tone.border, shape)
            .clickable(onClickLabel = "Open Developer settings", role = Role.Button, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

/** A chip's text, fill and outline. */
private class ChipColors(val text: Color, val bg: Color, val border: Color)

/** The app's amber chip, for the ink top bar. */
private val DarkBarAmber = ChipColors(ChipTone.AMBER.text, ChipTone.AMBER.bg, ChipTone.AMBER.border)

/** The portal's light-surface amber chip: #a36207 on rgba(255, 161, 46, .14), outlined at .38. */
private val LightPaperAmber = ChipColors(Color(0xFFA36207), Color(0x24FFA12E), Color(0x61FFA12E))

/**
 * Taps on a [NetTestChip] drawn without an `onClick` of its own, for a
 * [NetTestChipNavigation] to answer. Nothing is replayed: a tap with
 * nothing on screen to answer it is dropped, never answered later.
 */
private val developerRequests = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

private fun requestDeveloperSettings() {
    developerRequests.tryEmit(Unit)
}

/**
 * Opens Settings › Developer when a [NetTestChip] without its own `onClick`
 * is tapped. Put it on a screen that has [nav] and draws such a chip deeper
 * down (TimeclockScreen, for the Time Clock's header), so the chip needs no
 * callback threaded through the screens between.
 */
@Composable
fun NetTestChipNavigation(nav: NavHostController) {
    LaunchedEffect(nav) {
        developerRequests.collect { nav.navigate(Routes.settings("developer")) }
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
