package com.serversherpa.kiosk.ui.screens.scan

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.SledFix
import com.serversherpa.kiosk.core.rfid.SledScannerFault
import com.serversherpa.kiosk.core.rfid.SledScannerState
import com.serversherpa.kiosk.core.rfid.SledTriggerLayout
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.scanSlotLine
import com.serversherpa.kiosk.core.rfid.sledLine
import com.serversherpa.kiosk.input.rfid.RfidPermissions
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.screens.labels.BluetoothFix
import com.serversherpa.kiosk.ui.screens.labels.BluetoothFixButton
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.launch

/**
 * The Sled triggers control: RFID · Barcode · Both, written through
 * `updateRfid` (ruling 31). With [caption], the one-word "Sled triggers" sits
 * above it (the scan screens). Dimmed, and deaf to taps, on a Zebra host and
 * for a sled known to have no scanner (rulings 1 and 2): both triggers read
 * tags there whatever the setting says.
 */
@Composable
fun SledTriggersControl(caption: Boolean) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val scope = rememberCoroutineScope()
    val settings by container.prefs.rfid.collectAsStateWithLifecycle(initialValue = DEFAULT_RFID_SETTINGS)
    val info by container.rfid.info.collectAsStateWithLifecycle()
    val enabled = !container.isZebraHost && info?.hasScanner != false
    Column {
        if (caption) Text(SledWords.SLED_TRIGGERS, style = MaterialTheme.typography.labelMedium, color = c.textMute)
        Segmented(SledTriggerLayout.entries.map { it.wire to it.label }, settings.triggerLayout.wire, enabled = enabled) { wire ->
            SledTriggerLayout.fromWire(wire)?.let { layout ->
                scope.launch { container.prefs.updateRfid { it.copy(triggerLayout = layout) } }
            }
        }
    }
}

/**
 * The button that fixes a sled failure ([fix]), from the buttons the app
 * already has: Android's turn-on prompt, Bluetooth settings, this app's
 * settings page (today's "Open app settings"), or Connect ([onConnect]).
 * [SledFix.CHOOSE_SLED] has none: the RFID tab shows the list instead.
 */
@Composable
fun SledFixButton(fix: SledFix, onConnect: () -> Unit) {
    val context = LocalContext.current
    when (fix) {
        SledFix.TURN_ON_BLUETOOTH -> BluetoothFixButton(BluetoothFix.TURN_ON)
        SledFix.BLUETOOTH_SETTINGS -> BluetoothFixButton(BluetoothFix.FORGET)
        SledFix.ALLOW -> MiniButton(SledWords.OPEN_APP_SETTINGS, { openAppSettings(context) })
        SledFix.CONNECT -> MiniButton(SledWords.CONNECT, onConnect)
        SledFix.CHOOSE_SLED -> Unit
    }
}

/**
 * `RfidPermissions.missing(context)`, snapshotted rather than read on every
 * recomposition: nothing tells Compose to recompose a plain call when the
 * operator grants the permission in Android's own Settings app and returns,
 * so it is read again on every `ON_RESUME`. A permission prompt's callback
 * writes the state directly (the RFID tab does).
 */
@Composable
fun rememberMissingRfidPermissions(): MutableState<List<String>> {
    val context = LocalContext.current
    val missing = remember { mutableStateOf(RfidPermissions.missing(context)) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) missing.value = RfidPermissions.missing(context)
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    return missing
}

/** This app's page in Android's Settings, where its permissions are granted. */
internal fun openAppSettings(context: Context) {
    runCatching {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}

/**
 * The sled's one line on Scanning and Asset Lookup, below the scan box
 * (spec, Screens): nothing while the sled is connected and working, else the
 * connection, region, scanner or read sentence ([scanSlotLine]), with the
 * button that fixes it in a `FlowRow` under it, the way `PrinterReachNotice`
 * lays it out. Stop shows while the app is reconnecting, and Try again when
 * the sled's barcode scanner did not start (its sentence says to tap it).
 *
 * Red for a change during this visit, muted for what was already there when
 * the screen opened (the text at first composition, worked out as if the
 * reader were on, since the saved settings arrive a moment later). Shown
 * only while the reader is on, and on Asset Lookup only once the screen is
 * ready ([screenReady]).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SledSlot(screenReady: Boolean = true) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val settings by container.prefs.rfid.collectAsStateWithLifecycle(initialValue = DEFAULT_RFID_SETTINGS)
    val connection by container.rfid.connection.collectAsStateWithLifecycle()
    val reconnecting by container.rfid.reconnecting.collectAsStateWithLifecycle()
    val retry by container.rfid.retry.collectAsStateWithLifecycle()
    val scanner by container.rfid.scanner.collectAsStateWithLifecycle()
    val readError by container.rfid.readError.collectAsStateWithLifecycle()
    val permissionMissing = rememberMissingRfidPermissions().value.isNotEmpty()
    fun slot(textAtOpen: String?) = scanSlotLine(
        sledLine(connection, reconnecting, enabled = true, permissionMissing = permissionMissing, retry = retry),
        connection, scanner, readError, textAtOpen,
    )
    val textAtOpen = remember { slot(null)?.text }
    if (!settings.enabled || !screenReady) return
    val line = slot(textAtOpen) ?: return
    val tryAgain = line.text == SledWords.SCANNER_DID_NOT_START &&
        scanner == SledScannerState.Unavailable(SledScannerFault.DID_NOT_START)
    val fix = line.fix?.takeIf { it != SledFix.CHOOSE_SLED }
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        if (line.red) {
            Text(
                line.text, style = MaterialTheme.typography.bodyMedium, color = ChipTone.RED.text,
                modifier = Modifier.testTag("sled-slot-red").fillMaxWidth()
                    .background(ChipTone.RED.bg, RoundedCornerShape(10.dp)).padding(12.dp),
            )
        } else {
            Text(
                line.text, style = MaterialTheme.typography.bodyMedium, color = c.textMute,
                modifier = Modifier.testTag("sled-slot-muted").fillMaxWidth()
                    .background(c.paper2, RoundedCornerShape(10.dp)).padding(12.dp),
            )
        }
        if (fix != null || line.offersStop || tryAgain) {
            FlowRow(
                Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                fix?.let { SledFixButton(it, onConnect = { scope.launch { container.rfid.connectNow() } }) }
                if (line.offersStop) MiniButton(SledWords.STOP, { container.rfid.stopReconnecting() })
                if (tryAgain) MiniButton(SledWords.TRY_AGAIN, { scope.launch { container.rfid.retryScanner() } })
            }
        }
    }
}
