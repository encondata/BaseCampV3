package com.serversherpa.kiosk.ui.guards

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.station.TIMECLOCK_STATION
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.screens.timeclock.StationWelcomeHost
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * The kiosk's ProtectedRoute: Loading → spinner, Anon → login, must-change-password → notice.
 *
 * A Time Clock station is the exception (StationRoot.tsx): with nobody signed in it rests on
 * Welcome, never the sign-in page, with or without its key (Welcome then says it is waiting for
 * one). Welcome lives on Home ([stationHome]); an anonymous station on any other route goes there.
 * Every other route still needs someone signed in.
 */
@Composable
fun KioskGuard(nav: NavHostController, stationHome: Boolean = false, content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val state by container.auth.state.collectAsStateWithLifecycle()
    val portalUrl by container.config.portalUrl.collectAsStateWithLifecycle(initialValue = "")
    val scope = rememberCoroutineScope()
    // null until the saved setup has been read, so a station never flashes the sign-in page.
    val station by remember(container) { container.prefs.setupSelection.map { it?.stationType == TIMECLOCK_STATION } }
        .collectAsStateWithLifecycle(initialValue = null)
    when (val s = state) {
        AuthState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        AuthState.Anon -> when (station) {
            null -> {}
            true -> if (stationHome) StationWelcomeHost(nav) else LaunchedEffect(Unit) { nav.navigate(Routes.HOME) { popUpTo(0) } }
            false -> LaunchedEffect(Unit) { nav.navigate(Routes.LOGIN) { popUpTo(0) } }
        }
        is AuthState.Authed -> if (s.mustChangePassword) {
            MustChangePasswordNotice(portalUrl) { scope.launch { container.logout(); nav.navigate(Routes.LOGIN) { popUpTo(0) } } }
        } else content()
    }
}

@Composable
fun MustChangePasswordNotice(portalUrl: String, onSignOut: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        PageHeader("Kiosk", "Password change required")
        Text("Your password needs to be changed before you can use a kiosk. Sign in to the portal at $portalUrl to change it.",
            style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(bottom = 16.dp))
        MiniButton("Sign out", onSignOut)
    }
}
