package com.serversherpa.kiosk.ui.screens.settings

import com.serversherpa.kiosk.ui.guards.LocalStationActivity
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PersonalState
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.identity.KioskIdentity
import com.serversherpa.kiosk.data.push.PushSetupFailed
import com.serversherpa.kiosk.data.push.PushUnavailable
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.LinkButton
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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

const val PERSONAL_LABEL = "This is my phone"
const val PERSONAL_HINT = "Marks this phone as yours: your notifications come here, and biometric sign-in can be turned on."
const val PERSONAL_CHECKING = "Checking…"
const val PERSONAL_PUSH_NOT_SET_UP = "Push isn't set up on this phone yet. The app tries again each time you sign in or open Settings."
const val PERSONAL_LOAD_FAILED = "Couldn't check whether this phone is yours."
const val PERSONAL_TRY_AGAIN = "Try again"
const val NOTIFICATIONS_BLOCKED_TEXT = "Notifications are blocked for this app."
const val OPEN_NOTIFICATION_SETTINGS = "Open notification settings"
const val PUSH_UNAVAILABLE_TEXT = "Push isn't available in this build."

/** "This phone belongs to <owner>": someone else's phone, so no switch. */
fun personalOwnedBy(owner: String) = "This phone belongs to $owner"

/** The block is for admins (rank 60+), never on a Zebra handheld (the server refuses those too). */
fun personalBlockVisible(isAdmin: Boolean, zebra: Boolean): Boolean = isAdmin && !zebra

/** A refused or failed "This is my phone" (or its push step) in plain words. */
fun personalErrorText(e: Throwable): String {
    if (e is PushSetupFailed) return pushErrorText(e.cause)
    val api = e as? ApiError ?: return "Couldn't change this setting. Try again."
    if (api.code == "not_eligible") return when (api.detailString("reason")) {
        "not_admin" -> "Only admins can mark a phone as theirs."
        "zebra" -> "A Zebra handheld can't be anyone's phone."
        "shared_station" -> "This kiosk is a shared station, so it can't be anyone's phone."
        "platform_unknown" -> "The portal doesn't know what kind of phone this is yet. Try again in a minute."
        "owned_by_other" -> "This phone already belongs to someone else."
        "not_owner" -> "Only the phone's owner can turn this off."
        "no_account" -> "You don't have a sign-in account, so this phone can't be yours."
        "account_disabled" -> "Your account is disabled, so this phone can't be yours."
        "no_kiosk_view" -> "You don't have kiosk access, so this phone can't be yours."
        "move_identity" -> "A move's kiosk sign-in can't own a phone. Sign in with your own account."
        else -> "The portal refused this change."
    }
    return when {
        api.isNetwork -> "Couldn't reach the portal. Try again."
        api.code == "not_this_kiosk" -> "The portal hasn't heard from this phone yet. Try again in a minute."
        api.status == 423 -> "The portal is read-only right now. Try again later."
        else -> "Couldn't change this setting. Try again."
    }
}

private fun pushErrorText(cause: Throwable): String = when {
    cause is PushUnavailable -> PUSH_UNAVAILABLE_TEXT
    cause is ApiError && cause.isNetwork -> "This phone is yours, but push couldn't be set up: the portal couldn't be reached. $PUSH_RETRIES"
    cause is ApiError && cause.status == 423 -> "This phone is yours, but push couldn't be set up: the portal is read-only right now. $PUSH_RETRIES"
    else -> "This phone is yours, but push couldn't be set up. $PUSH_RETRIES"
}

private const val PUSH_RETRIES = "The app tries again each time you sign in or open Settings."

