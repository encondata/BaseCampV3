package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PairCreated
import com.serversherpa.kiosk.core.model.PairStatus
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.LinkButton
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.theme.FragmentMono
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

const val POLL_MS = 2_000L

enum class PairPhase { REQUESTING, SHOWING, DENIED, EXPIRED, ERROR }

data class PairUi(val phase: PairPhase = PairPhase.REQUESTING, val pair: PairCreated? = null, val error: String = "", val remainingSec: Long = 0)

class PairViewModel(
    private val api: KioskApi,
    private val identity: Identity,
    scopeOverride: CoroutineScope? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val scope = scopeOverride ?: viewModelScope
    private val _state = MutableStateFlow(PairUi())
    val state: StateFlow<PairUi> = _state
    private var generation = 0
    private var pollJob: Job? = null

    fun request() {
        val mine = ++generation
        pollJob?.cancel()
        _state.value = PairUi(PairPhase.REQUESTING)
        scope.launch {
            try {
                val (serial, name) = identity.get()
                val created = api.createPairRequest(serial, name)
                if (mine != generation) return@launch
                _state.value = PairUi(PairPhase.SHOWING, created, remainingSec = remaining(created))
            } catch (e: Exception) {
                if (mine != generation) return@launch
                val code = (e as? ApiError)?.code
                _state.value = PairUi(PairPhase.ERROR, error = when (code) {
                    "pair_rate_limited" -> "too many codes requested — wait a few minutes"
                    "network" -> "network error"
                    else -> "server error"
                })
            }
        }
    }

    private fun remaining(p: PairCreated): Long = try {
        maxOf(0L, (Instant.parse(p.expires_at).toEpochMilli() - clock()) / 1000)
    } catch (e: Exception) { 0L }

    /** Polls every 2 s while SHOWING; the countdown ticks each second. */
    fun startPolling(onApproved: (SessionData) -> Unit) {
        pollJob?.cancel()
        val mine = generation
        pollJob = scope.launch {
            var nextPoll = clock() + POLL_MS
            while (true) {
                delay(1_000)
                val ui = _state.value
                val pair = ui.pair
                if (mine != generation || ui.phase != PairPhase.SHOWING || pair == null) return@launch
                val left = remaining(pair)
                _state.update { it.copy(remainingSec = left) }
                if (left <= 0) { _state.update { it.copy(phase = PairPhase.EXPIRED) }; return@launch }
                if (clock() < nextPoll) continue
                nextPoll = clock() + POLL_MS
                try {
                    val result = api.pollPair(pair.code, pair.poll_token)
                    when (result.status) {
                        PairStatus.APPROVED -> if (result.session != null) { onApproved(result.session); return@launch }
                        PairStatus.DENIED -> { _state.update { it.copy(phase = PairPhase.DENIED) }; return@launch }
                        PairStatus.EXPIRED -> { _state.update { it.copy(phase = PairPhase.EXPIRED) }; return@launch }
                        PairStatus.PENDING -> Unit
                    }
                } catch (e: Exception) { /* transient — next tick retries */ }
            }
        }
    }

    /** Stops the poll loop immediately (e.g. the Link view was left). */
    fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
        generation++
    }
}

@Composable
fun PairPanel(vm: PairViewModel, portalUrl: String, onApproved: (SessionData) -> Unit) {
    val ui by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.request() }
    LaunchedEffect(ui.phase, ui.pair?.code) { if (ui.phase == PairPhase.SHOWING) vm.startPolling(onApproved) }
    DisposableEffect(Unit) { onDispose { vm.stopPolling() } }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        when (ui.phase) {
            PairPhase.REQUESTING -> Text("Getting a code…", style = MaterialTheme.typography.bodyMedium)
            PairPhase.ERROR -> { KioskToast("Couldn't get a code (${ui.error}). Try again.", error = true); SolidButton("Try again", { vm.request() }) }
            PairPhase.DENIED -> { KioskToast("Sign-in was declined on the phone.", error = true); SolidButton("Get a new code", { vm.request() }) }
            PairPhase.EXPIRED -> { KioskToast("This code expired.", error = true); SolidButton("Get a new code", { vm.request() }) }
            PairPhase.SHOWING -> {
                val pair = ui.pair!!
                val bmp by produceState<ImageBitmap?>(initialValue = null, pair.code) {
                    value = withContext(Dispatchers.Default) { runCatching { qrBitmap(pair.link_url, 440).asImageBitmap() }.getOrNull() }
                }
                if (bmp != null) Image(bmp!!, contentDescription = "QR code to link this kiosk", modifier = Modifier.size(220.dp))
                Text(formatCode(pair.code), fontFamily = FragmentMono, style = MaterialTheme.typography.displaySmall, modifier = Modifier.padding(top = 12.dp))
                Text("Scan the code, or open ${portalHost(portalUrl)}/link on your phone and enter it.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp))
                Text("Expires in ${ui.remainingSec / 60}:${(ui.remainingSec % 60).toString().padStart(2, '0')}", fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 6.dp))
                LinkButton("Get a new code") { vm.request() }
            }
        }
    }
}
