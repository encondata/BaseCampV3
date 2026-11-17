package com.serversherpa.kiosk.input.rfid

import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler

/**
 * Wraps a [Context] so that a dynamically registered broadcast receiver that
 * names no export flag gets `RECEIVER_EXPORTED` on Android 13 (API 33) and up.
 *
 * Kept as a guard for the vendor's `Readers` only (spec ruling 25):
 * `ZebraRfidReader.openVendorConnection()` builds `Readers` with one of these
 * instead of the plain app `Context`. The bundled Zebra RFIDAPI3 `.aar`
 * (`RFIDAPI3Library/API3_LIB-release.aar`, 2.0.5.292) already passes the
 * export flag itself on API 33 and up: `Readers`, `API3Service`,
 * `API3SystemService`, `API3UsbService`, `com.zebra.commoniolib.usbiomgr` and
 * `com.zebra.scannercontrol.SDKHandler` all call the three-argument
 * `registerReceiver(receiver, filter, RECEIVER_EXPORTED)` there and the
 * flagless overload only below API 33. So with this `.aar` the wrapper changes
 * nothing; it stays so that a vendor update, or a code path not read here,
 * that registers without a flag still does not throw Android 14's
 * `SecurityException` inside `Readers`. Nothing else in the app is handed
 * this wrapper.
 *
 * `RECEIVER_EXPORTED`, not `RECEIVER_NOT_EXPORTED`, because it is what the
 * vendor passes itself, and what a receiver with no flag meant before
 * Android 14. One of `Readers`' receivers hears DataWedge's result broadcast,
 * which comes from another app, so the narrower flag would silently stop it,
 * with no exception to point at why.
 *
 * The overloads that already take a `flags` argument are left to
 * `ContextWrapper`'s ordinary passthrough (not overridden here at all): a
 * caller that chose its own flag keeps it.
 *
 * [getApplicationContext] returns this wrapper rather than the base
 * context's application context. Left alone, `ContextWrapper` would hand
 * vendor code the raw `Application` the moment it calls
 * `context.getApplicationContext().registerReceiver(...)`, which would skip
 * the overrides below. This is safe only because the `Context` this wraps
 * already is the application context (`ZebraRfidReader` is built with `app`,
 * an `Application`, in `AppContainer.kt`), so returning the wrapper in its
 * place is not an identity downgrade.
 */
class ExportedReceiverContext(base: Context) : ContextWrapper(base) {

    override fun getApplicationContext(): Context = this

    override fun registerReceiver(receiver: BroadcastReceiver?, filter: IntentFilter?): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, RECEIVER_EXPORTED)
        } else {
            super.registerReceiver(receiver, filter)
        }

    override fun registerReceiver(
        receiver: BroadcastReceiver?,
        filter: IntentFilter?,
        broadcastPermission: String?,
        scheduler: Handler?,
    ): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, broadcastPermission, scheduler, RECEIVER_EXPORTED)
        } else {
            super.registerReceiver(receiver, filter, broadcastPermission, scheduler)
        }
}
