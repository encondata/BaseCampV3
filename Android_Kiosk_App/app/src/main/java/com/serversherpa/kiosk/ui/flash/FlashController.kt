package com.serversherpa.kiosk.ui.flash

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class FlashState(val id: Int, val argb: Int, val ms: Int)

/** kiosk/src/lib/flash.ts: one overlay for the whole kiosk; a newer flash owns the screen. */
class FlashController(private val scope: CoroutineScope) {
    private val _state = MutableStateFlow<FlashState?>(null)
    val state: StateFlow<FlashState?> = _state
    private var nextId = 0
    private var timer: Job? = null

    fun flash(argb: Int, ms: Int) {
        timer?.cancel()
        val mine = FlashState(++nextId, argb, ms)
        _state.value = mine
        timer = scope.launch {
            delay(ms.toLong())
            if (_state.value?.id == mine.id) _state.value = null
        }
    }

    fun clear() { timer?.cancel(); _state.value = null }
}
