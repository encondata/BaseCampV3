package com.serversherpa.kiosk

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.fragment.app.FragmentActivity
import com.serversherpa.kiosk.input.ExternalKeyLog
import com.serversherpa.kiosk.ui.KioskApp
import com.serversherpa.kiosk.ui.components.LocalSledScanGuard
import com.serversherpa.kiosk.ui.theme.uiModeNightChanged

/** A FragmentActivity (a ComponentActivity with a FragmentManager): androidx.biometric's
 *  BiometricPrompt hosts its prompt in a fragment of it. It handles every configuration change
 *  of ruling 15 itself (the manifest's `configChanges`), so a keyboard attaching or the phone
 *  turning mid-burst keeps the activity, its screens and the sled's read. */
class MainActivity : FragmentActivity() {
    private val container get() = (application as KioskApplication).container
    private val keyLog = ExternalKeyLog { Log.i(SLED_LOG_TAG, it) }
    private var uiMode = Configuration.UI_MODE_NIGHT_UNDEFINED

    /** The input device behind a key event; a test seam (Robolectric registers no devices). */
    internal var inputDeviceFor: (Int) -> InputDevice? = { InputDevice.getDevice(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A push alert's tap (cold start). A recreated activity gets its old intent back: that
        // tap was already handled.
        if (savedInstanceState == null) container.pendingOpen.offer(intent)
        enableEdgeToEdge()
        uiMode = resources.configuration.uiMode
        setContent {
            CompositionLocalProvider(LocalAppContainer provides container, LocalSledScanGuard provides container.sledScanGuard) { KioskApp() }
        }
    }

    /** singleTask: a push alert's tap while the app is running arrives here. The shell opens
     *  Notifications from the pending open once someone is signed in. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        container.pendingOpen.offer(intent)
    }

    override fun onStart() { super.onStart(); if (container.hasDataWedge) container.dataWedgeReceiver.register(this) }
    override fun onResume() { super.onResume(); container.enableScannerInputOnce(this) }
    override fun onStop() { container.dataWedgeReceiver.unregister(this); super.onStop() }

    /** Kept alive across changes: edge-to-edge is set up again only when night mode changed
     *  (it resets the status-bar icon color the screens set; `StatusBarIcons` re-applies). */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (uiModeNightChanged(uiMode, newConfig.uiMode)) enableEdgeToEdge()
        uiMode = newConfig.uiMode
    }

    /** Logs the first key from each external keyboard (a sled typing its barcodes), then always
     *  passes the key on: nothing here swallows, consumes or collects a key. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        inputDeviceFor(event.deviceId)?.let { d ->
            keyLog.note(d.id, d.name, d.vendorId, d.productId, d.isExternal, d.isVirtual)
        }
        return super.dispatchKeyEvent(event)
    }
}
