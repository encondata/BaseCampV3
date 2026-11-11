package com.serversherpa.kiosk.input.rfid

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.serversherpa.kiosk.core.rfid.SledNudge
import com.serversherpa.kiosk.core.rfid.isSledName
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The app's Bluetooth receiver for the sled (spec, App wiring): Bluetooth turning on, and the
 * last sled's link appearing (or, with no sled known yet, a device named like a sled), each
 * [nudge] the controller, which shortens a reconnect wait or starts one try. Registered while
 * the app is in front; [register] and [unregister] are idempotent, so an `onStop` before any
 * `onStart` is harmless. Device names and addresses are read only when [canReadDevices] says
 * Nearby devices (`BLUETOOTH_CONNECT`) is granted; without it a link appearing is ignored.
 */
class SledNudgeReceiver(
    private val nudge: (SledNudge, String?, String?) -> Unit,
    private val lastSledAddress: () -> String?,
    private val canReadDevices: (Context) -> Boolean,
) : BroadcastReceiver() {
    private val registered = AtomicBoolean(false)

    fun register(context: Context) {
        if (!registered.compareAndSet(false, true)) return
        val filter = IntentFilter().apply {
            addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
            addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
        }
        // Both are system broadcasts, which reach a receiver that is not exported.
        ContextCompat.registerReceiver(context, this, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    fun unregister(context: Context) {
        if (!registered.compareAndSet(true, false)) return
        try { context.unregisterReceiver(this) } catch (e: IllegalArgumentException) { /* already gone */ }
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            BluetoothAdapter.ACTION_STATE_CHANGED ->
                if (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR) == BluetoothAdapter.STATE_ON) {
                    nudge(SledNudge.BLUETOOTH_ON, null, null)
                }
            BluetoothDevice.ACTION_ACL_CONNECTED -> linkAppeared(context, intent)
        }
    }

    // canReadDevices checked BLUETOOTH_CONNECT first; a SecurityException is still caught.
    @SuppressLint("MissingPermission")
    private fun linkAppeared(context: Context, intent: Intent) {
        if (!canReadDevices(context)) return
        val device = deviceOf(intent) ?: return
        val (address, name) = try {
            device.address to device.name
        } catch (e: SecurityException) {
            Log.w(TAG, "A Bluetooth link appeared, but its device could not be read.", e)
            return
        }
        val known = lastSledAddress()
        val ours = if (known != null) address.equals(known, ignoreCase = true) else isSledName(name)
        if (ours) nudge(SledNudge.LINK_APPEARED, address, name)
    }

    private fun deviceOf(intent: Intent): BluetoothDevice? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
        }

    private companion object { const val TAG = "SledNudgeReceiver" }
}
