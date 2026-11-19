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
 *
 * [REQUIRED] is the stored gate for the automatic connect. The Connect button,
 * the adapter's pre-check and the paired-sled list need only [NEARBY] (ruling
 * 22): the two Nearby devices permissions whose absence makes the Bluetooth
 * calls throw.
 */
object RfidPermissions {
    /** What must be granted before the sled connects. */
    val REQUIRED: List<String> get() = requiredFor(Build.VERSION.SDK_INT)

    /** What the prompt asks for. */
    val REQUESTED: List<String> get() = requestedFor(Build.VERSION.SDK_INT)

    /** Nearby devices: what Bluetooth calls need on this device. */
    val NEARBY: List<String> get() = nearbyFor(Build.VERSION.SDK_INT)

    /** Nearby devices on [sdk]: connect and scan from API 31 up, nothing below. */
    fun nearbyFor(sdk: Int): List<String> =
        if (sdk >= Build.VERSION_CODES.S) {
            listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN)
        } else {
            emptyList()
        }

    /** The permissions [sdk] needs granted. */
    fun requiredFor(sdk: Int): List<String> = nearbyFor(sdk) + Manifest.permission.ACCESS_FINE_LOCATION

    /** What the prompt asks for on [sdk]: precise location together with approximate. */
    fun requestedFor(sdk: Int): List<String> = requiredFor(sdk) + Manifest.permission.ACCESS_COARSE_LOCATION

    fun missing(context: Context): List<String> = REQUIRED.filter {
        ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
    }

    fun granted(context: Context): Boolean = missing(context).isEmpty()

    /** True when everything in [NEARBY] is granted; location is not checked. */
    fun nearbyGranted(context: Context): Boolean = NEARBY.all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }
}
