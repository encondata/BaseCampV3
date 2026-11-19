package com.serversherpa.kiosk.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableLongState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.input.pointer.pointerInput
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.features.FeatureId
import com.serversherpa.kiosk.core.features.feature
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.ui.flash.ScanFlash
import com.serversherpa.kiosk.ui.flash.SledFlashOverlay
import com.serversherpa.kiosk.ui.guards.AdminGate
import com.serversherpa.kiosk.ui.guards.KioskGuard
import com.serversherpa.kiosk.ui.guards.SetupGate
import com.serversherpa.kiosk.ui.guards.StationIdleReturn
import com.serversherpa.kiosk.ui.screens.enroll.EnrollScreen
import com.serversherpa.kiosk.ui.screens.home.HomeScreen
import com.serversherpa.kiosk.ui.screens.labels.LabelsHomeScreen
import com.serversherpa.kiosk.ui.screens.labels.PrintLabelsScreen
import com.serversherpa.kiosk.ui.screens.labels.PrinterSetupScreen
import com.serversherpa.kiosk.ui.screens.login.EnrollOfferHost
import com.serversherpa.kiosk.ui.screens.login.LoginScreen
import com.serversherpa.kiosk.ui.screens.lookup.AssetLookupScreen
import com.serversherpa.kiosk.ui.screens.placeholder.FeaturePlaceholderScreen
import com.serversherpa.kiosk.ui.screens.rolodex.RolodexScreen
import com.serversherpa.kiosk.ui.screens.scan.ScanScreen
import com.serversherpa.kiosk.ui.screens.settings.SettingsScreen
import com.serversherpa.kiosk.ui.screens.setup.KioskSetupScreen
import com.serversherpa.kiosk.ui.screens.timeclock.TimeclockScreen
import com.serversherpa.kiosk.ui.screens.troubleshooting.TroubleshootingScreen
import com.serversherpa.kiosk.ui.screens.troubleshooting.TroubleshootingTopicScreen
import com.serversherpa.kiosk.ui.screens.notifications.NotificationsRoute
import com.serversherpa.kiosk.ui.shell.KioskShell
import com.serversherpa.kiosk.ui.shell.PendingNotificationRedirect
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.flow.Flow

