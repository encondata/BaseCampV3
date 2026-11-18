package com.serversherpa.kiosk.data.update

import com.serversherpa.kiosk.core.update.NO_DEVICES_HOST
import com.serversherpa.kiosk.core.update.UpdateAnswer
import com.serversherpa.kiosk.core.update.UpdateOffer
import com.serversherpa.kiosk.core.update.shouldRecheck
import com.serversherpa.kiosk.data.auth.AuthState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.CoroutineContext

/** Wraps client.check(pkg, code, digest); the factory turns an ApiError into UpdateError(checkFailureMessage(e, host)). */
fun interface UpdateChecker {
    suspend fun check(): UpdateAnswer
}

/** Where the offered APK comes from; [clear] deletes whatever was fetched. */
interface ApkSource {
    suspend fun fetch(offer: UpdateOffer, onProgress: (Float?) -> Unit): File
    fun clear()
}

private const val CHECK_FAILED = "Couldn't check for updates. Try again later."
private const val INSTALLS_OFF = "Installs from this app are off. Turn on Allow from this source, then tap Update."
private const val INSTALL_CANCELED = "Install canceled."
private const val DOWNLOAD_FAILED = "The download failed. Try again."
private const val INSTALL_FAILED = "The install failed. Try again."
private const val INSTALL_UNFINISHED = "The install didn't finish. Tap Update to try again."

/**
 * The direct build's update check: checks once signed in and in front (again on return after an
 * hour), downloads and hands the APK to the system installer. One check or update at a time.
 */
