package com.serversherpa.kiosk.ui.screens.settings

import com.serversherpa.kiosk.ui.guards.LocalStationActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.identity.KioskIdentity
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.LinkButton
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

const val FINGERPRINT_ON_TEXT = "Fingerprint sign-in: On ·"
const val FINGERPRINT_FORGET = "Forget this device"
const val FINGERPRINT_OFF_TEXT = "Off. After a password sign-in on a phone assigned to you, the app offers to turn it on."
const val FINGERPRINT_NOT_YOURS_TEXT = "On for another person. Only they can forget it here, or an admin in the portal."
const val FINGERPRINT_FORGOTTEN = "This phone forgot fingerprint sign-in."
const val FINGERPRINT_FORGET_FAILED = "Couldn't forget fingerprint sign-in on this phone. Try again."
const val FINGERPRINT_FORGOTTEN_HERE_ONLY = "This phone forgot fingerprint sign-in, but the portal couldn't be reached. An admin can remove it there."

/**
 * Fingerprint sign-in on this phone: "On · Forget this device" for its own person (signed in) or
 * anyone signed out (then the phone forgets it, and the portal's key is useless without it),
 * otherwise a line saying why there is nothing to forget.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FingerprintRow() {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()
    // Collected on the main thread, so the value is written to Compose state there. Under the
    // Compose test harness the collector otherwise resumed on DataStore's IO thread, and that
    // background write sometimes never redrew the row.
    val enrollment by container.biometric.enrollment.collectAsStateWithLifecycle(initialValue = null, context = Dispatchers.Main.immediate)
    val auth by container.auth.state.collectAsStateWithLifecycle()
    var busy by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf<String?>(null) }
    val signedIn = auth as? AuthState.Authed
    val mine = enrollment?.let { e -> signedIn == null || e.personId == signedIn.person.id } == true
    SettingsRow("Biometric sign-in", "Sign in with fingerprint or face on a phone assigned to you.") {
        when {
            enrollment == null -> Text(FINGERPRINT_OFF_TEXT, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("fingerprint-row"))
            !mine -> Text(FINGERPRINT_NOT_YOURS_TEXT, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("fingerprint-row"))
            else -> FlowRow(Modifier.testTag("fingerprint-row"), verticalArrangement = Arrangement.Center) {
                Text(FINGERPRINT_ON_TEXT, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.align(Alignment.CenterVertically))
                LinkButton(FINGERPRINT_FORGET, Modifier.testTag("fingerprint-forget")) {
                    if (busy) return@LinkButton
                    busy = true
                    scope.launch {
                        done = try {
                            if (container.biometric.forget(signedIn = signedIn != null)) FINGERPRINT_FORGOTTEN else FINGERPRINT_FORGOTTEN_HERE_ONLY
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            FINGERPRINT_FORGET_FAILED      // the phone's record couldn't be written
                        } finally {
                            busy = false
                        }
                    }
                }
            }
        }
        KioskToast(done)
    }
}

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
    // Signed out at a Time Clock station, typing keeps the page from returning to Welcome.
    val activity = LocalStationActivity.current
    var urlError by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(identity.name) { name = identity.name }
    LaunchedEffect(apiUrl) { api = apiUrl }
    LaunchedEffect(portalUrl) { portal = portalUrl }

    Column {
        SettingsRow("Kiosk name", "What people see on their phone when they link with this kiosk. 1–80 characters.") {
            OutlinedTextField(name, { name = it; nameError = null; activity() }, singleLine = true, isError = nameError != null, modifier = Modifier.fillMaxWidth().testTag("kiosk-name"))
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
        FingerprintRow()
        SettingsRow("API URL", "Where this kiosk talks to the portal. Must start with http:// or https://.") {
            OutlinedTextField(api, { api = it; urlError = null; activity() }, singleLine = true, isError = urlError != null, modifier = Modifier.fillMaxWidth().testTag("api-url"))
            OutlinedTextField(portal, { portal = it; urlError = null; activity() }, singleLine = true, label = { Text("Portal URL") }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            KioskToast(urlError, error = true)
            Row(Modifier.padding(top = 8.dp)) {
                MiniButton("Save URLs", onClick = {
                    val a = KioskConfig.normalizeUrl(api); val p = KioskConfig.normalizeUrl(portal)
                    if (a == null || p == null) { urlError = "Enter full http:// or https:// origins." }
                    else scope.launch { container.saveApiUrl(a); container.prefs.setPortalUrl(p); saved = "URLs saved. Sign in again if the API changed." }
                })
            }
        }
        SettingsRow("Version") { Text(container.config.kioskVersion, fontFamily = FragmentMono) }
        KioskToast(saved)
    }
}