@Composable
fun KioskApp() {
    val container = LocalAppContainer.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val prefs = (auth as? AuthState.Authed)?.preferences
    KioskTheme(theme = prefs?.theme ?: "light", accent = prefs?.accent ?: "amber") {
        val nav = rememberNavController()
        // The last touch anywhere, for the display's idle timer: seen in the initial pass, never
        // consumed, on the controller's clock. Only a finger going down counts (every drag and
        // fling starts with one), so a scroll does not restamp it on every frame.
        val lastTouch = remember { mutableLongStateOf(0L) }
        Box(Modifier.fillMaxSize().onEveryTouchDown { lastTouch.longValue = System.currentTimeMillis() }) {
            NavHost(nav, startDestination = Routes.HOME) {
                composable(Routes.LOGIN) { LoginScreen(nav) }
                // A signed-out Time Clock station rests on Welcome here (KioskGuard).
                composable(Routes.HOME) { KioskGuard(nav, stationHome = true) { KioskShell(nav) { HomeScreen(nav) } } }
                composable(Routes.SETUP) { KioskGuard(nav) { KioskShell(nav) { KioskSetupScreen(nav) } } }
                // Reachable signed out (sign-in's gear): a Time Clock station returns to Welcome when idle.
                composable(Routes.SETTINGS, arguments = listOf(navArgument("tab") { type = NavType.StringType; nullable = true })) { entry ->
                    StationIdleReturn(nav) { KioskShell(nav) { SettingsScreen(nav, entry.arguments?.getString("tab")) } }
                }
                // Routed like Settings: no setup step, and a station returns to Welcome when idle.
                composable(Routes.TROUBLESHOOTING) { StationIdleReturn(nav) { KioskShell(nav) { TroubleshootingScreen(nav) } } }
                // The topic page scrolls itself (so a barcode can be scrolled to), not the shell.
                composable(Routes.TROUBLESHOOTING_TOPIC, arguments = listOf(navArgument("topicId") { type = NavType.StringType })) { entry ->
                    StationIdleReturn(nav) { KioskShell(nav, scroll = false) { TroubleshootingTopicScreen(nav, entry.arguments?.getString("topicId")) } }
                }
                gated(nav, Routes.SCAN, FeatureId.SCAN) { ScanScreen(nav) }
                gated(nav, Routes.ENROLL, FeatureId.ENROLL) { EnrollScreen(nav) }
                // The time clock owns the whole screen (no kiosk top bar or footer), spec section 5.
                gated(nav, Routes.TIMECLOCK, FeatureId.TIMECLOCK, shell = false) { TimeclockScreen(nav) }
                gated(nav, Routes.CONTAINERS, FeatureId.CONTAINERS) { FeaturePlaceholderScreen(feature(FeatureId.CONTAINERS), nav) }
                gated(nav, Routes.TRUCKS, FeatureId.TRUCKS) { FeaturePlaceholderScreen(feature(FeatureId.TRUCKS), nav) }
                gated(nav, Routes.LOOKUP, FeatureId.LOOKUP) { AssetLookupScreen(nav) }
                gated(nav, Routes.LABELS, FeatureId.LABELS) { LabelsHomeScreen(nav) }
                gated(nav, Routes.LABELS_PRINT, FeatureId.LABELS) { PrintLabelsScreen(nav) }
                gated(nav, Routes.LABELS_PRINTER, FeatureId.LABELS) { PrinterSetupScreen(nav) }
                // Admins only, and no setup step: AdminGate instead of SetupGate. The list is a
                // LazyColumn, so the shell's page doesn't scroll.
                composable(Routes.ROLODEX) { KioskGuard(nav) { AdminGate(nav) { KioskShell(nav, scroll = false) { RolodexScreen(nav) } } } }
                // Admins' inbox (the Home tile), or a tapped push alert's item (PendingNotificationRedirect).
                // No setup step; the route checks the alert's owner before AdminGate. A LazyColumn, so no page scroll.
                composable(
                    Routes.NOTIFICATIONS_PATTERN,
                    arguments = listOf(
                        navArgument("highlight") { type = NavType.StringType; nullable = true },
                        navArgument("owner") { type = NavType.StringType; nullable = true },
                    ),
                ) { entry ->
                    KioskGuard(nav) {
                        KioskShell(nav, scroll = false) {
                            NotificationsRoute(nav, entry.arguments?.getString("highlight"), entry.arguments?.getString("owner"))
                        }
                    }
                }
            }
            ScanFlash(container.flash)
            SledFlashOverlay(container.rfid.sledFlashes, container.prefs.appearance)
            SledEffects(container, nav, lastTouch)
            EnrollOfferHost(container.enrollOffer)
            SetupClearedRedirect(nav, container.heartbeat.setupCleared)
            PendingNotificationRedirect(nav, container.pendingOpen, container.auth.state)
        }
    }
}

/** Calls [onDown] each time a finger goes down anywhere inside: seen in the initial pass and
 *  never consumed, so the content still gets every event. Moves are ignored (a drag or a fling
 *  starts with a down), so a scroll costs nothing per frame. */
internal fun Modifier.onEveryTouchDown(onDown: () -> Unit): Modifier = pointerInput(Unit) {
    awaitPointerEventScope {
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            if (event.changes.any { it.changedToDown() }) onDown()
        }
    }
}

/** The sled-screen signal and the display effect, beside the NavHost. The route and the last
 *  touch are read here, so a touch or a route change recomposes only this. */
@Composable
private fun SledEffects(container: AppContainer, nav: NavHostController, lastTouch: MutableLongState) {
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    SledScreenSignal(container, route)
    SledDisplayEffect(container, route, lastTouch.longValue)
}

/**
 * Clear Setup from the portal: whoever is signed in goes to Kiosk Setup, once. It lives
 * beside the NavHost, outside every route, so no route's guard or gate can drop the
 * collector before it sees the emission; [cleared] never replays, so a clear already
 * honored can't send anyone again. popUpTo(HOME) makes Back from Setup land on Home rather
 * than bouncing through the gated screen the person was on (same as SetupGate's redirect).
 */
@Composable
internal fun SetupClearedRedirect(nav: NavHostController, cleared: Flow<String>) {
    LaunchedEffect(nav, cleared) {
        cleared.collect {
            if (nav.currentDestination?.route != Routes.SETUP) nav.navigate(Routes.SETUP) { popUpTo(Routes.HOME); launchSingleTop = true }
        }
    }
}

/** KioskGuard + SetupGate + KioskShell around a feature screen; [shell] false for a full-screen one. */
private fun androidx.navigation.NavGraphBuilder.gated(
    nav: NavHostController, route: String, id: FeatureId, shell: Boolean = true, content: @Composable () -> Unit,
) {
    composable(route) { KioskGuard(nav) { SetupGate(feature(id), nav) { if (shell) KioskShell(nav) { content() } else content() } } }
}
