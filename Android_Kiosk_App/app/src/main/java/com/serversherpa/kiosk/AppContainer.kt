package com.serversherpa.kiosk

import android.app.Application
import android.content.Context
import android.os.Build
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStore
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.serversherpa.kiosk.data.api.AndroidSecretStore
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.OkHttpKioskApi
import com.serversherpa.kiosk.data.api.RefreshCookieJar
import com.serversherpa.kiosk.data.api.SecretStore
import com.serversherpa.kiosk.data.api.SessionStore
import com.serversherpa.kiosk.data.auth.KioskAuth
import com.serversherpa.kiosk.data.auth.SessionCoordinator
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.heartbeat.Heartbeat
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.outbox.RoomOutboxStore
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.input.ScanBus
import com.serversherpa.kiosk.input.camera.hasCamera
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.input.datawedge.DataWedgeReceiver
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.input.rfid.RfidController
import com.serversherpa.kiosk.input.rfid.RfidPermissions
import com.serversherpa.kiosk.input.rfid.RfidReader
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

private val Context.kioskDataStore by preferencesDataStore(name = "kiosk_prefs")

/** Manual dependency wiring: one instance, built by KioskApplication. */
class AppContainer(
    private val app: Application,
    secrets: SecretStore? = null,
    val db: KioskDatabase = KioskDatabase.build(app),
    dataStore: DataStore<Preferences> = app.kioskDataStore,
    rfidReaderOverride: RfidReader? = null,
) {
    /** EncryptedSharedPreferences unlocks an Android Keystore key — too slow for
     *  Application.onCreate. The jar's first use builds it, on whatever OkHttp
     *  thread that turns out to be, never the main thread. */
    private val androidSecrets by lazy { AndroidSecretStore(app) }
    private val secretStore: SecretStore = secrets ?: object : SecretStore {
        override fun get(key: String): String? = androidSecrets.get(key)
        override fun put(key: String, value: String) = androidSecrets.put(key, value)
        override fun remove(key: String) = androidSecrets.remove(key)
    }
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val prefs = KioskPrefs(dataStore)
    val config = KioskConfig(prefs, BuildConfig.DEFAULT_API_URL, BuildConfig.DEFAULT_PORTAL_URL, BuildConfig.KIOSK_VERSION)
    val identity = Identity(prefs)
    val cookieJar = RefreshCookieJar(secretStore)
    val httpClient: OkHttpClient = OkHttpClient.Builder().cookieJar(cookieJar)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    val session = SessionStore(httpClient, config, scope)
    val api: KioskApi = OkHttpKioskApi(httpClient, config, session)
    val auth = KioskAuth(api, session, identity, scope)
    val sync = Sync(api, db, scope)
    val outbox = Outbox(RoomOutboxStore(db.outbox()), api, identity, scope)
    val hasDataWedge: Boolean = DataWedge.isPresent(app)
    val hasCamera: Boolean = hasCamera(app)
    val heartbeat = Heartbeat(api, identity, config, deviceInfo = {
        mapOf(
            "manufacturer" to Build.MANUFACTURER, "model" to Build.MODEL,
            "android_version" to Build.VERSION.RELEASE, "sdk_int" to Build.VERSION.SDK_INT.toString(),
            "datawedge" to hasDataWedge.toString(),
        )
    })
    val foreground = MutableStateFlow(false)
    val scanBus = ScanBus()
    val dataWedgeReceiver = DataWedgeReceiver(scanBus)
    val flash = FlashController(scope)
    val sound = SoundPlayer(prefs, scope)

    // The Zebra adapter arrives in the next task; until then, and in every test,
    // this is the fake. Nothing above the interface can tell the difference.
    val rfidReader: RfidReader = rfidReaderOverride ?: FakeRfidReader()
    val rfid = RfidController(rfidReader, prefs.rfid, scope)

    fun start() {
        // Two launches: the footer's sync line must not wait on auth's network call.
        scope.launch { identity.get(); auth.restore() }
        scope.launch { sync.hydrate() }
        scope.launch { session.sessionEnded.collect { cookieJar.clearRefreshCookie() } }
        SessionCoordinator(auth, heartbeat, foreground, scope).start()
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                foreground.value = true
                outbox.start()
                scope.launch { if (prefs.rfid.first().enabled && RfidPermissions.granted(app)) rfid.connectNow() }
            }
            override fun onStop(owner: LifecycleOwner) {
                foreground.value = false
                scope.launch { rfid.disconnectNow() }
                outbox.stop()
            }
        })
        DataWedge.configure(app)
        rfid.start()
    }

    suspend fun logout() {
        auth.logout()
        cookieJar.clearRefreshCookie()
    }
}

val LocalAppContainer = staticCompositionLocalOf<AppContainer> { error("No AppContainer provided") }
