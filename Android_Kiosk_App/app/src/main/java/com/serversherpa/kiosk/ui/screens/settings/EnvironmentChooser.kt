package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.environment.CUSTOM_LABEL
import com.serversherpa.kiosk.core.environment.Env
import com.serversherpa.kiosk.core.environment.Environments
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.core.environment.apiUrl
import com.serversherpa.kiosk.core.environment.asSaved
import com.serversherpa.kiosk.core.environment.isProd
import com.serversherpa.kiosk.core.environment.label
import com.serversherpa.kiosk.core.environment.portalUrl
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.environment.OutboxUnreadable
import com.serversherpa.kiosk.data.environment.SwitchResult
import com.serversherpa.kiosk.ui.components.CloseIcon
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.ButtonTint
import com.serversherpa.kiosk.ui.components.TintedButton
import com.serversherpa.kiosk.ui.guards.LocalStationActivity
import com.serversherpa.kiosk.ui.onEveryTouchDown
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

const val WRONG_ENVIRONMENT_PASSWORD = "That password isn't right."
const val CUSTOM_NEEDS_SUPER_ADMIN_TEXT = "Sign in as a developer, founder or super admin to use a custom URL."
const val DISCARD_NEEDS_ADMIN_TEXT = "Sign in as an admin to discard unsent scans."
const val ACCESS_CHECK_OFFLINE_TEXT = "Can't reach the server to check your access."
const val BAD_CUSTOM_URL_TEXT = "Enter an http or https address for both URLs."
const val OUTBOX_UNREADABLE_TEXT = "Couldn't read this kiosk's unsent scans, so nothing was switched. Try again."
const val SWITCH_FAILED_TEXT = "Couldn't switch environment. Try again."

/** "Switching to {name} …": what every switch clears. */
fun switchConfirmText(name: String) = "Switching to $name signs this kiosk out and clears its setup and saved move data."

/** How many scans a switch would leave unsent (never "0"). */
fun unsentScansText(n: Int): String = when {
    n == 1 -> "1 unsent scan hasn't been sent yet."
    n > 1 -> "$n unsent scans haven't been sent yet."
    else -> "Unsent scans haven't been sent yet."
}

/** What a gate's refusal says. */
fun switchRefusalText(code: String): String = when (code) {
    SwitchResult.CUSTOM_NEEDS_SUPER_ADMIN -> CUSTOM_NEEDS_SUPER_ADMIN_TEXT
    SwitchResult.DISCARD_NEEDS_ADMIN -> DISCARD_NEEDS_ADMIN_TEXT
    SwitchResult.ACCESS_CHECK_OFFLINE -> ACCESS_CHECK_OFFLINE_TEXT
    else -> "Couldn't switch environment ($code)."
}

/** The Server row: a named environment's API host, or a Custom environment's whole API URL. */
fun serverLabel(env: SavedEnvironment): String = when (env) {
    is SavedEnvironment.Named -> "api.${env.domain}"
    is SavedEnvironment.Custom -> env.apiUrl
}

/** A switch: the environment switcher's, or a test's. */
typealias SwitchEnvironment = suspend (target: SavedEnvironment, discard: Boolean) -> SwitchResult

/**
 * Settings › This Kiosk's Environment and Server rows: which environment this kiosk connects to
 * (`Custom` for typed URLs) and its server, with Change… opening [EnvironmentChooser].
 * [onSwitched] runs after a switch (the kiosk is signed out and cleared: on to sign-in).
 */
@Composable
fun EnvironmentRow(onSwitched: () -> Unit = {}, switchTo: SwitchEnvironment? = null) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val current by container.config.environment.collectAsStateWithLifecycle(initialValue = null)
    var choosing by remember { mutableStateOf(false) }
    val env = current
    SettingsRow("Environment") {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(env?.label ?: "", style = MaterialTheme.typography.bodyLarge, color = c.textDark, modifier = Modifier.weight(1f).testTag("env-name"))
            MiniButton("Change…", onClick = { choosing = true }, enabled = env != null, modifier = Modifier.padding(start = 8.dp).testTag("env-change"))
        }
    }
    SettingsRow("Server") { Text(env?.let(::serverLabel) ?: "", fontFamily = FragmentMono, modifier = Modifier.testTag("env-server")) }
    if (choosing && env != null) {
        EnvironmentChooser(
            current = env,
            onDismiss = { choosing = false },
            onSwitched = { choosing = false; onSwitched() },
            switchTo = switchTo ?: { target, discard -> container.environmentSwitcher.switchTo(target, discard) },
        )
    }
}

private enum class ChooserStep { PASSWORD, LIST, CUSTOM, CONFIRM }

