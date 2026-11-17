package com.serversherpa.kiosk.ui.screens.settings

import android.content.res.Configuration
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.sledLine
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.screens.scan.rememberMissingRfidPermissions

/** Read-only: which scan inputs this device has. */
@Composable
fun DevicesPanel() {
    val container = LocalAppContainer.current
    val config = LocalConfiguration.current
    val hardKeyboard = config.keyboard != Configuration.KEYBOARD_NOKEYS
    val rfidSettings by container.prefs.rfid.collectAsStateWithLifecycle(initialValue = DEFAULT_RFID_SETTINGS)
    val rfid by container.rfid.connection.collectAsStateWithLifecycle()
    val reconnecting by container.rfid.reconnecting.collectAsStateWithLifecycle()
    val retry by container.rfid.retry.collectAsStateWithLifecycle()
    val missingPermissions by rememberMissingRfidPermissions()
    Column {
        SettingsRow("Zebra DataWedge", "Scans from the built-in scan engine arrive through DataWedge as intents.") { Text(if (container.hasDataWedge) "Present — profile ServerSherpaKiosk" else "Not installed on this device") }
        SettingsRow("RFID reader", "A Zebra RFD40 sled. Its settings live on the RFID tab.") {
            // The same sentence the RFID tab and the scan screens show.
            Text(sledLine(rfid, reconnecting, rfidSettings.enabled, missingPermissions.isNotEmpty(), retry).text)
        }
        SettingsRow("Camera", "Barcode scanning with the camera, single or multi read.") { Text(if (container.hasCamera) "Available" else "No camera on this device") }
        SettingsRow("Hardware keyboard / HID scanner", "A Bluetooth or USB scanner types into the focused box like a keyboard.") { Text(if (hardKeyboard) "A hardware keyboard is attached" else "None attached right now") }
    }
}
