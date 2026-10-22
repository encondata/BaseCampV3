package com.serversherpa.kiosk.ui.screens.timeclock

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.nettest.NetTestChipNavigation // INTERNET-TEST
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.timeclock.flow.SessionTcBackend
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TcMode
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TimeclockFlowViewModel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map

/**
 * The regular kiosk's Timeclock tile: the guided flow in KIOSK mode on the kiosk's session. It
 * starts at Enter Your Name, and every exit (Done, idle, Back on Enter Your Name) goes Home. The
 * local people list is read again whenever a sync finishes.
 */
@Composable
fun TimeclockScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val vm = kioskViewModel {
        TimeclockFlowViewModel(
            mode = TcMode.KIOSK,
            backend = SessionTcBackend(container.db, container.api, container.identity, container.prefs),
            flash = container.flash,
            sound = container.sound,
            appearance = container.prefs.appearance,
            peopleReloads = container.sync.status.map { it.phase }.distinctUntilChanged().drop(1)
                .filter { it == SyncPhase.DONE || it == SyncPhase.IDLE }.map { },
        )
    }
    LaunchedEffect(vm) {
        vm.exits.collect { nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } } }
    }
    NetTestChipNavigation(nav) // INTERNET-TEST
    TimeclockFlowScreen(vm)
}
