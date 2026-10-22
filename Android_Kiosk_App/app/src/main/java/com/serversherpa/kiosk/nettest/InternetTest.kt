package com.serversherpa.kiosk.nettest

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.serversherpa.kiosk.data.auth.AuthState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Internet Test's controller (design 4.1 and 4.2): it keeps the settings in
 * DataStore, turns the switch off by every rule, and installs the active
 * profiles into [InternetTestRoutes].
 *
 * Conditions apply only while someone is signed in. Until the saved settings
 * have loaded and the auth state is [AuthState.Authed], both links go direct,
 * so the start-up session restore, sign-in and pairing are never conditioned.
 */
class InternetTest(
    private val store: DataStore<Preferences>,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** What the store holds, or null until its first read. Only a loaded value can condition anything. */
    private val stored = MutableStateFlow<InternetTestSettings?>(null)

    private val _settings = MutableStateFlow(InternetTestSettings())

    /** The saved settings, for the Developer section. The defaults (switch off) until the store is read. */
    val settings: StateFlow<InternetTestSettings> = _settings.asStateFlow()

    init {
        scope.launch {
            store.data.map { InternetTestSettings.decode(it[KEY]) }.collect {
                _settings.value = it
                stored.value = it
            }
        }
    }

    /**
     * Switching on starts the two-hour clock. Switching on while already on
     * (and not yet expired) is not a new switch-on, so it keeps the clock.
     * Switching off is [turnOff].
     */
    suspend fun setEnabled(on: Boolean) {
        if (!on) return turnOff()
        update {
            val now = clock()
            if (it.enabled && !isExpired(it.armedAtMs, now)) it else it.copy(enabled = true, armedAtMs = now)
        }
    }

    /** Chooses [preset] for [dial]. A preset the dial doesn't offer is refused, with nothing changed. */
    suspend fun choosePreset(dial: Dial, preset: Preset) {
        if (preset !in dial.presets) return
        update { it.withDial(dial) { setting -> setting.copy(preset = preset.id) } }
    }

    /** Saves [dial]'s Custom values, clamped, so a bad value never reaches the conditioner or the encoder. */
    suspend fun setCustom(dial: Dial, profile: LinkProfile) {
        val clamped = profile.clamped()
        update { it.withDial(dial) { setting -> setting.copy(custom = clamped) } }
    }

    /**
     * Turns the switch off and keeps it off. Both links go direct at once, before
     * the write, so whatever follows (a sign-out's own portal calls) is never
     * conditioned, and the conditioned client's idle connections are closed.
     * Turning off while already off writes nothing.
     */
    suspend fun turnOff() {
        InternetTestRoutes.internet = null
        InternetTestRoutes.local = null
        InternetTestRoutes.evictPortal()
        update { if (it.enabled || it.armedAtMs != null) it.copy(enabled = false, armedAtMs = null) else it }
    }

    /** Call at the very start of any sign-out, before its portal calls. */
    suspend fun beforeSignOut() = turnOff()

    /** Call when the move lock drops the saved setup (MoveSetupGuard). */
    suspend fun onSetupDropped() = turnOff()

    /**
     * Starts the routing and every automatic turn-off rule in [scope]. Call it once.
     *
     * - Routing: the active profiles are installed only while the switch is on,
     *   not expired, and [auth] is [AuthState.Authed]; otherwise both links go direct.
     * - [auth] turning [AuthState.Anon] (a session ending, or a start-up restore
     *   that finds nobody) turns the switch off. [AuthState.Loading] doesn't.
     * - [devMode] turning false turns it off.
     * - Each [setupCleared] emission (a portal Clear Setup) turns it off.
     * - Two hours after switch-on it turns off, and a switch found past its two
     *   hours (or armed after the device clock's "now") turns off at once.
     */
    fun start(auth: StateFlow<AuthState>, devMode: Flow<Boolean>, setupCleared: Flow<String>) {
        scope.launch {
            combine(stored, auth) { s, a -> if (a is AuthState.Authed) s else null }.collect { s ->
                if (s != null && s.enabled && !isExpired(s.armedAtMs, clock())) {
                    install(s.activeProfile(Dial.INTERNET), s.activeProfile(Dial.LOCAL))
                } else {
                    install(internet = null, local = null)
                }
            }
        }
        scope.launch {
            auth.collect { if (it is AuthState.Anon) turnOff() }
        }
        scope.launch {
            devMode.distinctUntilChanged().collect { on -> if (!on) turnOff() }
        }
        // Undispatched, so a clear announced right after start() is never missed
        // (the heartbeat's flow keeps no replay).
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            setupCleared.collect { turnOff() }
        }
        scope.launch {
            stored.map { s -> s?.takeIf { it.enabled }?.let { Armed(it.armedAtMs) } }
                .distinctUntilChanged()
                .collectLatest { armed -> if (armed != null) expireOnTime(armed.atMs) }
        }
    }

    /** When the switch turns itself off, or null while it is off. */
    fun turnsOffAtMs(): Long? = settings.value.takeIf { it.enabled }?.armedAtMs?.let(::turnsOffAtMs)

    /**
     * Waits out the two hours of a switch armed at [armedAtMs], then turns it off.
     * The wait is checked against the wall clock at least once a minute, so a
     * clock moved forward past the two hours, or back past the switch-on, ends
     * the test within a minute rather than at the original deadline.
     */
    private suspend fun expireOnTime(armedAtMs: Long?) {
        while (true) {
            val now = clock()
            if (armedAtMs == null || isExpired(armedAtMs, now)) return turnOff()
            delay(minOf(turnsOffAtMs(armedAtMs) - now, RECHECK_MS))
        }
    }

    /**
     * Puts the profiles in force for the next call or connection. A change to
     * the Internet profile closes the conditioned client's idle connections, so
     * none set up under one preset carries over into another.
     */
    private fun install(internet: LinkProfile?, local: LinkProfile?) {
        val internetChanged = InternetTestRoutes.internet != internet
        InternetTestRoutes.internet = internet
        InternetTestRoutes.local = local
        if (internetChanged) InternetTestRoutes.evictPortal()
    }

    /** Applies [change] to the saved settings in one write, and writes nothing when it changes nothing. */
    private suspend fun update(change: (InternetTestSettings) -> InternetTestSettings) {
        store.edit { prefs ->
            val current = InternetTestSettings.decode(prefs[KEY])
            val next = change(current)
            if (next != current) prefs[KEY] = next.encode()
        }
    }

    private fun InternetTestSettings.withDial(dial: Dial, change: (DialSetting) -> DialSetting) = when (dial) {
        Dial.INTERNET -> copy(internet = change(internet))
        Dial.LOCAL -> copy(local = change(local))
    }

    /** The switch-on time the timer waits on; null inside means on but never armed, which counts as expired. */
    private data class Armed(val atMs: Long?)

    private companion object {
        val KEY = stringPreferencesKey("ss.kiosk.netTest")

        /** The longest the timer waits before it looks at the wall clock again. */
        const val RECHECK_MS = 60_000L
    }
}
