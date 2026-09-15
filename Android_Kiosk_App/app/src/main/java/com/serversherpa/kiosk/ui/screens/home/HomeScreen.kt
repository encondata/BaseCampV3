package com.serversherpa.kiosk.ui.screens.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.features.FEATURES
import com.serversherpa.kiosk.core.features.featureAvailable
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** kiosk/src/pages/Home.tsx: the launcher, two tiles per row. */
@Composable
fun HomeScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val setupState by container.prefs.setupState.collectAsStateWithLifecycle(initialValue = SetupState.INCOMPLETE)
    val devMode by container.prefs.devMode.collectAsStateWithLifecycle(initialValue = false)
    val complete = setupState == SetupState.COMPLETE
    val failed = setupState == SetupState.FAILED

    Column {
        PageHeader("Kiosk", "What would you like to do?")
        if (!complete && devMode) KioskToast("Developer mode: all features are available while kiosk setup is ${setupState.wire}.")
        if (!complete && !devMode) KioskToast(if (failed) "Kiosk setup failed. Open Kiosk Setup to try again." else "Kiosk setup is incomplete. Only Kiosk Setup and Settings are available.", error = failed)
        FEATURES.chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (f in pair) {
                    val available = featureAvailable(f, setupState, devMode)
                    SetupCard(selected = false, enabled = available, onClick = { nav.navigate(f.route) }, modifier = Modifier.weight(1f)) {
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
