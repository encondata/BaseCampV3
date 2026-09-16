package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.settings.DEFAULT_TAB
import com.serversherpa.kiosk.core.settings.SettingsTabId
import com.serversherpa.kiosk.core.settings.visibleTabs
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** kiosk/src/pages/Settings.tsx: a tab strip and one panel. */
@Composable
fun SettingsScreen(nav: NavHostController, requestedTab: String?) {
    val container = LocalAppContainer.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val authed = auth as? AuthState.Authed
    val tabs = visibleTabs(isAdmin = authed?.isAdmin == true, isDeveloper = authed?.isDeveloper == true, signedIn = authed != null)
    // Keyed on WHICH tabs are visible, not how many: signing in can swap one tab
    // for another without changing the count, and the old selection would linger.
    var selected by remember(requestedTab, tabs.map { it.id }) {
        mutableStateOf((SettingsTabId.fromWire(requestedTab)?.takeIf { id -> tabs.any { it.id == id } } ?: tabs.firstOrNull { it.id == DEFAULT_TAB }?.id ?: tabs.first().id))
    }
    // A selection that is no longer visible falls back rather than crashing.
    val active = tabs.firstOrNull { it.id == selected } ?: tabs.first()
    Column {
        PageHeader("Kiosk · Settings", "Settings")
        Segmented(tabs.map { it.id.wire to it.label }, active.id.wire) { w -> SettingsTabId.fromWire(w)?.let { selected = it } }
        Text(active.label, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 16.dp))
        Text(active.blurb, style = MaterialTheme.typography.bodyMedium, color = LocalKioskColors.current.textMute, modifier = Modifier.padding(bottom = 8.dp))
        when (active.id) {
            SettingsTabId.THIS_KIOSK -> ThisKioskPanel()
            SettingsTabId.APPEARANCE -> AppearancePanel()
            SettingsTabId.SOUND -> SoundPanel()
            SettingsTabId.DEVICES -> DevicesPanel()
            SettingsTabId.ADMIN -> AdminPanel()
            SettingsTabId.DEVELOPER -> DeveloperPanel()
        }
    }
}
