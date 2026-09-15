package com.serversherpa.kiosk.input

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

enum class ScanSource { KEYBOARD, DATAWEDGE, CAMERA }

data class ScanEvent(val value: String, val source: ScanSource, val symbology: String? = null)

/** Every scan source ends here; the screen on top collects. Values are
 *  trimmed and blanks dropped so no screen has to repeat that. */
class ScanBus {
    private val _events = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<ScanEvent> = _events

    fun publish(event: ScanEvent) {
        val value = event.value.trim()
        if (value.isEmpty()) return
        _events.tryEmit(event.copy(value = value))
    }
}
