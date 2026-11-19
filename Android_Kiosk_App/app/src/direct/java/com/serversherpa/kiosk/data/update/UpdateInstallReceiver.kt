package com.serversherpa.kiosk.data.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.core.content.IntentCompat
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/** The PackageInstaller session's status; only this app's own PendingIntent reaches it. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = InstallEvents.onStatus(context, intent)
}

sealed interface InstallEvent {
    data class Failed(val message: String) : InstallEvent
    data object Canceled : InstallEvent
}

/** Installer outcomes for the update state machine, and the confirm screen held while the app is in the back. */
object InstallEvents {
    private val _events = MutableSharedFlow<InstallEvent>(extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events: SharedFlow<InstallEvent> = _events.asSharedFlow()

    /** DirectAppUpdates keeps it in sync with the app being in front. */
    @Volatile var foreground: Boolean = false

    /** The system's confirm screen, kept until the app is back in front. */
    @Volatile var pendingConfirm: Intent? = null

    /** Returns the pending confirm screen and clears it. */
    @Synchronized fun takePendingConfirm(): Intent? = pendingConfirm.also { pendingConfirm = null }

    /** The receiver's whole body. */
    fun onStatus(context: Context, intent: Intent) {
        if (!intent.hasExtra(PackageInstaller.EXTRA_STATUS)) return
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) ?: return
                pendingConfirm = confirm
                if (foreground) {
                    val now = takePendingConfirm() ?: return
                    try {
                        context.startActivity(now.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (e: RuntimeException) {
                        // Nothing could open it: keep it for the return to the front. (A background start the
                        // system refuses doesn't throw; it's dropped silently, and the return-to-front path
                        // recovers by ending the install with a notice instead of staying in Installing.)
                        pendingConfirm = now
                    }
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Unit   // the new build replaces this process
            PackageInstaller.STATUS_FAILURE_ABORTED -> _events.tryEmit(InstallEvent.Canceled)
            else -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: status.toString()
                _events.tryEmit(InstallEvent.Failed("The install didn't finish: $message"))
            }
        }
    }

    internal fun resetForTest() {
        foreground = false
        pendingConfirm = null
    }
}
