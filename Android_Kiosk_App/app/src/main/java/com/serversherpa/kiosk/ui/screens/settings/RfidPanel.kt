package com.serversherpa.kiosk.ui.screens.settings

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RFID_POPULATION_MAX
import com.serversherpa.kiosk.core.rfid.RFID_POPULATION_MIN
import com.serversherpa.kiosk.core.rfid.RFID_POWER_MAX
import com.serversherpa.kiosk.core.rfid.RFID_POWER_MIN
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSession
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.SledBeeper
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledScannerFault
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.effectiveLayout
import com.serversherpa.kiosk.core.rfid.sledLine
import com.serversherpa.kiosk.input.rfid.RfidPermissions
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.screens.scan.SledFixButton
import com.serversherpa.kiosk.ui.screens.scan.SledTriggersControl
import com.serversherpa.kiosk.ui.screens.scan.openAppSettings
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.launch

/**
 * The sled: whether it is on and connected, which paired sled it is, what its
 * triggers do, and how its radio is set (spec, Screens: RFID tab). Every
 * write goes through `updateRfid` (ruling 31), so two changes landing
 * together never overwrite each other.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RfidPanel() {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val rfid = container.rfid
    val s by container.prefs.rfid.collectAsStateWithLifecycle(initialValue = DEFAULT_RFID_SETTINGS)
    val connection by rfid.connection.collectAsStateWithLifecycle()
    val connectNote by rfid.connectNote.collectAsStateWithLifecycle()
    val applyError by rfid.applyError.collectAsStateWithLifecycle()
    val reconnecting by rfid.reconnecting.collectAsStateWithLifecycle()
    val retry by rfid.retry.collectAsStateWithLifecycle()
    val info by rfid.info.collectAsStateWithLifecycle()
    val scanner by rfid.scanner.collectAsStateWithLifecycle()
    val requestedLayout by rfid.requestedLayout.collectAsStateWithLifecycle()
    val layoutError by rfid.layoutError.collectAsStateWithLifecycle()
    val usesScanner by rfid.layoutInForceUsesScanner.collectAsStateWithLifecycle()
    // connection is a plain read-through of the reader's own state, and the
    // reader can never write it on a connect/disconnect the controller gave
    // up waiting on — so a connect timeout leaves this line reading
    // "Connecting…" with nothing else on screen saying why.
    // connectionError is RfidController's own report of exactly that case
    // (and of a disconnect that timed out), so it is shown as its own line
    // whenever it says something the sled line does not.
    val connectionError by rfid.connectionError.collectAsStateWithLifecycle()
    fun save(transform: (RfidSettings) -> RfidSettings) { scope.launch { container.prefs.updateRfid(transform) } }
    var connectAttemptInFlight by remember { mutableStateOf(false) }
    var disconnectAttemptInFlight by remember { mutableStateOf(false) }

    // connectNow() runs on the controller's scope; leaving the tab only stops the waiting.
    fun connect() {
        connectAttemptInFlight = true
        scope.launch {
            try {
                rfid.connectNow()
            } finally {
                connectAttemptInFlight = false
            }
        }
    }

    // Snapshotted rather than read live from RfidPermissions.missing(context) on every
    // recomposition: nothing tells Compose to recompose a plain function call when the
    // operator grants the permission in Android's own Settings app and returns, so this
    // is refreshed explicitly below — once immediately by the permission launcher's
    // callback, and again on every ON_RESUME in case the operator went by Settings instead.
    var missingPermissions by remember { mutableStateOf(RfidPermissions.missing(context)) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        missingPermissions = RfidPermissions.missing(context)
        afterPermissionPrompt(missingPermissions, ::connect)
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) missingPermissions = RfidPermissions.missing(context)
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    // A plain call into the reader: read again when the link or the permissions change.
    val paired = remember(connection, missingPermissions) { container.rfidReader.pairedSleds() }

    val line = sledLine(connection, reconnecting, s.enabled, missingPermissions.isNotEmpty(), retry)

    Column {
        SettingsRow("RFID reader", "${SledWords.READER_HINT} ${SledWords.DISPLAY_HINT} ${SledWords.RECONNECT_HINT}") {
            Column {
                // First, with nothing toggleable above it. It only writes the setting: the
                // controller connects and disconnects on its edges.
                Row {
                    Switch(checked = s.enabled, onCheckedChange = { on ->
                        save { it.copy(enabled = on) }
                        if (on && missingPermissions.isNotEmpty()) permissionLauncher.launch(RfidPermissions.REQUESTED.toTypedArray())
                    })
                }
                Text(line.text, color = c.textMute)
                // Not an error — a factual note about something unusual the last
                // connect handled on its own (e.g. discarding a stale batch of
                // stored tags), so it renders in the same plain tone as the line
                // above, never ChipTone.RED. Only while connected: the note is set
                // on the connect that succeeded, so that is when it is seen.
                if (connection is RfidConnection.Connected) connectNote?.let { Text(it, color = c.textMute) }
                // While a connect or disconnect attempt is in flight, suppress the error line
                // to avoid showing a stale error from a previous attempt. Once the attempt
                // completes, the controller's own connectionError will be repopulated if the
                // new attempt failed, or cleared if it succeeded. Shown only when it adds
                // something: a failed connect's reason is already the sled line, but a
                // connect wait that ran out leaves the line at "Connecting…".
                if (!connectAttemptInFlight && !disconnectAttemptInFlight) {
                    connectionError?.let { error ->
                        if (error != line.text) Text(error, color = ChipTone.RED.text)
                    }
                }
                // The button that fixes a failure. Connect is already below, and the
                // chooser below is the fix for "choose a sled".
                val failed = connection as? RfidConnection.Failed
                val fix = failed?.fix?.takeIf { line.text == failed.reason && it != SledFix.CONNECT && it != SledFix.CHOOSE_SLED }
                if (s.enabled && fix != null) {
                    FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SledFixButton(fix, onConnect = ::connect)
                    }
                }
                if (s.enabled && missingPermissions.isNotEmpty()) {
                    if (line.text != SledWords.PERMISSION_MISSING) Text(SledWords.PERMISSION_MISSING, color = c.textMute)
                    MiniButton(SledWords.OPEN_APP_SETTINGS, { openAppSettings(context) })
                }
                // A setting the radio refused: its own sentence, complete as it is.
                applyError?.let { Text(it, color = ChipTone.RED.text) }
                if (s.enabled) Row(Modifier.padding(top = 8.dp)) {
                    when {
                        reconnecting -> MiniButton(SledWords.STOP, { rfid.stopReconnecting() })
                        connection is RfidConnection.Connected || connection is RfidConnection.NeedsRegion ->
                            MiniButton(SledWords.DISCONNECT, {
                                disconnectAttemptInFlight = true
                                scope.launch {
                                    try {
                                        rfid.disconnectNow()
                                    } finally {
                                        disconnectAttemptInFlight = false
                                    }
                                }
                            })
                        else -> MiniButton(
                            SledWords.CONNECT,
                            {
                                // Connect needs only Nearby devices (ruling 22); without it,
                                // Android's prompt, whose answer connects.
                                if (RfidPermissions.nearbyGranted(context)) connect()
                                else permissionLauncher.launch(RfidPermissions.REQUESTED.toTypedArray())
                            },
                            enabled = connection != RfidConnection.Connecting && !connectAttemptInFlight,
                        )
                    }
                }
                // Two or more sleds paired: one per line, the saved one selected.
                if (paired.size >= 2) {
                    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (sled in paired) {
                            val chosen = sled.address.equals(s.readerAddress, ignoreCase = true)
                            SetupCard(
                                selected = chosen,
                                onClick = { save { it.copy(readerAddress = sled.address) } },
                                modifier = Modifier.semantics { selected = chosen },
                            ) {
                                Text(sled.name, style = MaterialTheme.typography.titleMedium, color = c.textDark)
                                Text(sled.address, fontFamily = FragmentMono, style = MaterialTheme.typography.bodySmall, color = c.textMute)
                            }
                        }
                    }
                }
            }
        }
        SettingsRow("Trigger", s.triggerMode.hint) {
            Segmented(RfidTriggerMode.entries.map { it.wire to it.label }, s.triggerMode.wire) { w ->
                RfidTriggerMode.fromWire(w)?.let { mode -> save { it.copy(triggerMode = mode) } }
            }
        }
        SettingsRow(SledWords.SLED_TRIGGERS, s.triggerLayout.hint) {
            Column {
                SledTriggersControl(caption = false)
                when {
                    container.isZebraHost -> Text(SledWords.ZEBRA_HOST, color = c.textMute)
                    info?.hasScanner == false -> Text(SledWords.NO_SCANNER, color = c.textMute)
                }
                // Only when needed: the sled reports a layout other than the one asked of it.
                val readback = info?.trigger
                val asked = effectiveLayout(requestedLayout ?: s.triggerLayout, container.isZebraHost, info?.hasScanner)
                if (readback != null && readback.layout != asked) Text(SledWords.didNotTake(readback), color = ChipTone.RED.text)
                layoutError?.let { Text(it, color = ChipTone.RED.text) }
                // The sled's own barcode scanner, while the layout in force uses it.
                if (usesScanner && !container.isZebraHost) {
                    when (val state = scanner) {
                        SledScannerState.Opening -> Text(SledWords.SCANNER_STARTING, color = c.textMute)
                        SledScannerState.Ready -> Text(SledWords.SCANNER_READY, color = c.textMute)
                        is SledScannerState.Unavailable -> when (state.kind) {
                            SledScannerFault.DID_NOT_START -> {
                                Text(SledWords.SCANNER_DID_NOT_START, color = ChipTone.RED.text)
                                MiniButton(SledWords.TRY_AGAIN, { scope.launch { rfid.retryScanner() } })
                            }
                            SledScannerFault.STOPPED_RESPONDING -> Text(SledWords.SCANNER_STOPPED_RESPONDING, color = ChipTone.RED.text)
                            SledScannerFault.BLUETOOTH_OFF -> Unit
                        }
                        SledScannerState.Off -> Unit
                    }
                }
            }
        }
        SettingsRow("Repeat sweeps", s.repeatPolicy.hint) {
            Segmented(RepeatSweepPolicy.entries.map { it.wire to it.label }, s.repeatPolicy.wire) { w ->
                RepeatSweepPolicy.fromWire(w)?.let { policy -> save { it.copy(repeatPolicy = policy) } }
            }
        }
        SettingsRow(SledWords.ROW_SLED_BEEPER, "The reader's own beep on each tag. Off is its quiet setting.") {
            Segmented(SledBeeper.entries.map { it.wire to it.label }, s.beeper.wire) { w ->
                SledBeeper.fromWire(w)?.let { beeper -> save { it.copy(beeper = beeper) } }
            }
        }
        SettingsRow(SledWords.ROW_TRANSMIT_POWER, "How far the reader reaches. Lower it if a sweep is picking up the next rack.") {
            // Dragging a Slider fires onValueChange dozens of times a second.
            // Writing every tick straight to the DataStore would hammer the
            // file with writes the operator never asked for, and
            // RfidController pushes every settings change straight to the
            // radio over Bluetooth while connected — so mid-drag the reader
            // would get a flood of settings pushes, not the one value the
            // operator actually settled on. So the drag only moves local
            // state; the DataStore write (and the resulting push to the
            // reader) happens once, in onValueChangeFinished, when the
            // operator lets go.
            //
            // Capped at the sled's own top when it has said what that is.
            val sledMax = info?.powerMaxDbm
            val top = sledMax?.coerceIn(RFID_POWER_MIN + 1, RFID_POWER_MAX) ?: RFID_POWER_MAX
            var draft by remember(s.powerDbm) { mutableFloatStateOf(s.powerDbm.toFloat()) }
            Column {
                Text("${draft.toInt()} dBm", fontFamily = FragmentMono)
                Slider(
                    value = draft.coerceIn(RFID_POWER_MIN.toFloat(), top.toFloat()),
                    onValueChange = { draft = it },
                    onValueChangeFinished = { val dbm = draft.toInt(); save { it.copy(powerDbm = dbm) } },
                    valueRange = RFID_POWER_MIN.toFloat()..top.toFloat(),
                    steps = top - RFID_POWER_MIN - 1,
                )
                if (sledMax != null && s.powerDbm > sledMax) Text(SledWords.powerCap(sledMax), color = c.textMute)
            }
        }
        SettingsRow(SledWords.ROW_SESSION, "Higher sessions keep a tag quiet longer after it answers.") {
            Segmented(RfidSession.entries.map { it.wire to it.label }, s.session.wire) { w ->
                RfidSession.fromWire(w)?.let { session -> save { it.copy(session = session) } }
            }
        }
        SettingsRow(SledWords.ROW_TAG_POPULATION, "Roughly how many tags are in front of the reader at once.") {
            // Same reasoning as transmit power above: local state while dragging,
            // one write and one radio push on release.
            var draft by remember(s.tagPopulation) { mutableFloatStateOf(s.tagPopulation.toFloat()) }
            Column {
                Text("${draft.toInt()}", fontFamily = FragmentMono)
                Slider(
                    value = draft,
                    onValueChange = { draft = it },
                    onValueChangeFinished = { val n = draft.toInt(); save { it.copy(tagPopulation = n) } },
                    valueRange = RFID_POPULATION_MIN.toFloat()..RFID_POPULATION_MAX.toFloat(),
                )
            }
        }
        SettingsRow(SledWords.ROW_UNIQUE, "The reader reports a tag once per sweep instead of repeatedly.") {
            Switch(checked = s.uniqueTagReport, onCheckedChange = { on -> save { it.copy(uniqueTagReport = on) } })
        }
        SettingsRow(SledWords.ROW_DPO, "Saves battery during a long sweep.") {
            Switch(checked = s.dpo, onCheckedChange = { on -> save { it.copy(dpo = on) } })
        }
        SettingsRow("Region", "A compliance setting. It's set on the Admin tab, not here.") {
            Text(s.region?.let { "The active region is $it." } ?: "The reader's own setting applies.", color = c.textMute)
        }
        // The setting, the sled's region and which sled it is are not radio defaults.
        MiniButton("Restore defaults", {
            save { DEFAULT_RFID_SETTINGS.copy(enabled = it.enabled, region = it.region, readerAddress = it.readerAddress) }
        })
    }
}

/** The permission prompt's answer: connect once nothing in `RfidPermissions.REQUIRED` is missing ([missingNow]). */
internal fun afterPermissionPrompt(missingNow: List<String>, connectNow: () -> Unit) {
    if (missingNow.isEmpty()) connectNow()
}
