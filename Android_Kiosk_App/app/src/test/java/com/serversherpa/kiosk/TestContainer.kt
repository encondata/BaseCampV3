package com.serversherpa.kiosk

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.data.api.MemorySecretStore
import com.serversherpa.kiosk.data.db.KioskDatabase
import kotlinx.coroutines.runBlocking

/** An AppContainer safe under Robolectric: memory secrets, in-memory Room, an API URL that fails fast. */
fun testContainer(): AppContainer {
    val app = ApplicationProvider.getApplicationContext<Application>()
    val c = AppContainer(app, secrets = MemorySecretStore(), db = KioskDatabase.inMemory(app))
    runBlocking { c.prefs.setApiUrl("http://127.0.0.1:1") }
    return c
}
