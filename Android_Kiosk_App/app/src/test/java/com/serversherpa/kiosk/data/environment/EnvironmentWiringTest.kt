package com.serversherpa.kiosk.data.environment

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.testContainer
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class EnvironmentWiringTest {
    /** With nothing saved, the kiosk connects to the build's default environment (Dev in a
     *  debug build), and a saved Custom environment keeps its URLs. */
    @Test fun nothingSavedMeansTheBuildDefault() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val data = PreferenceDataStoreFactory.create(scope = scope) { File(app.cacheDir, "env-${UUID.randomUUID()}.preferences_pb") }
        val c = testContainer(dataStore = data)
        try {
            data.edit { it.clear() }                         // testContainer saves a Custom environment
            assertNull(c.environments.saved.first())
            assertEquals(SavedEnvironment.Named("dev", "Dev", "dev.serversherpa.com"), c.defaultEnvironment)
            assertEquals("https://api.dev.serversherpa.com", c.config.apiUrlNow())
            assertEquals("https://portal.dev.serversherpa.com", c.config.portalUrlNow())

            c.environments.save(SavedEnvironment.Custom("http://10.10.48.103:8000", "http://10.10.48.103:5173"))
            assertEquals(SavedEnvironment.Custom("http://10.10.48.103:8000", "http://10.10.48.103:5173"), c.environments.saved.first())
            assertEquals("http://10.10.48.103:8000", c.config.apiUrlNow())
        } finally {
            c.scope.cancel(); c.db.close(); scope.cancel()
        }
    }
}
