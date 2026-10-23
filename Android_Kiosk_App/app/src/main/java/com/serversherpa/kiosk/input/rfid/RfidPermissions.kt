package com.serversherpa.kiosk.input.rfid

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * What the sled needs before it can be connected. Asked for when the operator
 * turns the reader on in Settings, never at launch: a kiosk that will never see
 * a sled should never see a Bluetooth prompt.
 *
 * The prompt asks for [REQUESTED]: [REQUIRED] plus approximate location
 * (`ACCESS_COARSE_LOCATION`), because Android 12+ ignores a request for
 * precise location alone (as `BluetoothPermissions` does). What the sled needs
 * granted stays [REQUIRED]: approximate is only asked for beside precise, never
 * checked on its own, so a device that already had precise keeps connecting.
 */
object RfidPermissions {
    /** What must be granted before the sled connects. */
    val REQUIRED: List<String> get() = requiredFor(Build.VERSION.SDK_INT)

    /** What the prompt asks for. */
    val REQUESTED: List<String> get() = requestedFor(Build.VERSION.SDK_INT)

    /** The permissions [sdk] needs granted. */
    fun requiredFor(sdk: Int): List<String> = buildList {
        if (sdk >= Build.VERSION_CODES.S) {
            add(Manifest.permission.BLUETOOTH_CONNECT)
            add(Manifest.permission.BLUETOOTH_SCAN)
        }
        add(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    /** What the prompt asks for on [sdk]: precise location together with approximate. */
    fun requestedFor(sdk: Int): List<String> = requiredFor(sdk) + Manifest.permission.ACCESS_COARSE_LOCATION

    fun missing(context: Context): List<String> = REQUIRED.filter {
        ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
    }

    fun granted(context: Context): Boolean = missing(context).isEmpty()
}
