package com.serversherpa.kiosk.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.features.FeatureId
import com.serversherpa.kiosk.core.features.feature
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.ui.flash.ScanFlash
import com.serversherpa.kiosk.ui.guards.KioskGuard
import com.serversherpa.kiosk.ui.guards.SetupGate
import com.serversherpa.kiosk.ui.screens.enroll.EnrollScreen
import com.serversherpa.kiosk.ui.screens.home.HomeScreen
import com.serversherpa.kiosk.ui.screens.login.LoginScreen
import com.serversherpa.kiosk.ui.screens.placeholder.FeaturePlaceholderScreen
import com.serversherpa.kiosk.ui.screens.scan.ScanScreen
import com.serversherpa.kiosk.ui.screens.settings.SettingsScreen
import com.serversherpa.kiosk.ui.screens.setup.KioskSetupScreen
import com.serversherpa.kiosk.ui.screens.timeclock.TimeclockScreen
import com.serversherpa.kiosk.ui.shell.KioskShell
import com.serversherpa.kiosk.ui.theme.KioskTheme

@Composable
fun KioskApp() {
    val container = LocalAppContainer.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val prefs = (auth as? AuthState.Authed)?.preferences
    KioskTheme(theme = prefs?.theme ?: "light", accent = prefs?.accent ?: "amber") {
        val nav = rememberNavController()
        Box(androidx.compose.ui.Modifier.fillMaxSize()) {
            NavHost(nav, startDestination = Routes.HOME) {
                composable(Routes.LOGIN) { LoginScreen(nav) }
                composable(Routes.HOME) { KioskGuard(nav) { KioskShell(nav) { HomeScreen(nav) } } }
                composable(Routes.SETUP) { KioskGuard(nav) { KioskShell(nav) { KioskSetupScreen(nav) } } }
                composable(Routes.SETTINGS, arguments = listOf(navArgument("tab") { type = NavType.StringType; nullable = true })) { entry ->
                    KioskShell(nav) { SettingsScreen(nav, entry.arguments?.getString("tab")) }
                }
                gated(nav, Routes.SCAN, FeatureId.SCAN) { ScanScreen(nav) }
                gated(nav, Routes.ENROLL, FeatureId.ENROLL) { EnrollScreen(nav) }
                gated(nav, Routes.TIMECLOCK, FeatureId.TIMECLOCK) { TimeclockScreen(nav) }
                gated(nav, Routes.CONTAINERS, FeatureId.CONTAINERS) { FeaturePlaceholderScreen(feature(FeatureId.CONTAINERS), nav) }
                gated(nav, Routes.TRUCKS, FeatureId.TRUCKS) { FeaturePlaceholderScreen(feature(FeatureId.TRUCKS), nav) }
                gated(nav, Routes.LABELS, FeatureId.LABELS) { FeaturePlaceholderScreen(feature(FeatureId.LABELS), nav) }
            }
            ScanFlash(container.flash)
        }
    }
}

/** KioskGuard + SetupGate + KioskShell around a feature screen. */
private fun androidx.navigation.NavGraphBuilder.gated(nav: NavHostController, route: String, id: FeatureId, content: @Composable () -> Unit) {
    composable(route) { KioskGuard(nav) { SetupGate(feature(id), nav) { KioskShell(nav) { content() } } } }
}
