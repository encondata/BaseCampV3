package com.serversherpa.kiosk.data.update

import android.app.Application
import com.serversherpa.kiosk.core.update.UpdateOffer
import com.serversherpa.kiosk.data.api.SessionStore
import com.serversherpa.kiosk.data.auth.AuthState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.OkHttpClient

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data class UpToDate(val checkedAtMillis: Long) : UpdateState
    data class Available(val offer: UpdateOffer, val checkedAtMillis: Long, val notice: String? = null) : UpdateState
    data class Downloading(val offer: UpdateOffer, val fraction: Float?) : UpdateState
    data class Installing(val offer: UpdateOffer) : UpdateState

    /** The server answered with a message instead of an offer (reinstall_required, …). Shown on Home and Settings. */
    data class Blocked(val message: String, val checkedAtMillis: Long) : UpdateState

    /** This kiosk can't check (no devices host for its API URL). Settings only. */
    data class Unavailable(val message: String) : UpdateState
    data class Failed(val message: String, val checkedAtMillis: Long) : UpdateState
}

/** The in-app update check. The Play build gets [NoAppUpdates]; the direct build a real one. */
interface AppUpdates {
    val supported: Boolean
    val state: StateFlow<UpdateState>
    val homeBannerVisible: StateFlow<Boolean>
    fun start()
    fun check()
    fun update()
    fun later()
}

object NoAppUpdates : AppUpdates {
    override val supported = false
    override val state: StateFlow<UpdateState> = MutableStateFlow(UpdateState.Idle)
    override val homeBannerVisible: StateFlow<Boolean> = MutableStateFlow(false)
    override fun start() {}
    override fun check() {}
    override fun update() {}
    override fun later() {}
}

class UpdateDeps(
    val app: Application,
    val client: OkHttpClient,
    val session: SessionStore,
    val apiUrl: suspend () -> String,
    val authState: StateFlow<AuthState>,
    val foreground: StateFlow<Boolean>,
    val scope: CoroutineScope,
)
