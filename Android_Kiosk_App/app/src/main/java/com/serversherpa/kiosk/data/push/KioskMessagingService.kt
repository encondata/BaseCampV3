package com.serversherpa.kiosk.data.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.serversherpa.kiosk.KioskApplication
import kotlinx.coroutines.launch

/**
 * FCM's entry point (declared in the manifest for com.google.firebase.MESSAGING_EVENT). A thin shell:
 * the server sends data-only messages, so every one lands here, app open or not, and goes to
 * [PushNotifier]; a rotated token goes to [PushRegistrar.onNewToken] on the app's scope. Unit tests
 * cover those two, never this class (it is Firebase's). The token is never logged.
 */
class KioskMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val msg = PushMessage.parse(message.data) ?: return
        PushNotifier(applicationContext).show(msg)
    }

    override fun onNewToken(token: String) {
        val container = (application as? KioskApplication)?.container ?: return
        container.scope.launch { container.pushRegistrar.onNewToken(token) }
    }
}
