package com.serversherpa.kiosk

import android.app.Application
import com.serversherpa.kiosk.data.push.PushNotifier

open class KioskApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        // Push alerts' channels (Notifications, Critical alerts), there before any push arrives.
        PushNotifier.createChannels(this)
        container = createContainer()
        container.start()
    }

    /** The app's one container; a test application returns a test container. */
    internal open fun createContainer(): AppContainer = AppContainer(this)
}
