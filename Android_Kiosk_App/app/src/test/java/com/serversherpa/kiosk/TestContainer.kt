package com.serversherpa.kiosk

import android.app.Application
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.environment.SavedEnvironment
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.MemorySecretStore
import com.serversherpa.kiosk.data.api.SecretStore
import com.serversherpa.kiosk.data.api.StationApi
import com.serversherpa.kiosk.data.auth.BiometricKeys
import com.serversherpa.kiosk.data.auth.BiometricReadiness
import com.serversherpa.kiosk.data.auth.FakeBiometricKeys
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.environment.EnvironmentStore
import com.serversherpa.kiosk.data.printer.BluetoothLeClient
import com.serversherpa.kiosk.data.printer.FakeBluetoothLe
import com.serversherpa.kiosk.data.push.FakeFcmTokens
import com.serversherpa.kiosk.data.push.FcmTokens
import com.serversherpa.kiosk.data.update.AppUpdates
import com.serversherpa.kiosk.data.update.NoAppUpdates
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidReader
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking

/** An AppContainer safe under Robolectric: memory secrets, in-memory Room, a Custom environment whose API URL fails fast.
 *  [rfidReader] defaults to a fresh [FakeRfidReader]; a test that needs a reader with different timing
 *  or failure behavior (e.g. a connect() that must stay in flight until released) can pass its own.
 *  [api] and [stationApi] replace the real HTTP clients (the session, auth and heartbeat use [api]).
 *  [bluetooth] is the printer link's adapter: a [FakeBluetoothLe] (Bluetooth on, no printers) unless
 *  a test passes its own, so no test touches Android's Bluetooth. [dataStore] is a fresh one unless
 *  a test passes its own (a relaunch: two containers over the same prefs). [biometricKeys] is a
 *  [FakeBiometricKeys] with no biometric hardware unless a test passes its own, so no test touches
 *  AndroidKeyStore and no password sign-in is offered fingerprint by accident. [fcmTokens] is a
 *  [FakeFcmTokens] unless a test passes its own (NoFcmTokens: a build without Firebase), so no test
 *  touches Firebase. [updates] is [NoAppUpdates] unless a test passes its own. [secrets] is a fresh
 *  [MemorySecretStore] unless a test passes its own (to look at, or seed, what the secure store holds). */
fun testContainer(
    rfidReader: RfidReader = FakeRfidReader(),
    api: KioskApi? = null,
    stationApi: StationApi? = null,
    bluetooth: BluetoothLeClient = FakeBluetoothLe(),
    dataStore: DataStore<Preferences>? = null,
    biometricKeys: BiometricKeys = FakeBiometricKeys(BiometricReadiness.NO_HARDWARE),
    fcmTokens: FcmTokens = FakeFcmTokens(),
    updates: AppUpdates = NoAppUpdates,
    secrets: SecretStore = MemorySecretStore(),
): AppContainer {
    val app = ApplicationProvider.getApplicationContext<Application>()
    val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    val file = File(app.cacheDir, "kiosk-test-${UUID.randomUUID()}.preferences_pb")
    val store = dataStore ?: PreferenceDataStoreFactory.create(scope = scope) { file }
    val c = AppContainer(
        app,
        secrets = secrets,
        db = KioskDatabase.inMemory(app),
        dataStore = store,
        rfidReaderOverride = rfidReader,
        apiOverride = api,
        stationApiOverride = stationApi,
        bluetoothOverride = bluetooth,
        biometricKeysOverride = biometricKeys,
        fcmTokensOverride = fcmTokens,
        updatesOverride = updates,
        environmentListUrl = TEST_ENVIRONMENT_LIST_URL,
    )
    runBlocking { c.environments.useApi("http://127.0.0.1:1") }
    return c
}

/** Where a test container downloads the environment list from: nothing answers there, so the
 *  chooser gets the saved or built-in list and no test reaches the status site. */
const val TEST_ENVIRONMENT_LIST_URL = "http://127.0.0.1:1/environments.json"

/** Where a test container's portal points: nothing answers there. */
const val TEST_PORTAL_URL = "http://127.0.0.1:1"

/** Points the kiosk at [apiUrl] (a Custom environment), as a test's server needs. */
suspend fun EnvironmentStore.useApi(apiUrl: String) = save(SavedEnvironment.Custom(apiUrl, TEST_PORTAL_URL))
