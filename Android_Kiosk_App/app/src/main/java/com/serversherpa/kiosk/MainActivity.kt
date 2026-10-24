package com.serversherpa.kiosk

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.fragment.app.FragmentActivity
import com.serversherpa.kiosk.ui.KioskApp

/** A FragmentActivity (a ComponentActivity with a FragmentManager): androidx.biometric's
 *  BiometricPrompt hosts its prompt in a fragment of it. */
class MainActivity : FragmentActivity() {
    private val container get() = (application as KioskApplication).container

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            CompositionLocalProvider(LocalAppContainer provides container) { KioskApp() }
        }
    }

    override fun onStart() { super.onStart(); if (container.hasDataWedge) container.dataWedgeReceiver.register(this) }
    override fun onStop() { container.dataWedgeReceiver.unregister(this); super.onStop() }
}
