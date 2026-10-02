package com.serversherpa.kiosk.input.rfid

import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler

/**
 * Wraps a [Context] so that every dynamically registered broadcast receiver
 * gets `RECEIVER_EXPORTED` on Android 14 (API 34) and up, even when the
 * caller didn't ask for it.
 *
 * This class exists solely because of the bundled Zebra RFIDAPI3 vendor
 * library (`RFIDAPI3Library/API3_LIB-release.aar`, version 2.0.5.292, from
 * Zebra's public `ALT-RFID-SAMPLES` sample repository — see
 * `ZebraRfidReader.kt`'s class doc for why it's wired in as a raw local
 * artifact rather than a Maven dependency). Re-verified via `javap` against
 * this version: `com.zebra.rfid.api3.Readers`, `API3Service`,
 * `API3SystemService`, `API3UsbService` (and its inner classes),
 * `com.zebra.commoniolib.usbiomgr`, and `com.zebra.scannercontrol.SDKHandler`
 * still call `Context.registerReceiver` using the overloads that take no
 * flags, so none of them was updated for the rule Android 14 introduced: a
 * dynamically registered receiver for a non-system broadcast now throws
 * `SecurityException` unless the caller passes `RECEIVER_EXPORTED` or
 * `RECEIVER_NOT_EXPORTED`. `com.zebra.scannercontrol.USBManager` is the one
 * exception in this version — it now supplies `RECEIVER_EXPORTED` itself
 * (confirmed via `javap`: that literal appears only in `USBManager.class`),
 * but that class sits on the USB path, not the Bluetooth path this app
 * actually uses (the RFD40 pairs over Bluetooth — see the manifest's own
 * comment on the legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` permissions). `Readers`
 * is still unpatched, so `ZebraRfidReader.openVendorConnection()` still hands
 * the vendor's `Readers` constructor one of these instead of the raw app
 * `Context`, supplying on the way in the flag the library never learned to
 * pass. Do not remove this shim on the strength of the vendor version being
 * newer — `RECEIVER_EXPORTED` landing in `USBManager` this release does not
 * mean it landed anywhere this app's own Bluetooth-only vendor call sites
 * touch.
 *
 * `RECEIVER_EXPORTED`, not `RECEIVER_NOT_EXPORTED`, is a deliberate choice.
 * Before Android 14, a dynamically registered receiver with no flag was
 * implicitly exported, so `RECEIVER_EXPORTED` reproduces exactly the
 * behavior this library was written and shipped against. `RECEIVER_NOT_
 * EXPORTED` is the more locked-down option in the abstract, but it would be
 * a guess here: if any of these receivers are meant to hear a broadcast sent
 * from outside this app's own process (its Bluetooth/USB stack running in a
 * different UID, say), the narrower flag would silently stop the sled's
 * events from ever arriving, with no exception to point at why — and there
 * is no way to tell the difference without a real RFD40, which this fix has
 * not been tested against. Revisit only with hardware evidence.
 *
 * The overloads that already take a `flags` argument are left to
 * `ContextWrapper`'s ordinary passthrough (not overridden here at all): a
 * caller that specified its own intent should keep it.
 *
 * [getApplicationContext] is overridden to return this wrapper rather than
 * delegate to the base context's own `getApplicationContext()`. Left alone,
 * `ContextWrapper`'s default implementation would hand vendor code the raw,
 * unwrapped `Application` context the moment it calls
 * `context.getApplicationContext().registerReceiver(...)` — a common enough
 * pattern that it can't be assumed away — which would let the un-flagged
 * call straight through this class without ever visiting the overrides
 * below. Returning `this` keeps such a call routed through them too. This
 * is safe only because the `Context` this wraps already *is* the
 * application context (`ZebraRfidReader` is constructed with `app`, an
 * `Application`, in `AppContainer.kt`), so returning the wrapper in its
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
