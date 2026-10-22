package com.serversherpa.kiosk.ui.guards

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.input.pointer.pointerInput
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.station.TIMECLOCK_STATION
import com.serversherpa.kiosk.ui.Routes
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.map

/** On a Time Clock station an untouched signed-out page goes back to the time clock after this long. */
const val TIMECLOCK_RETURN_MS = 60_000L

/** Restarts [StationIdleReturn]'s count: text fields on those pages call it on every change,
 *  since typing on the system keyboard sends no touch the page could see. A no-op elsewhere. */
val LocalStationActivity = staticCompositionLocalOf<() -> Unit> { {} }

/**
 * The pages a signed-out Time Clock station can reach from Welcome's gear (sign-in, and Settings
 * from sign-in's gear) go back to Welcome after [TIMECLOCK_RETURN_MS] with no touch, so a
 * worker who wandered in can't strand the station there (Login.tsx's idle return). Any touch,
 * a change of [restartKey] (typed text), or a call to [LocalStationActivity] starts the count again. Signed in, or on any other
 * kiosk, it does nothing.
 */
@Composable
fun StationIdleReturn(nav: NavHostController, restartKey: Any? = null, content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val station by remember(container) { container.prefs.setupSelection.map { it?.stationType == TIMECLOCK_STATION } }
        .collectAsStateWithLifecycle(initialValue = false)
    val active = station && auth == AuthState.Anon
    var touched by remember { mutableIntStateOf(0) }
    LaunchedEffect(active, touched, restartKey) {
        if (active) { delay(TIMECLOCK_RETURN_MS); nav.navigate(Routes.HOME) { popUpTo(0) } }
    }
    Box(
        Modifier.fillMaxSize().pointerInput(Unit) {
            awaitPointerEventScope {
                while (true) {
                    val e = awaitPointerEvent(PointerEventPass.Initial)
                    if (e.changes.any { it.changedToDown() }) touched++
                }
            }
        },
    ) { CompositionLocalProvider(LocalStationActivity provides { touched++ }) { content() } }
}
