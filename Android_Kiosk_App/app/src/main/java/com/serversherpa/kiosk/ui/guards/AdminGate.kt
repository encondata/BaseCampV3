package com.serversherpa.kiosk.ui.guards

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.ui.Routes

/**
 * Shows [content] only to an admin (rank 60+: admin, super admin, founder, developer). Anyone else
 * who reaches the route (staff, a worker, a move-password sign-in) goes Home, popping this route so
 * Back can't return to it. Sits inside [KioskGuard], which owns the signed-out and loading cases;
 * nothing shows while auth is still loading.
 */
@Composable
fun AdminGate(nav: NavHostController, content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    when {
        (auth as? AuthState.Authed)?.isAdmin == true -> content()
        auth == AuthState.Loading -> {}
        else -> LaunchedEffect(Unit) { nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } } }
    }
}
