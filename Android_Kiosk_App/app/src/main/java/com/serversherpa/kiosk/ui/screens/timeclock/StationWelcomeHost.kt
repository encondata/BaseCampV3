package com.serversherpa.kiosk.ui.screens.timeclock

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.station.StationStatus
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.timeclock.flow.StationTcBackend
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TcMode
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TcStep
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TimeclockFlowViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.merge

/** How often a paused station tries its people read again (StationRoot.tsx re-reads the
 *  station info every minute), so a renewed registration un-pauses it on its own. */
const val STATION_RETRY_MS = 60_000L

/**
 * A Time Clock station with nobody signed in (StationRoot.tsx): the guided flow in STATION mode
 * on the station key, resting on Welcome. The people list is read through the station route into
 * the local copy when it starts and on every return to Welcome (the flow's own start-step reload).
 * The gear on Welcome goes to sign-in.
 *
 * Welcome takes nobody while the station is paused (403 `kiosk_not_registered`: the key is kept)
 * or has no key (none yet, or dropped by a 401 or `wrong_station_type`); either one sends a
 * flow that is under way back to Welcome, where the notice explains it. A paused station tries
 * again every minute; a key that arrives (signed in here, Time Clock tile) reloads the people.
 */
@Composable
fun StationWelcomeHost(nav: NavHostController) {
    val container = LocalAppContainer.current
    val station = container.station
    val vm = kioskViewModel {
        TimeclockFlowViewModel(
            mode = TcMode.STATION,
            backend = StationTcBackend(container.db, container.stationApi, station, container.identity),
            flash = container.flash,
            sound = container.sound,
            appearance = container.prefs.appearance,
            peopleReloads = stationReloads(station),
        )
    }
    val paused by station.paused.collectAsStateWithLifecycle()
    val hasKey by station.hasKey.collectAsStateWithLifecycle()
    // The key's first read, off the main thread: until it lands the station is neither missing
    // its key nor paused.
    LaunchedEffect(station) { station.key() }
    val keyMissing = hasKey == false
    val off = paused || keyMissing
    LaunchedEffect(off) { if (off && vm.state.value.step != TcStep.WELCOME) vm.reset() }
    TimeclockFlowScreen(
        vm,
        onSettings = { nav.navigate(Routes.LOGIN) { launchSingleTop = true } },
        paused = off,
        keyMissing = keyMissing && !paused,
    )
}

/** Reads the people again every [STATION_RETRY_MS] while the station is paused, and when a key
 *  arrives after being missing. */
private fun stationReloads(station: StationStatus): Flow<Unit> = merge(
    flow { while (true) { delay(STATION_RETRY_MS); if (station.paused.value) emit(Unit) } },
    flow {
        var last = station.hasKey.value
        station.hasKey.collect { now -> if (last == false && now == true) emit(Unit); last = now }
    },
)
