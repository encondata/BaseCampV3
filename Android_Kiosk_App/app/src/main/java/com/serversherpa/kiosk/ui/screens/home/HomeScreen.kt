package com.serversherpa.kiosk.ui.screens.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.features.FeatureId
import com.serversherpa.kiosk.core.features.homeFeatures
import com.serversherpa.kiosk.core.features.featureAvailable
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * kiosk/src/pages/Home.tsx: the launcher, two tiles per row. At a Time Clock station only Time
 * Clock, Kiosk Setup and Settings show; Time Clock (the web's Start Time Clock) gets the station
 * key if it is missing and signs the person out, which leaves the station on Welcome.
 */
@Composable
fun HomeScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val setupState by container.prefs.setupState.collectAsStateWithLifecycle(initialValue = SetupState.INCOMPLETE)
    val devMode by container.prefs.devMode.collectAsStateWithLifecycle(initialValue = false)
    val stationType by remember(container) { container.prefs.setupSelection.map { it?.stationType } }.collectAsStateWithLifecycle(initialValue = null)
    val complete = setupState == SetupState.COMPLETE
    val failed = setupState == SetupState.FAILED
    val scope = rememberCoroutineScope()
    var starting by remember { mutableStateOf(false) }
    var startError by remember { mutableStateOf<String?>(null) }
    val startTimeclock: () -> Unit = {
        if (!starting) {
            starting = true; startError = null
            scope.launch {
                try {
                    container.startTimeclock()
                } catch (e: CancellationException) { throw e
                } catch (e: Exception) {
                    startError = (e as? ApiError)?.let(::startTimeclockError) ?: "Couldn't start the time clock. Try again."
                } finally { starting = false }
            }
        }
    }

    Column {
        PageHeader("Kiosk", "What would you like to do?")
        if (!complete && devMode) KioskToast("Developer mode: all features are available while kiosk setup is ${setupState.wire}.")
        if (!complete && !devMode) KioskToast(if (failed) "Kiosk setup failed. Open Kiosk Setup to try again." else "Kiosk setup is incomplete. Only Kiosk Setup and Settings are available.", error = failed)
        startError?.let { KioskToast(it, error = true) }
        homeFeatures(stationType).chunked(2).forEach { pair ->
            // IntrinsicSize.Min + fillMaxHeight: both tiles in a row take the height of the
            // taller one, so a tile without the "Finish Kiosk Setup first." line (Kiosk Setup,
            // Settings) is not visibly shorter than the locked tile beside it.
            Row(
                Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(top = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                for (f in pair) {
                    val available = featureAvailable(f, setupState, devMode)
                    val station = f.id == FeatureId.TIMECLOCK_STATION
                    SetupCard(
                        selected = false,
                        enabled = available && !(station && starting),
                        onClick = { if (station) startTimeclock() else nav.navigate(f.route) },
                        modifier = Modifier.weight(1f).fillMaxHeight().testTag("tile-${f.id.name}"),
                    ) {
                        FeatureIcon(f.id, c.accent)
                        Text(f.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 8.dp))
                        Text(f.blurb, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
                        if (!available) Text(if (failed) "Kiosk setup failed — open Kiosk Setup." else "Finish Kiosk Setup first.", fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.textMute, modifier = Modifier.padding(top = 6.dp))
                    }
                }
                if (pair.size == 1) androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            }
        }
    }
}

/** Start Time Clock's errors (StartTimeclock.tsx): the key is what can go wrong here. */
internal fun startTimeclockError(e: ApiError): String = when {
    e.isNetwork -> "The station key hasn't arrived yet. Check the connection and try again in a minute."
    e.code == "move_locked" -> "A move password can't start the time clock. Sign in with your own account."
    else -> "Couldn't start the time clock (${e.code}). Try again."
}
