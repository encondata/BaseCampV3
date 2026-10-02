package com.serversherpa.kiosk.ui.guards

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.features.KioskFeature
import com.serversherpa.kiosk.core.features.featureAvailable
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.ui.Routes

/** Redirects to Home unless the feature is usable in the kiosk's setup state (dev mode overrides) —
 *  except when the kiosk has already moved on to Kiosk Setup. */
@Composable
fun SetupGate(feature: KioskFeature, nav: NavHostController, content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val setupState by container.prefs.setupState.collectAsStateWithLifecycle(initialValue = null)
    val devMode by container.prefs.devMode.collectAsStateWithLifecycle(initialValue = false)
    val state = setupState ?: return   // still reading
    if (featureAvailable(feature, state as SetupState, devMode)) content()
    else LaunchedEffect(Unit) {
        // A Clear Setup sends the person to Kiosk Setup while this screen is still
        // composed (leaving); bouncing them Home from here would pop Setup right off.
        if (nav.currentDestination?.route == Routes.SETUP) return@LaunchedEffect
        nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } }
    }
}