private fun notificationsAllowed(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

private fun needsNotificationPermission(context: Context): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

/**
 * "This is my phone" (admins only, never on a Zebra): the server's state on each open, so a portal
 * reassignment shows. Someone else's phone shows its owner and no switch. Turning it on claims the
 * phone and registers it for push, then (Android 13+) asks for POST_NOTIFICATIONS; refused, the
 * switch stays on (biometric sign-in still works) and a line says notifications are blocked, with
 * a button to the app's notification settings. A phone made personal in the portal never saw
 * the switch: the first open that finds it registered without the permission asks, once per
 * phone (KioskPrefs.notificationPermissionAsked).
 *
 * Reading the state also brings the phone in line (PushRegistrar.check): push registered again
 * silently when it is missing, a released phone's key dropped. Every call runs on the app's own
 * scope and the screen only awaits it, so leaving Settings mid-call can't leave the server
 * registered and the phone without its key.
 */
@Composable
private fun PersonalPhoneRow(signedIn: AuthState.Authed) {
    val container = LocalAppContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val c = LocalKioskColors.current
    val registrar = container.pushRegistrar
    // Non-null once a heartbeat has bound the session to this phone: a read made before then
    // (403 not_this_kiosk) is made again. Collected on the main thread, like FingerprintRow's.
    val bound = container.heartbeat.registration.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate).value != null
    var state by remember { mutableStateOf<PersonalState?>(null) }
    var loadFailed by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var allowed by remember { mutableStateOf(notificationsAllowed(context)) }
    var loads by remember { mutableStateOf(0) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = notificationsAllowed(context) }
    // Back from the notification settings: Android sends nothing when they change.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { allowed = notificationsAllowed(context) }

    /** Asks for POST_NOTIFICATIONS (Android 13+) and remembers on this phone that it did. With
     *  [onlyOnce], not when it asked before (a flag that can't be read: not now either). The ask
     *  goes first and the flag is written on the app's scope after it, so a load restarted or a
     *  screen left mid-write never leaves the flag set without the ask. Call on the main thread. */
    suspend fun askForNotifications(onlyOnce: Boolean) {
        if (onlyOnce) {
            val askedBefore = try {
                container.prefs.notificationPermissionAsked.first()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                true
            }
            if (askedBefore) return
        }
        permission.launch(Manifest.permission.POST_NOTIFICATIONS)
        container.scope.launch {
            try { container.prefs.setNotificationPermissionAsked() } catch (e: CancellationException) { throw e } catch (_: Exception) { }
        }
    }

    // Every await below resumes on the main thread (withContext): the app-scope work finishes on a
    // Default/IO worker, and Compose state written there (under the test harness's unconfined
    // effect dispatcher) sometimes never redrew the row.
    LaunchedEffect(signedIn.person.id, bound, loads) {
        withContext(Dispatchers.Main.immediate) {
            loadFailed = false          // "Checking…" while it runs
            val loaded = try {
                container.scope.async { registrar.check() }.await()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                loadFailed = state == null
                return@withContext
            }
            state = loaded
            loadFailed = false
            // A phone made personal in the portal never went through the switch's ask: ask once
            // here, the first time Settings shows it registered with notifications not allowed.
            if (loaded.on && loaded.pushRegistered && needsNotificationPermission(context)) {
                askForNotifications(onlyOnce = true)
            }
        }
    }

    /** Runs the switch's call (one at a time) and shows its outcome. A build without Firebase is
     *  not an error: the plain "isn't available" line says so. */
    fun change(on: Boolean) {
        if (busy) return
        busy = true
        error = null
        // On the main thread, so the await resumes there before any state is written (see the load).
        scope.launch(Dispatchers.Main.immediate) {
            try {
                container.scope.async { if (on) registrar.turnOn() else registrar.turnOff() }.await().onSuccess { s ->
                    state = s
                    if (on && s.pushRegistered && needsNotificationPermission(context)) {
                        askForNotifications(onlyOnce = false)
                    }
                }.onFailure { e ->
                    if (e is PushSetupFailed) state = e.state
                    error = if (e is PushSetupFailed && e.cause is PushUnavailable) null else personalErrorText(e)
                }
            } finally {
                busy = false
            }
        }
    }

    SettingsRow(PERSONAL_LABEL, PERSONAL_HINT) {
        val s = state
        when {
            s == null && loadFailed -> Column(Modifier.testTag("personal-row")) {
                KioskToast(PERSONAL_LOAD_FAILED, error = true)
                // Re-runs the load: PushRegistrar.check on the app scope, behind its mutex.
                MiniButton(PERSONAL_TRY_AGAIN, onClick = { loads++ }, modifier = Modifier.padding(top = 8.dp).testTag("personal-try-again"))
            }
            s == null -> Text(PERSONAL_CHECKING, color = c.textMute, modifier = Modifier.testTag("personal-row"))
            !s.on && s.ownerName != null ->
                Text(personalOwnedBy(s.ownerName), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("personal-row"))
            else -> Column(Modifier.testTag("personal-row")) {
                Row {
                    Switch(checked = s.on, enabled = !busy, modifier = Modifier.testTag("personal-switch"), onCheckedChange = { change(it) })
                }
                val shown = error
                when {
                    shown != null -> KioskToast(shown, error = true)
                    s.on && !registrar.pushAvailable -> Text(PUSH_UNAVAILABLE_TEXT, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
                    s.on && !s.pushRegistered -> Text(PERSONAL_PUSH_NOT_SET_UP, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
                }
                if (s.on && s.pushRegistered && !allowed) {
                    Text(NOTIFICATIONS_BLOCKED_TEXT, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
                    MiniButton(OPEN_NOTIFICATION_SETTINGS, modifier = Modifier.padding(top = 8.dp), onClick = {
                        context.startActivity(
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                        )
                    })
                }
            }
        }
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
        (auth as? AuthState.Authed)?.takeIf { personalBlockVisible(it.isAdmin, container.isZebraHost) }?.let { PersonalPhoneRow(it) }
        FingerprintRow()
        SettingsRow("API URL", "Where this kiosk talks to the portal. Must start with http:// or https://.") {
            OutlinedTextField(api, { api = it; urlError = null; activity() }, singleLine = true, isError = urlError != null, modifier = Modifier.fillMaxWidth().testTag("api-url"))
            OutlinedTextField(portal, { portal = it; urlError = null; activity() }, singleLine = true, label = { Text("Portal URL") }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            KioskToast(urlError, error = true)
            Row(Modifier.padding(top = 8.dp)) {
                MiniButton("Save URLs", onClick = {
                    val a = KioskConfig.normalizeUrl(api); val p = KioskConfig.normalizeUrl(portal)
                    if (a == null || p == null) { urlError = "Enter full http:// or https:// origins." }
                    else scope.launch { container.saveCustom(a, p); saved = "URLs saved. Sign in again if the API changed." }
                })
            }
        }
        SettingsRow("Version") { Text(container.config.kioskVersion, fontFamily = FragmentMono) }
        if (container.updates.supported) AppUpdatesRow(container.updates, signedIn = auth is AuthState.Authed)
        KioskToast(saved)
    }
}
