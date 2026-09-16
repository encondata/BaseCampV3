package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.identity.KioskIdentity
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
import kotlinx.coroutines.launch

/** Name, serial, mode, API/portal URLs, version — usable signed out. */
@Composable
fun ThisKioskPanel() {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()
    val identity by container.identity.identity.collectAsStateWithLifecycle(initialValue = KioskIdentity("", ""))
    val apiUrl by container.config.apiUrl.collectAsStateWithLifecycle(initialValue = "")
    val portalUrl by container.config.portalUrl.collectAsStateWithLifecycle(initialValue = "")
    val auth by container.auth.state.collectAsStateWithLifecycle()
    var name by remember { mutableStateOf("") }
    var api by remember { mutableStateOf("") }
    var portal by remember { mutableStateOf("") }
    var nameError by remember { mutableStateOf<String?>(null) }
    var urlError by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(identity.name) { name = identity.name }
    LaunchedEffect(apiUrl) { api = apiUrl }
    LaunchedEffect(portalUrl) { portal = portalUrl }

    Column {
        SettingsRow("Kiosk name", "What people see on their phone when they link with this kiosk. 1–80 characters.") {
            OutlinedTextField(name, { name = it; nameError = null }, singleLine = true, isError = nameError != null, modifier = Modifier.fillMaxWidth().testTag("kiosk-name"))
            KioskToast(nameError, error = true)
            MiniButton("Save name", onClick = {
                scope.launch {
                    if (container.identity.setName(name)) { saved = "Name saved."; nameError = null; if (auth is AuthState.Authed) container.heartbeat.now() }
                    else nameError = "Enter a name between 1 and 80 characters."
                }
            }, modifier = Modifier.padding(top = 8.dp))
        }
        SettingsRow("Serial", "Generated once for this install; the portal's Kiosk Devices page lists it.") { Text(identity.serial, fontFamily = FragmentMono) }
        SettingsRow("Mode") { Text("Android", fontFamily = FragmentMono) }
        SettingsRow("API URL", "Where this kiosk talks to the portal. Must start with http:// or https://.") {
            OutlinedTextField(api, { api = it; urlError = null }, singleLine = true, isError = urlError != null, modifier = Modifier.fillMaxWidth().testTag("api-url"))
            OutlinedTextField(portal, { portal = it; urlError = null }, singleLine = true, label = { Text("Portal URL") }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            KioskToast(urlError, error = true)
            Row(Modifier.padding(top = 8.dp)) {
                MiniButton("Save URLs", onClick = {
                    val a = KioskConfig.normalizeUrl(api); val p = KioskConfig.normalizeUrl(portal)
                    if (a == null || p == null) { urlError = "Enter full http:// or https:// origins." }
                    else scope.launch { container.prefs.setApiUrl(a); container.prefs.setPortalUrl(p); saved = "URLs saved. Sign in again if the API changed." }
                })
            }
        }
        SettingsRow("Version") { Text(container.config.kioskVersion, fontFamily = FragmentMono) }
        KioskToast(saved)
    }
}
