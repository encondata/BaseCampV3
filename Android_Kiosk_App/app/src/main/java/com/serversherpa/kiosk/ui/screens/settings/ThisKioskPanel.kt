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
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
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

const val PERSONAL_LABEL = "This is my phone"
const val PERSONAL_HINT = "Marks this phone as yours: your notifications come here, and biometric sign-in can be turned on."
const val PERSONAL_CHECKING = "Checking…"
const val PERSONAL_PUSH_NOT_SET_UP = "Push isn't set up on this phone yet."
const val PERSONAL_SET_UP_PUSH = "Set up push"
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
    cause is ApiError && cause.isNetwork -> "This phone is yours, but push couldn't be set up: the portal couldn't be reached."
    cause is ApiError && cause.status == 423 -> "This phone is yours, but push couldn't be set up: the portal is read-only right now."
    else -> "This phone is yours, but push couldn't be set up."
}

private fun notificationsAllowed(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

private fun needsNotificationPermission(context: Context): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

/**
 * "This is my phone" (admins only, never on a Zebra): the server's state on each open, so a portal
 * reassignment shows. Someone else's phone shows its owner and no switch. Turning it on claims the
 * phone and registers it for push, then (Android 13+) asks for POST_NOTIFICATIONS; refused, the
 * switch stays on (biometric sign-in still works) and a line says notifications are blocked, with
 * a button to the app's notification settings. A phone that is on without push offers Set up push,
 * so push can be retried without turning the switch off (which revokes biometric sign-in).
 */
@Composable
private fun PersonalPhoneRow(signedIn: AuthState.Authed) {
    val container = LocalAppContainer.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val c = LocalKioskColors.current
    var state by remember { mutableStateOf<PersonalState?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var pushUnavailable by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var allowed by remember { mutableStateOf(notificationsAllowed(context)) }
    var loads by remember { mutableStateOf(0) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = notificationsAllowed(context) }
    // Back from the notification settings: Android sends nothing when they change.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { allowed = notificationsAllowed(context) }
    LaunchedEffect(signedIn.person.id, loads) {
        loadError = null
        try {
            state = container.pushRegistrar.state()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            loadError = personalErrorText(e)
        }
    }

    /** Runs one switch or Set up push [call] (one at a time) and shows its outcome. A build without
     *  Firebase is not an error: the plain "isn't available" line says so. */
    fun run(call: suspend () -> Result<PersonalState>, askForNotifications: Boolean) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                call().onSuccess { s ->
                    state = s
                    pushUnavailable = false
                    if (askForNotifications && s.on && needsNotificationPermission(context)) {
                        permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                }.onFailure { e ->
                    val unavailable = e is PushSetupFailed && e.cause is PushUnavailable
                    if (e is PushSetupFailed) {
                        state = e.state
                        pushUnavailable = unavailable
                    }
                    error = if (unavailable) null else personalErrorText(e)
                }
            } finally {
                busy = false
            }
        }
    }

    SettingsRow(PERSONAL_LABEL, PERSONAL_HINT) {
        val s = state
        val failedToLoad = loadError
        when {
            s == null && failedToLoad != null -> Column(Modifier.testTag("personal-row")) {
                Text(failedToLoad, color = ChipTone.RED.text)
                MiniButton(PERSONAL_TRY_AGAIN, onClick = { loads++ }, modifier = Modifier.padding(top = 8.dp))
            }
            s == null -> Text(PERSONAL_CHECKING, color = c.textMute, modifier = Modifier.testTag("personal-row"))
            !s.on && s.ownerName != null ->
                Text(personalOwnedBy(s.ownerName), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("personal-row"))
            else -> Column(Modifier.testTag("personal-row")) {
                Row {
                    Switch(
                        checked = s.on, enabled = !busy, modifier = Modifier.testTag("personal-switch"),
                        onCheckedChange = { on ->
                            run({ if (on) container.pushRegistrar.turnOn() else container.pushRegistrar.turnOff() }, askForNotifications = on)
                        },
                    )
                }
                val shown = error
                when {
                    shown != null -> Text(shown, color = ChipTone.RED.text, modifier = Modifier.padding(top = 4.dp))
                    s.on && !s.pushRegistered ->
                        Text(if (pushUnavailable) PUSH_UNAVAILABLE_TEXT else PERSONAL_PUSH_NOT_SET_UP, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
                }
                if (s.on && !s.pushRegistered && !pushUnavailable) {
                    MiniButton(PERSONAL_SET_UP_PUSH, enabled = !busy, modifier = Modifier.padding(top = 8.dp), onClick = {
                        run({ container.pushRegistrar.registerPush(s) }, askForNotifications = true)
                    })
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
                    else scope.launch { container.saveApiUrl(a); container.prefs.setPortalUrl(p); saved = "URLs saved. Sign in again if the API changed." }
                })
            }
        }
        SettingsRow("Version") { Text(container.config.kioskVersion, fontFamily = FragmentMono) }
        KioskToast(saved)
    }
}
