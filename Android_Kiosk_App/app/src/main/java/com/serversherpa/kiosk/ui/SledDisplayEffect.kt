package com.serversherpa.kiosk.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.SLED_DISPLAY_IDLE_MS
import com.serversherpa.kiosk.core.rfid.SledRouteKind
import com.serversherpa.kiosk.core.rfid.keepDisplayOn
import com.serversherpa.kiosk.core.settings.SettingsTabId
import kotlinx.coroutines.delay

/** The screens where the sled is used (ruling 4's sled screens, Settings › RFID aside). */
val SLED_ROUTES: Set<String> = setOf(Routes.SCAN, Routes.LOOKUP, Routes.ENROLL, Routes.LABELS_PRINT)

/** [route] (a destination's route pattern) as the display table's screen kind. */
fun sledRouteKind(route: String?): SledRouteKind = when (route) {
    Routes.SCAN, Routes.LOOKUP -> SledRouteKind.SCAN_OR_LOOKUP
    Routes.ENROLL, Routes.LABELS_PRINT -> SledRouteKind.ENROLL_OR_PRINT
    else -> SledRouteKind.OTHER
}

/** Time since [lastActivity]; never negative (an activity stamped a moment ahead counts as now). */
private fun idleSince(lastActivity: Long, now: Long): Long = (now - lastActivity).coerceAtLeast(0)

/**
 * The sled-screen signal (ruling 33), beside the NavHost: tells the controller whether a sled
 * screen is in front, from the route and, on Settings, the tab `SettingsScreen` publishes.
 */
@Composable
internal fun SledScreenSignal(container: AppContainer, route: String?) {
    val tab by container.settingsTab.collectAsState()
    LaunchedEffect(route, tab) {
        container.rfid.setSledScreenOpen(route in SLED_ROUTES || (route == Routes.SETTINGS && tab == SettingsTabId.RFID))
    }
}

/**
 * Keeps the display on while the sled is in use (ruling 5): the one place that sets
 * `keepScreenOn` (never-call scan 2), and it sets nothing else. [lastTouchMs] and [now] are on
 * the controller's clock (`System.currentTimeMillis`). With no further event the display is
 * released [SLED_DISPLAY_IDLE_MS] after the last activity: a wait from that activity recomputes.
 */
@Composable
internal fun SledDisplayEffect(
    container: AppContainer,
    route: String?,
    lastTouchMs: Long = 0L,
    now: () -> Long = System::currentTimeMillis,
) {
    val view = LocalView.current
    val settings by container.prefs.rfid.collectAsState(initial = DEFAULT_RFID_SETTINGS)
    val connection by container.rfid.connection.collectAsState()
    val reconnecting by container.rfid.reconnecting.collectAsState()
    val layoutUsesScanner by container.rfid.layoutInForceUsesScanner.collectAsState()
    val lastSledActivity by container.rfid.lastActivityMs.collectAsState()
    val lastActivity = maxOf(lastSledActivity, lastTouchMs)
    // Bumped when the idle wait ends, so the table is read again with no other change.
    var recheck by remember { mutableIntStateOf(0) }
    LaunchedEffect(lastActivity) {
        while (true) {
            val left = SLED_DISPLAY_IDLE_MS - idleSince(lastActivity, now())
            if (left <= 0) break
            delay(left)
            recheck++
        }
    }
    val on = recheck.let {
        keepDisplayOn(sledRouteKind(route), settings.enabled, connection, reconnecting, layoutUsesScanner, idleSince(lastActivity, now()))
    }
    DisposableEffect(view, on) {
        view.keepScreenOn = on
        onDispose { }
    }
    DisposableEffect(view) { onDispose { view.keepScreenOn = false } }
}