/**
 * The environment chooser (the laptop's EnvironmentModal): the environment password, then the
 * list (the current one marked by its id and domain, Custom URL… last), then the API and portal
 * URLs for Custom, or a confirm that says what a switch clears. Unsent scans come back as a
 * count: wait for them (closes) or discard them (an admin must be signed in). Cancel on the
 * confirm or the URLs goes back to the list.
 *
 * The list opens with the last good download (or the built-in list) and is replaced in place
 * when a fresh download lands. A switch away from a dead server can take a while: it runs on the
 * app's scope, and until it answers every button waits and the chooser can't be closed. A throw
 * (an unreadable outbox, storage) is shown here and leaves the chooser open.
 *
 * Signed out on a Time Clock station the page returns to Welcome when idle, and it sees nothing
 * of this window: typing and taps here count as activity, and so does a switch in progress.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EnvironmentChooser(
    current: SavedEnvironment,
    onDismiss: () -> Unit,
    onSwitched: () -> Unit,
    switchTo: SwitchEnvironment,
) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val scope = rememberCoroutineScope()
    val activity = LocalStationActivity.current
    var step by remember { mutableStateOf(ChooserStep.PASSWORD) }
    var password by remember { mutableStateOf("") }
    var list by remember { mutableStateOf<List<Env>?>(null) }
    var chosen by remember { mutableStateOf<Env?>(null) }
    var customApi by remember { mutableStateOf(current.apiUrl) }
    var customPortal by remember { mutableStateOf(current.portalUrl) }
    var pending by remember { mutableStateOf<Int?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Asked while the password is typed. Every await resumes on the main thread before a write.
    LaunchedEffect(Unit) {
        withContext(Dispatchers.Main.immediate) {
            val saved = try { container.environments.cachedList() } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
            list = saved ?: Environments.BUILT_IN
            list = container.environmentList.current().first
        }
    }
    LaunchedEffect(busy) {
        while (busy) { activity(); delay(15_000) }
    }

    fun go(next: ChooserStep) {
        step = next
        pending = null
        error = null
    }

    fun unlock() {
        if (password.isEmpty()) return
        if (password == Environments.PASSWORD) go(ChooserStep.LIST) else error = WRONG_ENVIRONMENT_PASSWORD
    }

    fun isCurrent(env: Env) = current is SavedEnvironment.Named && current.id == env.id && current.domain == env.domain

    fun runSwitch(discard: Boolean) {
        if (busy) return
        val target: SavedEnvironment = if (step == ChooserStep.CUSTOM) {
            val api = KioskConfig.normalizeUrl(customApi)
            val portal = KioskConfig.normalizeUrl(customPortal)
            if (api == null || portal == null) { error = BAD_CUSTOM_URL_TEXT; return }
            SavedEnvironment.Custom(api, portal)
        } else {
            chosen?.asSaved() ?: return
        }
        busy = true
        error = null
        // On the main thread, so the await resumes there before any state is written.
        scope.launch(Dispatchers.Main.immediate) {
            val outcome = try {
                container.scope.async { switchTo(target, discard) }.await()
            } catch (e: CancellationException) {
                throw e
            } catch (e: OutboxUnreadable) {
                busy = false; error = OUTBOX_UNREADABLE_TEXT; return@launch
            } catch (e: Exception) {
                busy = false; error = SWITCH_FAILED_TEXT; return@launch
            }
            busy = false
            when (outcome) {
                SwitchResult.Done -> onSwitched()
                is SwitchResult.Pending -> pending = outcome.count
                is SwitchResult.Refused -> error = switchRefusalText(outcome.code)
            }
        }
    }

    Dialog(onDismissRequest = { if (!busy) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.widthIn(max = 480.dp).fillMaxWidth().padding(16.dp).onEveryTouchDown { activity() }
                .background(c.paper, RoundedCornerShape(16.dp)).padding(16.dp).testTag("env-chooser"),
        ) {
            // ── header: eyebrow, title, close ──
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text("This kiosk".uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textMute)
                    Text("Change environment", style = MaterialTheme.typography.headlineSmall, color = c.textDark, modifier = Modifier.padding(top = 4.dp))
                }
                IconButton(onClick = onDismiss, enabled = !busy, modifier = Modifier.size(48.dp).testTag("env-close")) {
                    Icon(CloseIcon, contentDescription = "Close", tint = c.textMute, modifier = Modifier.size(20.dp))
                }
            }

            // ── body: the only part that scrolls ──
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(top = 12.dp)) {
                when (step) {
                    ChooserStep.PASSWORD -> OutlinedTextField(
                        password, { password = it; error = null; activity() }, singleLine = true,
                        label = { Text("Environment password") }, isError = error != null, readOnly = busy,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { unlock() }),
                        modifier = Modifier.fillMaxWidth().testTag("env-password"),
                    )
                    ChooserStep.LIST -> {
                        if (list == null) Text("Loading environments…", style = MaterialTheme.typography.bodyMedium, color = c.textMute)
                        for (env in list.orEmpty()) {
                            ChoiceRow(env.name, here = isCurrent(env), enabled = !isCurrent(env), tag = "env-row-${env.id}") {
                                chosen = env
                                go(ChooserStep.CONFIRM)
                            }
                        }
                        // Picked again when current, to change its URLs.
                        ChoiceRow("Custom URL…", here = current is SavedEnvironment.Custom, enabled = true, tag = "env-custom") { go(ChooserStep.CUSTOM) }
                    }
                    ChooserStep.CUSTOM -> {
                        val locked = busy || pending != null
                        UrlField("API URL", customApi, readOnly = locked, tag = "env-api-url") { customApi = it; error = null; activity() }
                        UrlField("Portal URL", customPortal, readOnly = locked, tag = "env-portal-url", modifier = Modifier.padding(top = 8.dp)) {
                            customPortal = it; error = null; activity()
                        }
                        ConfirmText(CUSTOM_LABEL)
                    }
                    ChooserStep.CONFIRM -> ConfirmText(chosen?.name.orEmpty())
                }
                pending?.let { KioskToast(unsentScansText(it), error = true) }
                KioskToast(error, error = true)
            }

            // ── footer: always on screen ──
            FlowRow(
                Modifier.fillMaxWidth().padding(top = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                when {
                    step == ChooserStep.PASSWORD -> {
                        MiniButton("Cancel", onClick = onDismiss, modifier = Modifier.testTag("env-password-cancel"))
                        SolidButton("Continue", { unlock() }, enabled = password.isNotEmpty(), modifier = Modifier.testTag("env-continue"))
                    }
                    step == ChooserStep.LIST -> MiniButton("Cancel", onClick = onDismiss, modifier = Modifier.testTag("env-list-cancel"))
                    pending == null -> {
                        val ready = step != ChooserStep.CUSTOM || (customApi.isNotBlank() && customPortal.isNotBlank())
                        MiniButton("Cancel", onClick = { go(ChooserStep.LIST) }, enabled = !busy, modifier = Modifier.testTag("env-cancel"))
                        TintedButton(
                            if (busy) "Switching…" else "Switch", { runSwitch(discard = false) }, ButtonTint.RED,
                            enabled = !busy && ready, modifier = Modifier.testTag("env-confirm"),
                        )
                    }
                    else -> {
                        MiniButton("Wait for them to send", onClick = onDismiss, enabled = !busy, modifier = Modifier.testTag("env-wait"))
                        TintedButton(
                            if (busy) "Switching…" else "Discard and switch", { runSwitch(discard = true) }, ButtonTint.RED,
                            enabled = !busy, modifier = Modifier.testTag("env-discard"),
                        )
                    }
                }
            }
        }
    }
}

/** One environment in the list: its name, and "Current" on the one this kiosk is on. */
@Composable
private fun ChoiceRow(name: String, here: Boolean, enabled: Boolean, tag: String, onClick: () -> Unit) {
    val c = LocalKioskColors.current
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable(enabled = enabled, onClick = onClick)
            .heightIn(min = 48.dp).padding(horizontal = 12.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(name, style = MaterialTheme.typography.bodyLarge, color = c.textDark, modifier = Modifier.weight(1f))
        if (here) KioskChip("Current", ChipTone.SLATE, dot = false)
    }
}

