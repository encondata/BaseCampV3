package com.serversherpa.kiosk.ui.screens.settings

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
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
import com.serversherpa.kiosk.core.rfid.RfidTriggerPersonality
import com.serversherpa.kiosk.core.rfid.ScannerPluginMode
import com.serversherpa.kiosk.core.rfid.SledBeeper
import com.serversherpa.kiosk.core.rfid.connectionLine
import com.serversherpa.kiosk.input.rfid.RfidPermissions
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.launch

/** The RFD40: whether it is on, how its trigger behaves, and how its radio is set. */
@Composable
fun RfidPanel() {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val s by container.prefs.rfid.collectAsStateWithLifecycle(initialValue = DEFAULT_RFID_SETTINGS)
    val connection by container.rfid.connection.collectAsStateWithLifecycle()
    val connectNote by container.rfid.connectNote.collectAsStateWithLifecycle()
    val applyError by container.rfid.applyError.collectAsStateWithLifecycle()
    // connection is a plain read-through of the reader's own state, and the
    // reader can never write it on a connect/disconnect the controller gave
    // up waiting on — so a vendor timeout leaves this line reading
    // "Connecting…" forever with nothing else on screen saying why.
    // connectionError is RfidController's own report of exactly that case
    // (and of a disconnect that timed out), so it is always shown as its own
    // line whenever it is set, the same way applyError already reports a
    // settings push the radio refused.
    val connectionError by container.rfid.connectionError.collectAsStateWithLifecycle()
    fun save(next: RfidSettings) { scope.launch { container.prefs.setRfid(next) } }
    var connectAttemptInFlight by remember { mutableStateOf(false) }
    var disconnectAttemptInFlight by remember { mutableStateOf(false) }

    // Snapshotted rather than read live from RfidPermissions.missing(context) on every
    // recomposition: nothing tells Compose to recompose a plain function call when the
    // operator grants the permission in Android's own Settings app and returns, so this
    // is refreshed explicitly below — once immediately by the permission launcher's
    // callback, and again on every ON_RESUME in case the operator went by Settings instead.
    var missingPermissions by remember { mutableStateOf(RfidPermissions.missing(context)) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        missingPermissions = RfidPermissions.missing(context)
    }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) missingPermissions = RfidPermissions.missing(context)
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Column {
        SettingsRow("RFID reader", "A Zebra RFD40 paired to this device over Bluetooth.") {
            Column {
                Row {
                    Switch(checked = s.enabled, onCheckedChange = { on ->
                        save(s.copy(enabled = on))
                        if (on) {
                            if (missingPermissions.isNotEmpty()) permissionLauncher.launch(RfidPermissions.REQUIRED.toTypedArray())
                        } else {
                            disconnectAttemptInFlight = true
                            scope.launch {
                                try {
                                    container.rfid.disconnectNow()
                                } finally {
                                    disconnectAttemptInFlight = false
                                }
                            }
                        }
                    })
                }
                Text(if (s.enabled) connectionLine(connection) else connectionLine(RfidConnection.Disabled), color = c.textMute)
                // Not an error — a factual note about something unusual the last
                // connect attempt handled on its own (e.g. discarding a stale
                // batch of stored tags), so it renders in the same plain tone as
                // the connection line above, never ChipTone.RED.
                connectNote?.let { Text(it, color = c.textMute) }
                // While a connect or disconnect attempt is in flight, suppress the error line
                // to avoid showing a stale error from a previous attempt. Once the attempt
                // completes, the controller's own connectionError will be repopulated if the
                // new attempt failed, or cleared if it succeeded.
                // Show the error line only when it actually adds something new: when
                // its text differs from the line already displayed above. When a connection
                // fails, both connectionLine() and connectionError carry the same reason,
                // producing a duplicate sentence. But when a connect attempt times out,
                // the reader stays in Connecting state (so connectionLine shows "Connecting…"),
                // and only connectionError carries the actual reason, so both must appear.
                if (!connectAttemptInFlight && !disconnectAttemptInFlight) {
                    connectionError?.let { error ->
                        val statusLine = if (s.enabled) connectionLine(connection) else connectionLine(RfidConnection.Disabled)
                        if (error != statusLine) {
                            Text(error, color = ChipTone.RED.text)
                        }
                    }
                }
                if (s.enabled && missingPermissions.isNotEmpty()) {
                    Text("Android needs Bluetooth and location permission before the sled can connect. Grant them in this app's settings.", color = c.textMute)
                    MiniButton("Open app settings", {
                        runCatching {
                            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            context.startActivity(intent)
                        }
                    })
                }
                // A setting the radio refused: say so rather than leaving a number
                // on screen that the reader never took.
                applyError?.let { Text("The reader refused a setting: $it", color = ChipTone.RED.text) }
                if (s.enabled) Row(Modifier.padding(top = 8.dp)) {
                    if (connection is RfidConnection.Connected) MiniButton("Disconnect", {
                        disconnectAttemptInFlight = true
                        scope.launch {
                            try {
                                container.rfid.disconnectNow()
                            } finally {
                                disconnectAttemptInFlight = false
                            }
                        }
                    })
                    else MiniButton("Connect", {
                        connectAttemptInFlight = true
                        scope.launch {
                            try {
                                container.rfid.connectNow()
                            } finally {
                                connectAttemptInFlight = false
                            }
                        }
                    })
                }
            }
        }
        // These two are about the sled's physical trigger personality — a
        // hardware-diagnostic pair, not an ordinary radio setting — so they
        // sit right after the connection row rather than among the
        // session/power/beeper settings below. Neither reaches the reader
        // live: both are excluded from RfidController's settings push (see
        // its settings collector) and are only read at connect time (see
        // ZebraRfidReader.configureTriggerMode), which is why their hints —
        // not this row — say so, rather than the rows pretending to apply
        // immediately the way the Switch-backed rows below actually do.
        SettingsRow("Trigger drives", s.triggerPersonality.hint) {
            Segmented(RfidTriggerPersonality.entries.map { it.wire to it.label }, s.triggerPersonality.wire) { w ->
                RfidTriggerPersonality.fromWire(w)?.let { save(s.copy(triggerPersonality = it)) }
            }
        }
        SettingsRow("Scanner plugin on connect", s.scannerPluginMode.hint) {
            Segmented(ScannerPluginMode.entries.map { it.wire to it.label }, s.scannerPluginMode.wire) { w ->
                ScannerPluginMode.fromWire(w)?.let { save(s.copy(scannerPluginMode = it)) }
            }
        }
        SettingsRow("Trigger", s.triggerMode.hint) {
            Segmented(RfidTriggerMode.entries.map { it.wire to it.label }, s.triggerMode.wire) { w ->
                RfidTriggerMode.fromWire(w)?.let { save(s.copy(triggerMode = it)) }
            }
        }
        SettingsRow("Repeat sweeps", s.repeatPolicy.hint) {
            Segmented(RepeatSweepPolicy.entries.map { it.wire to it.label }, s.repeatPolicy.wire) { w ->
                RepeatSweepPolicy.fromWire(w)?.let { save(s.copy(repeatPolicy = it)) }
            }
        }
        SettingsRow("Sled beeper", "The reader's own beep on each tag. Off is its quiet setting.") {
            Segmented(SledBeeper.entries.map { it.wire to it.label }, s.beeper.wire) { w ->
                SledBeeper.fromWire(w)?.let { save(s.copy(beeper = it)) }
            }
        }
        SettingsRow("Transmit power", "How far the reader reaches. Lower it if a sweep is picking up the next rack.") {
            // Dragging a Slider fires onValueChange dozens of times a second.
            // Writing every tick straight to save() would hammer the
            // DataStore file with writes the operator never asked for, and
            // RfidController pushes every settings change straight to the
            // radio over Bluetooth while connected — so mid-drag the reader
            // would get a flood of settings pushes, not the one value the
            // operator actually settled on. So the drag only moves local
            // state; the DataStore write (and the resulting push to the
            // reader) happens once, in onValueChangeFinished, when the
            // operator lets go.
            var draft by remember(s.powerDbm) { mutableFloatStateOf(s.powerDbm.toFloat()) }
            Column {
                Text("${draft.toInt()} dBm", fontFamily = FragmentMono)
                Slider(
                    value = draft,
                    onValueChange = { draft = it },
                    onValueChangeFinished = { save(s.copy(powerDbm = draft.toInt())) },
                    valueRange = RFID_POWER_MIN.toFloat()..RFID_POWER_MAX.toFloat(),
                    steps = RFID_POWER_MAX - RFID_POWER_MIN - 1,
                )
            }
        }
        SettingsRow("Session", "Higher sessions keep a tag quiet longer after it answers.") {
            Segmented(RfidSession.entries.map { it.wire to it.label }, s.session.wire) { w ->
                RfidSession.fromWire(w)?.let { save(s.copy(session = it)) }
            }
        }
        SettingsRow("Tag population", "Roughly how many tags are in front of the reader at once.") {
            // Same reasoning as transmit power above: local state while dragging,
            // one write and one radio push on release.
            var draft by remember(s.tagPopulation) { mutableFloatStateOf(s.tagPopulation.toFloat()) }
            Column {
                Text("${draft.toInt()}", fontFamily = FragmentMono)
                Slider(
                    value = draft,
                    onValueChange = { draft = it },
                    onValueChangeFinished = { save(s.copy(tagPopulation = draft.toInt())) },
                    valueRange = RFID_POPULATION_MIN.toFloat()..RFID_POPULATION_MAX.toFloat(),
                )
            }
        }
        SettingsRow("Report each tag once", "The reader reports a tag once per sweep instead of repeatedly.") {
            Switch(checked = s.uniqueTagReport, onCheckedChange = { save(s.copy(uniqueTagReport = it)) })
        }
        SettingsRow("Blink on read", "The sled's light blinks when it reads a tag.") {
            Switch(checked = s.ledOnRead, onCheckedChange = { save(s.copy(ledOnRead = it)) })
        }
        SettingsRow("Dynamic power optimization", "Saves battery during a long sweep.") {
            Switch(checked = s.dpo, onCheckedChange = { save(s.copy(dpo = it)) })
        }
        SettingsRow("Region", "A compliance setting. It's set on the Admin tab, not here.") {
            Text(s.region?.let { "The active region is $it." } ?: "The reader's own setting applies.", color = c.textMute)
        }
        MiniButton("Restore defaults", { save(DEFAULT_RFID_SETTINGS.copy(enabled = s.enabled)) })
    }
}
