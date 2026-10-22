package com.serversherpa.kiosk.ui.screens.labels

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.core.printer.BLUETOOTH_DENIED_TEXT
import com.serversherpa.kiosk.core.printer.BLUETOOTH_OFF_TEXT
import com.serversherpa.kiosk.core.printer.LOCATION_OFF_TEXT
import com.serversherpa.kiosk.core.printer.pairingLostText
import com.serversherpa.kiosk.data.printer.BluetoothSettingsIntents
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton

/** What fixes a Bluetooth refusal on this device, and the button that opens it. */
enum class BluetoothFix(val button: String) {
    /** Bluetooth is off: Android's own "turn on Bluetooth?" prompt. */
    TURN_ON("Turn on Bluetooth"),
    /** Not allowed: this app's page in Settings, where its permissions are allowed. */
    ALLOW("Open Settings"),
    /** Location is off (API 30 scans need it). */
    LOCATION("Location settings"),
    /** The printer forgot this device: Bluetooth's settings, where it's forgotten too. */
    FORGET("Bluetooth settings"),
}

/** The fix for a Bluetooth refusal shown as [text] (its copy, verbatim), or null for any other
 *  text (no Bluetooth LE at all has none). */
fun bluetoothFixFor(text: String?): BluetoothFix? = when {
    text == null -> null
    text == BLUETOOTH_OFF_TEXT -> BluetoothFix.TURN_ON
    text == BLUETOOTH_DENIED_TEXT -> BluetoothFix.ALLOW
    text == LOCATION_OFF_TEXT -> BluetoothFix.LOCATION
    isPairingLostText(text) -> BluetoothFix.FORGET
    else -> null
}

/** [text] is the forget-it steps for some printer (they name it in the middle). */
private fun isPairingLostText(text: String): Boolean {
    val (head, tail) = pairingLostText(SERIAL_MARK).split(SERIAL_MARK)
    return text.length > head.length + tail.length && text.startsWith(head) && text.endsWith(tail)
}

private const val SERIAL_MARK = "\u0000"

/** The button that opens what fixes [fix]. [onBack] runs when Android's turn-on prompt answers
 *  (the other screens are left with Back, and the app hears that as coming back to the front). */
@Composable
fun BluetoothFixButton(fix: BluetoothFix, modifier: Modifier = Modifier, onBack: () -> Unit = {}) {
    val context = LocalContext.current
    val turnOn = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { onBack() }
    MiniButton(fix.button, onClick = {
        when (fix) {
            BluetoothFix.TURN_ON -> try {
                turnOn.launch(BluetoothSettingsIntents.enableBluetooth())
            } catch (e: ActivityNotFoundException) {
                open(context, BluetoothSettingsIntents.bluetoothSettings())
            } catch (e: SecurityException) {
                open(context, BluetoothSettingsIntents.bluetoothSettings())
            }
            BluetoothFix.ALLOW -> open(context, BluetoothSettingsIntents.appDetails(context))
            BluetoothFix.LOCATION -> open(context, BluetoothSettingsIntents.location())
            BluetoothFix.FORGET -> open(context, BluetoothSettingsIntents.bluetoothSettings())
        }
    }, modifier = modifier)
}

/** Opens [intent], else Android's main Settings (a device without that screen). */
private fun open(context: Context, intent: Intent) {
    try {
        context.startActivity(intent)
    } catch (e: ActivityNotFoundException) {
        context.startActivity(Intent(Settings.ACTION_SETTINGS))
    }
}

/** A Bluetooth refusal's message (red), with the button that fixes it when there is one. */
@Composable
fun BluetoothRefusal(text: String?, error: Boolean = true) {
    if (text == null) return
    KioskToast(text, error = error)
    bluetoothFixFor(text)?.let { BluetoothFixButton(it, Modifier.padding(bottom = 8.dp)) }
}

/** The printer forgot this device: the steps, then Bluetooth settings (where it's forgotten too)
 *  and Connect (once it is). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PairingLostNotice(text: String, onConnect: () -> Unit, connectEnabled: Boolean = true) {
    KioskToast(text, error = true)
    FlowRow(Modifier.padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BluetoothFixButton(BluetoothFix.FORGET)
        MiniButton("Connect", onConnect, enabled = connectEnabled)
    }
}