class DirectAppUpdates(
    private val checker: UpdateChecker,
    private val source: ApkSource,
    private val installer: ApkInstall,
    private val packageName: String,
    private val authState: StateFlow<AuthState>,
    private val foreground: StateFlow<Boolean>,
    private val scope: CoroutineScope,
    private val events: Flow<InstallEvent> = InstallEvents.events,
    private val clock: () -> Long = System::currentTimeMillis,
    /** File work: clearing, the archive check and the installer copy. */
    private val io: CoroutineContext = Dispatchers.IO,
) : AppUpdates {
    override val supported = true

    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    override val state: StateFlow<UpdateState> = _state.asStateFlow()
    private val _banner = MutableStateFlow(false)
    override val homeBannerVisible: StateFlow<Boolean> = _banner.asStateFlow()

    private val lock = Any()
    private var started = false
    @Volatile private var lastCheckAt: Long? = null   // read by the trigger collector outside [lock]
    private var checking: Job? = null
    private var working: Job? = null      // download through the installer hand-off
    private var clearing: Job? = null
    private var awaitingPermission = false
    private var offerCheckedAt = 0L       // checkedAt of the Available state the download started from
    private var snoozedBuild: Long? = null
    private var snoozedMessage: String? = null

    override fun start() {
        synchronized(lock) {
            if (started) return
            started = true
            clearing = scope.launch(io) { clearQuietly() }
        }
        scope.launch { events.collect(::onInstallEvent) }
        scope.launch {
            var inFront = false
            combine(authState, foreground, ::Pair).collect { (auth, front) ->
                InstallEvents.foreground = front
                if (front && !inFront) onReturnToFront()
                inFront = front
                if (front && auth is AuthState.Authed && shouldRecheck(lastCheckAt, clock())) check(background = true)
            }
        }
    }

    override fun check() = check(background = false)

    /**
     * A [background] recheck from an offer or a Blocked message keeps that state (and the Home
     * banner) until the answer arrives; only the Check for updates button shows Checking.
     */
    private fun check(background: Boolean) {
        synchronized(lock) {
            if (authState.value !is AuthState.Authed) return
            val before = _state.value
            if (checking?.isActive == true || working?.isActive == true || before is UpdateState.Installing) return
            lastCheckAt = clock()
            val quiet = background && (before is UpdateState.Available || before is UpdateState.Blocked)
            if (!quiet) set(UpdateState.Checking)
            val shown = _state.value
            checking = scope.launch {
                val next = answer()
                // An Update tapped during a quiet recheck owns the state now: drop the answer.
                synchronized(lock) { if (_state.value === shown) set(next) }
            }
        }
    }

    override fun update() {
        val from: UpdateState.Available
        synchronized(lock) {
            from = _state.value as? UpdateState.Available ?: return
            if (working?.isActive == true) return
            if (installer.canRequestInstalls()) {
                download(from)
                return
            }
            awaitingPermission = true
        }
        try {
            installer.openInstallPermissionSettings()
        } catch (e: RuntimeException) {
            // No settings screen to open: say so rather than wait for a return that never comes.
            synchronized(lock) {
                awaitingPermission = false
                if (_state.value == from) set(from.copy(notice = INSTALLS_OFF))
            }
        }
    }

    override fun later() {
        synchronized(lock) {
            when (val s = _state.value) {
                is UpdateState.Available -> snoozedBuild = s.offer.build
                is UpdateState.Downloading -> snoozedBuild = s.offer.build
                is UpdateState.Installing -> snoozedBuild = s.offer.build
                is UpdateState.Blocked -> snoozedMessage = s.message
                else -> return
            }
            set(_state.value)
        }
    }

    private suspend fun answer(): UpdateState = try {
        val answer = checker.check()
        val at = clock()
        when (answer) {
            UpdateAnswer.UpToDate -> UpdateState.UpToDate(at)
            is UpdateAnswer.Available -> UpdateState.Available(answer.offer, at)
            is UpdateAnswer.Blocked ->
                if (answer.message == NO_DEVICES_HOST) UpdateState.Unavailable(answer.message)
                else UpdateState.Blocked(answer.message, at)
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: UpdateError) {
        UpdateState.Failed(e.message ?: CHECK_FAILED, clock())
    } catch (e: Exception) {
        UpdateState.Failed(CHECK_FAILED, clock())
    }

    /** Call with [lock] held. */
    private fun download(from: UpdateState.Available) {
        val offer = from.offer
        offerCheckedAt = from.checkedAtMillis
        set(UpdateState.Downloading(offer, null))
        working = scope.launch {
            clearing?.join()
            val file = try {
                source.fetch(offer) { fraction ->
                    synchronized(lock) { if (_state.value is UpdateState.Downloading) set(UpdateState.Downloading(offer, fraction)) }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: UpdateError) {
                return@launch backTo(offer, e.message ?: DOWNLOAD_FAILED)
            } catch (e: Exception) {
                return@launch backTo(offer, DOWNLOAD_FAILED)
            }
            try {
                val refusal = withContext(io) { installer.checkArchive(file, packageName, offer.build, offer.versionName) }
                if (refusal != null) {
                    clearFiles()
                    return@launch backTo(offer, refusal)
                }
                // Installing before the hand-off, so an installer event during it finds the state it belongs to.
                synchronized(lock) { set(UpdateState.Installing(offer)) }
                withContext(io) { installer.install(file) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                clearFiles()
                backTo(offer, INSTALL_FAILED)
            }
        }
    }

    private suspend fun onInstallEvent(event: InstallEvent) {
        if (_state.value !is UpdateState.Installing) return
        clearFiles()
        leaveInstalling(when (event) {
            InstallEvent.Canceled -> INSTALL_CANCELED
            is InstallEvent.Failed -> event.message
        })
    }

    private suspend fun onReturnToFront() {
        val current = _state.value
        if (current is UpdateState.Installing) {
            // While the hand-off still runs, the installer hasn't asked for a confirm yet.
            if (working?.isActive != true) {
                val notice = try {
                    // No confirm waiting and no event coming (e.g. Home from the confirm screen): don't stay stuck.
                    if (installer.launchPendingConfirm()) null else INSTALL_UNFINISHED
                } catch (e: RuntimeException) {
                    INSTALL_FAILED
                }
                if (notice != null) {
                    clearFiles()
                    leaveInstalling(notice)
                }
            }
        } else {
            InstallEvents.takePendingConfirm()   // left from an install that's no longer under way
        }
        synchronized(lock) {
            if (!awaitingPermission) return
            awaitingPermission = false
            val from = _state.value as? UpdateState.Available ?: return
            if (installer.canRequestInstalls()) download(from) else set(from.copy(notice = INSTALLS_OFF))
        }
    }

    private suspend fun clearFiles() = withContext(io) { clearQuietly() }

    /** A failed delete must not crash the app or end event collection; the next start() tries again. */
    private fun clearQuietly() {
        runCatching { source.clear() }
    }

    private fun backTo(offer: UpdateOffer, notice: String) {
        synchronized(lock) { set(UpdateState.Available(offer, offerCheckedAt, notice)) }
    }

    /** Back to the offer being installed, unless something else already moved the state on. */
    private fun leaveInstalling(notice: String) {
        synchronized(lock) {
            val s = _state.value as? UpdateState.Installing ?: return
            set(UpdateState.Available(s.offer, offerCheckedAt, notice))
        }
    }

    /** Call with [lock] held. */
    private fun set(next: UpdateState) {
        _state.value = next
        _banner.value = when (next) {
            is UpdateState.Available -> next.offer.build != snoozedBuild
            is UpdateState.Downloading -> next.offer.build != snoozedBuild
            is UpdateState.Installing -> next.offer.build != snoozedBuild
            is UpdateState.Blocked -> next.message != snoozedMessage
            else -> false
        }
    }
}
