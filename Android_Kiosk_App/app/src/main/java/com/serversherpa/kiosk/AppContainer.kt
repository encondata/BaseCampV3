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
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.data.api.AndroidSecretStore
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.OkHttpKioskApi
import com.serversherpa.kiosk.data.api.OkHttpStationApi
import com.serversherpa.kiosk.data.api.RefreshCookieJar
import com.serversherpa.kiosk.data.api.SecretStore
import com.serversherpa.kiosk.data.api.SessionStore
import com.serversherpa.kiosk.data.api.kioskDispatcher
import com.serversherpa.kiosk.data.api.StationApi
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.auth.KioskAuth
import com.serversherpa.kiosk.data.auth.MoveSetupGuard
import com.serversherpa.kiosk.data.auth.SessionCoordinator
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.heartbeat.Heartbeat
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.labels.LabelBuilder
import com.serversherpa.kiosk.data.labels.LabelEngine
import com.serversherpa.kiosk.data.labels.LabelGenerator
import com.serversherpa.kiosk.data.labels.LabelSettingsStore
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.outbox.RoomOutboxStore
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.printer.AndroidBluetoothLe
import com.serversherpa.kiosk.data.printer.BluetoothLeClient
import com.serversherpa.kiosk.data.printer.LabelSender
import com.serversherpa.kiosk.data.printer.LocalNetworks
import com.serversherpa.kiosk.data.printer.NetworkZebra
import com.serversherpa.kiosk.data.printer.PrinterGuard
import com.serversherpa.kiosk.data.printer.PrinterLock
import com.serversherpa.kiosk.data.printer.ZebraBluetooth
import com.serversherpa.kiosk.data.printer.ZebraTransport
import com.serversherpa.kiosk.data.printer.isUpTo
import com.serversherpa.kiosk.data.printer.lockedSender
import com.serversherpa.kiosk.data.printer.send
import com.serversherpa.kiosk.data.printer.transportFor
import com.serversherpa.kiosk.data.rolodex.RolodexCacheStore
import com.serversherpa.kiosk.data.station.StationKeyStore
import com.serversherpa.kiosk.data.station.StationStatus
import com.serversherpa.kiosk.data.station.issueAndStore
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.input.ScanBus
import com.serversherpa.kiosk.input.camera.hasCamera
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.input.datawedge.DataWedgeReceiver
import com.serversherpa.kiosk.input.rfid.RfidController
import com.serversherpa.kiosk.input.rfid.RfidPermissions
import com.serversherpa.kiosk.input.rfid.RfidReader
import com.serversherpa.kiosk.input.rfid.ZebraRfidReader
import com.serversherpa.kiosk.nettest.InternetTest // INTERNET-TEST
import com.serversherpa.kiosk.nettest.InternetTestRoutes // INTERNET-TEST
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

private val Context.kioskDataStore by preferencesDataStore(name = "kiosk_prefs")

