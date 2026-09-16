package com.serversherpa.kiosk

import android.app.Application
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.data.api.MemorySecretStore
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidReader
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking

/** An AppContainer safe under Robolectric: memory secrets, in-memory Room, an API URL that fails fast.
 *  [rfidReader] defaults to a fresh [FakeRfidReader]; a test that needs a reader with different timing
 *  or failure behavior (e.g. a connect() that must stay in flight until released) can pass its own. */
fun testContainer(rfidReader: RfidReader = FakeRfidReader()): AppContainer {
    val app = ApplicationProvider.getApplicationContext<Application>()
    val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    val file = File(app.cacheDir, "kiosk-test-${UUID.randomUUID()}.preferences_pb")
    val store = PreferenceDataStoreFactory.create(scope = scope) { file }
    val c = AppContainer(
        app,
        secrets = MemorySecretStore(),
        db = KioskDatabase.inMemory(app),
        dataStore = store,
        rfidReaderOverride = rfidReader,
    )
    runBlocking { c.prefs.setApiUrl("http://127.0.0.1:1") }
    return c
}
