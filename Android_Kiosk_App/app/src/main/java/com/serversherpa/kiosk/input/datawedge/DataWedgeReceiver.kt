package com.serversherpa.kiosk.input.datawedge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.core.content.ContextCompat
import com.serversherpa.kiosk.input.ScanBus

/** Registered dynamically while the app is in the foreground (DataWedge's
 *  broadcast is implicit, which a manifest receiver would not get on
 *  Android 8+). */
class DataWedgeReceiver(private val bus: ScanBus) : BroadcastReceiver() {
    private var registered = false

    override fun onReceive(context: Context, intent: Intent) {
        DataWedge.parseScan(intent)?.let { bus.publish(it) }
    }

    fun register(context: Context) {
        if (registered) return
        val filter = IntentFilter(DataWedge.SCAN_ACTION).apply { addCategory(Intent.CATEGORY_DEFAULT) }
        ContextCompat.registerReceiver(context, this, filter, ContextCompat.RECEIVER_EXPORTED)
        registered = true
    }

    fun unregister(context: Context) {
        if (!registered) return
        try { context.unregisterReceiver(this) } catch (e: IllegalArgumentException) { /* already gone */ }
        registered = false
    }
}
