package com.serversherpa.kiosk.data.printer

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * What Bluetooth printing needs from Android before it can scan for and connect to a Zebra. Asked
 * for the first time someone picks Bluetooth in Printer Setup, never at launch (as
 * [com.serversherpa.kiosk.input.rfid.RfidPermissions] waits for the sled to be turned on): a
 * kiosk that never prints over Bluetooth never sees the prompt.
 *
 * - API 31+: the nearby-devices pair (`BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`), and fine location
 *   too. The manifest's `BLUETOOTH_SCAN` is shared with the RFD40's SDK and doesn't say
 *   `neverForLocation`, so Android filters scan results from an app without location permission.
 * - API 30 (the MC2200): fine location, and scans also need Location turned on (the link reports
 *   that as [BluetoothAvailability.LOCATION_OFF]).
 */
object BluetoothPermissions {
    val REQUIRED: List<String> get() = requiredFor(Build.VERSION.SDK_INT)

    /** The permissions [sdk] needs. */
    fun requiredFor(sdk: Int): List<String> = buildList {
        if (sdk >= Build.VERSION_CODES.S) {
            add(Manifest.permission.BLUETOOTH_SCAN)
            add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        add(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    fun missing(context: Context): List<String> = REQUIRED.filter {
        ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
    }

    fun granted(context: Context): Boolean = missing(context).isEmpty()
}

/** The Android screens that fix a Bluetooth refusal: each is opened by a button beside its message. */
object BluetoothSettingsIntents {
    /** Android's own "turn on Bluetooth?" prompt (needs `BLUETOOTH_CONNECT` on API 31+, which an
     *  app told Bluetooth is off already has: a missing permission reads as not allowed first). */
    fun enableBluetooth(): Intent = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)

    /** This app's page in Settings, where its permissions are allowed. */
    fun appDetails(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))

    /** Location (API 30 scans need it on). */
    fun location(): Intent = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)

    /** Bluetooth's settings (Connected devices), where a printer that forgot this device is forgotten too. */
    fun bluetoothSettings(): Intent = Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
}
