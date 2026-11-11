package com.serversherpa.kiosk

import android.app.Application

open class KioskApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = createContainer()
        container.start()
    }

    /** The app's one container; a test application returns a test container. */
    internal open fun createContainer(): AppContainer = AppContainer(this)
}
