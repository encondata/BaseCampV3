package com.serversherpa.kiosk.ui.guards

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.features.KioskFeature
import com.serversherpa.kiosk.core.features.featureAvailable
import com.serversherpa.kiosk.ui.Routes

/**
 * Redirects to Home unless the feature is usable in the kiosk's setup state (dev mode
 * overrides). A setup an administrator just cleared (the Clear Setup notice is up) goes
 * to Kiosk Setup instead, popping this screen so Back doesn't return to it. Nothing
 * happens when the kiosk is already on Setup.
 */
@Composable
fun SetupGate(feature: KioskFeature, nav: NavHostController, content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val setup by container.prefs.setupStateWithClearNotice.collectAsStateWithLifecycle(initialValue = null)
    val devMode by container.prefs.devMode.collectAsStateWithLifecycle(initialValue = false)
    val (state, clearNotice) = setup ?: return   // still reading
    if (featureAvailable(feature, state, devMode)) content()
    else LaunchedEffect(clearNotice) {
        // A Clear Setup sends the person to Kiosk Setup while this screen is still
        // composed (leaving); bouncing them Home from here would pop Setup right off.
        if (nav.currentDestination?.route == Routes.SETUP) return@LaunchedEffect
        if (clearNotice) nav.navigate(Routes.SETUP) { popUpTo(Routes.HOME); launchSingleTop = true }
        else nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } }
    }
}
