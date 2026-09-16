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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import kotlinx.coroutines.launch

/** The kiosk's ProtectedRoute: Loading → spinner, Anon → login, must-change-password → notice. */
@Composable
fun KioskGuard(nav: NavHostController, content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val state by container.auth.state.collectAsStateWithLifecycle()
    val portalUrl by container.config.portalUrl.collectAsStateWithLifecycle(initialValue = "")
    val scope = rememberCoroutineScope()
    when (val s = state) {
        AuthState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        AuthState.Anon -> LaunchedEffect(Unit) { nav.navigate(Routes.LOGIN) { popUpTo(0) } }
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