/** Manual dependency wiring: one instance, built by KioskApplication. */
class AppContainer(
    private val app: Application,
    secrets: SecretStore? = null,
    val db: KioskDatabase = KioskDatabase.build(app),
    dataStore: DataStore<Preferences> = app.kioskDataStore,
    rfidReaderOverride: RfidReader? = null,
    /** Tests: fakes for the portal's session and station clients. */
    apiOverride: KioskApi? = null,
    stationApiOverride: StationApi? = null,
    /** Tests: a fake Bluetooth LE adapter for the printer link. */
    bluetoothOverride: BluetoothLeClient? = null,
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
    val internetTest = InternetTest(dataStore, scope) // INTERNET-TEST
    val config = KioskConfig(prefs, BuildConfig.DEFAULT_API_URL, BuildConfig.DEFAULT_PORTAL_URL, BuildConfig.KIOSK_VERSION)
    val identity = Identity(prefs)
    val cookieJar = RefreshCookieJar(secretStore)
    val httpClient: OkHttpClient = OkHttpClient.Builder().cookieJar(cookieJar).dispatcher(kioskDispatcher())
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    val session = SessionStore(httpClient, config, scope)
    val api: KioskApi = apiOverride ?: OkHttpKioskApi(httpClient, config, session,
        route = InternetTestRoutes::portal, // INTERNET-TEST
    )
    /** A Time Clock station's signed-out calls: the station key only, no session. */
    val stationApi: StationApi = stationApiOverride ?: OkHttpStationApi(httpClient)
    val stationKeys = StationKeyStore(secretStore)
    /** Whether a Time Clock station's key is there, and whether the portal has paused it. */
    val station = StationStatus(stationKeys, apiBase = { config.apiUrlNow() })
    val auth = KioskAuth(api, session, identity, scope)
    /** The Rolodex's offline list: kept only while an admin is signed in. */
    val rolodexCache = RolodexCacheStore(db) { (auth.state.value as? AuthState.Authed)?.isAdmin == true }
    val sync = Sync(api, db, scope, fontsDir = File(app.filesDir, "label-fonts"))
    val labelEngine: LabelEngine = LabelGenerator(app)
    /** One connection to the saved printer at a time, app-wide: Print Labels' sends and every
     *  Printer Setup call (identify, checks, font installs, test labels) go through it. */
    val printerLock = PrinterLock()
    /** Each printer's state after a failed send or a cut font install (the `~JX` clear, the stop),
     *  keyed to its connection and applied under [printerLock] by the same callers. Saving another
     *  connection (or none) drops every mark, whoever saves it ([labelSettings] is the one writer). */
    val printerGuard = PrinterGuard()
    /** The app's one Bluetooth LE link to a Zebra (D4): it connects on first need and stays up while
     *  the app is in use, and closes when the app goes to the background, on sign-out, when the
     *  session ends, and when another printer is saved. Its own scope, a child of [scope] (cancelling
     *  that stops the link's event loop), runs on Default, never Main: its progress callbacks (a font
     *  install's) run there. Nothing scans, and nothing asks for a permission, until Bluetooth is
     *  picked in Printer Setup or a Bluetooth printer is used. */
    val zebraBluetooth = ZebraBluetooth(
        bluetoothOverride ?: AndroidBluetoothLe(app),
        CoroutineScope(SupervisorJob(scope.coroutineContext[Job]) + Dispatchers.Default),
    )
    val labelSettings = LabelSettingsStore(prefs, onConnectionChange = {
        printerGuard.reset()
        // A link up to the printer just saved stays (Printer Setup brought it up to choose it);
        // a link to any other printer lets it go.
        if (!zebraBluetooth.link.value.isUpTo(prefs.labels.first().printer)) zebraBluetooth.close()
    })
    /** Print Labels' sender: straight to the printer (no status checks before or after), one
     *  connection at a time with Printer Setup's calls, under the guard's rules. */
    val labelSender: LabelSender = lockedSender(printerLock, printerGuard) { printer, zpl ->
        withContext(Dispatchers.IO) { zebraFor(printer).send(zpl) }
    }
    val labelBuilder = LabelBuilder(db, labelEngine, labelSettings, scope)
    val outbox = Outbox(RoomOutboxStore(db.outbox()), api, identity, scope)
    val hasDataWedge: Boolean = DataWedge.isPresent(app)
    val hasCamera: Boolean = hasCamera(app)
    val heartbeat = Heartbeat(api, identity, config, prefs, deviceInfo = {
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

    // Every test passes rfidReaderOverride (see TestContainer.kt) so it never
    // constructs the real Zebra reader. Nothing above the interface can tell
    // the difference between this and the fake.
    val rfidReader: RfidReader = rfidReaderOverride ?: ZebraRfidReader(app, scope)
    val rfid = RfidController(rfidReader, prefs.rfid, scope)

    /** The app coming to the front and going to the background (ProcessLifecycleOwner; [start]
     *  registers it). */
    internal val processLifecycle: DefaultLifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            foreground.value = true
            outbox.start()
            // Called directly here, not from inside a scope.launch: a
            // fast background/foreground/background flurry (an incoming
            // call, the notification shade, a screen lock) must not let
            // this land after a disconnectForLifecycle() a later onStop
            // issues, or the reverse. connectForLifecycle() enqueues
            // synchronously onto RfidController's own command channel —
            // the same one arm()/disarm()/stopBurst() use — so as long
            // as onStart/onStop each call straight in like this, the
            // order those calls land in that channel always matches the
            // order Android delivered the lifecycle events, regardless
            // of how long the enabled/permission check or the connect
            // itself then takes. See RfidController's class doc.
            rfid.connectForLifecycle { prefs.rfid.first().enabled && RfidPermissions.granted(app) }
            // Back from Settings, say: Android sends nothing when a permission is granted.
            zebraBluetooth.refreshAvailability()
        }
        override fun onStop(owner: LifecycleOwner) {
            foreground.value = false
            rfid.disconnectForLifecycle()
            outbox.stop()
            // No Bluetooth in the background: a label already going out finishes, then the link closes.
            zebraBluetooth.close()
        }
    }

    fun start() {
        internetTest.start(auth.state, prefs.devMode, heartbeat.setupCleared) // INTERNET-TEST
        // Two launches: the footer's sync line must not wait on auth's network call.
        scope.launch { identity.get(); auth.restore() }
        scope.launch { sync.hydrate() }
        labelBuilder.start(sync.status)
        scope.launch {
            session.sessionEnded.collect {
                cookieJar.clearRefreshCookie()
                zebraBluetooth.close()
            }
        }
        watchRolodexCache()
        // Clear Setup revokes a Time Clock station's key on the portal; drop it here too.
        scope.launch(Dispatchers.IO) { heartbeat.setupCleared.collect { stationKeys.clear() } }
        SessionCoordinator(auth, heartbeat, foreground, scope).start()
        // A dropped setup can't keep a Time Clock station's key either.
        MoveSetupGuard(auth.state, prefs, scope, onSetupDropped = { station.drop() },
            onDropped = internetTest::onSetupDropped, // INTERNET-TEST
        ).start()
        ProcessLifecycleOwner.get().lifecycle.addObserver(processLifecycle)
        DataWedge.configure(app)
        rfid.start()
    }

    /**
     * Settings › Developer › Reset app: a fresh setup on a kiosk that stays signed in. Clears the
     * synced move data (with the generated labels, templates and font files: Sync.clearLocalData),
     * the Kiosk Setup selection and setup state, the label settings (printer, offsets, peel) and the
     * Rolodex's offline list.
     * Drops a Time Clock station's key with the setup. Keeps the outbox (unsent scans), the sign-in, the API and portal URLs, the kiosk's identity
     * and name, and the appearance, sound, RFID, camera, checkpoint and developer-mode
     * preferences. The label builder ends stopped, waiting for a sync. The Print Labels list
     * lives in its screen's ViewModel, which the caller's trip Home clears. Throws when the local
     * data couldn't be cleared; the setup is then left as it was. [clearLocalData] is a test seam.
     */
    suspend fun resetApp(clearLocalData: suspend () -> Unit = { sync.clearLocalData() }) {
        clearLocalData()
        rolodexCache.clear()
        prefs.clearSetup()
        withContext(Dispatchers.IO) { stationKeys.clear() }
        labelSettings.reset()
        // No build left over. A settings change may still start one, which finds no synced move
        // and ends at once waiting for a sync, as the stop does.
        labelBuilder.stop()
    }

    /** The saved printer the way its connection reaches it: the network printer at its host, over
     *  the Wi-Fi or Ethernet network's own sockets; the Bluetooth printer over [zebraBluetooth] (by
     *  the address it was saved with, else its serial). */
    fun zebraFor(printer: SavedPrinter): ZebraTransport = transportFor(
        printer,
        network = { host -> NetworkZebra(host, socketFactory = LocalNetworks.socketFactoryFor(app, host)) },
        bluetooth = zebraBluetooth::transport,
    )

    suspend fun logout() {
        internetTest.beforeSignOut() // INTERNET-TEST
        zebraBluetooth.close()
        auth.logout()
        cookieJar.clearRefreshCookie()
        // Also done by the watch below; here too so it's done when this returns. The delete runs to
        // the end even though signing out disposes the screen whose scope called this.
        try { rolodexCache.clear() } catch (e: CancellationException) { throw e } catch (_: Exception) { /* the watch tries again */ }
    }

    /** The Rolodex's offline list holds names an admin loaded: it goes on every end of a session
     *  (Sign out, a session that ended, one that couldn't be restored at launch). Called by start(). */
    internal fun watchRolodexCache(): Job = rolodexCache.clearWhenTheSessionEnds(auth.state, scope)

    /** Issues this kiosk's station key under the signed-in session and stores it bound to the
     *  API origin, with the one sign-in heartbeat and retry a `not_signed_in_here` answer calls
     *  for. Throws ApiError. */
    suspend fun issueStationKey() {
        station.issueAndStore(api, identity.get().serial) { heartbeat.signInNow() }
    }

    /**
     * Settings › This Kiosk's API URL, whoever saves it (signed in or not). A Time Clock
     * station's key issued by another origin is dropped at once: it must never reach another
     * server. The station then waits for a new key.
     */
    suspend fun saveApiUrl(url: String) {
        prefs.setApiUrl(url)
        val origin = KioskConfig.originOf(url) ?: url
        withContext(Dispatchers.IO) { stationKeys.keepOnlyFor(origin) }
    }

    /**
     * A Time Clock station's Home tile (the web's Start Time Clock): makes sure the station has
     * its key, then signs the person out, which leaves the station on Welcome. A key that can't
     * be had throws ApiError and keeps the person signed in.
     */
    suspend fun startTimeclock() {
        if (station.credentials() == null) issueStationKey()
        logout()
    }
}

val LocalAppContainer = staticCompositionLocalOf<AppContainer> { error("No AppContainer provided") }