@Composable
private fun UrlField(label: String, value: String, readOnly: Boolean, tag: String, modifier: Modifier = Modifier, onChange: (String) -> Unit) {
    OutlinedTextField(
        value, onChange, singleLine = true, readOnly = readOnly, label = { Text(label) },
        textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FragmentMono),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
        modifier = modifier.fillMaxWidth().testTag(tag),
    )
}

@Composable
private fun ConfirmText(name: String) {
    Text(
        switchConfirmText(name), style = MaterialTheme.typography.bodyMedium, color = LocalKioskColors.current.textDark,
        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
    )
}

/**
 * The non-Prod badge: the environment's name (`Custom` for typed URLs) in an amber chip, on the
 * shell's top bar and the sign-in page (beside the kiosk's name). Nothing on Prod. On the top bar
 * ([compact]) it is the Net test chip's size, so the bar is never taller for it.
 */
@Composable
fun EnvironmentBadge(modifier: Modifier = Modifier, compact: Boolean = false) {
    val env by LocalAppContainer.current.config.environment.collectAsStateWithLifecycle(initialValue = null)
    val e = env ?: return
    if (e.isProd) return
    if (compact) {
        val shape = RoundedCornerShape(999.dp)
        val tone = ChipTone.AMBER
        Text(
            e.label, style = MaterialTheme.typography.labelSmall, color = tone.text, maxLines = 1,
            modifier = modifier.testTag("env-badge").background(tone.bg, shape).border(1.dp, tone.border, shape)
                .padding(horizontal = 6.dp, vertical = 2.dp),
        )
    } else {
        Box(modifier.testTag("env-badge")) { KioskChip(e.label, ChipTone.AMBER) }
    }
}
