package com.serversherpa.kiosk.input.camera

/** Multi-read mode: each distinct barcode is published once per sheet open. */
class MultiReadSession {
    private val seen = LinkedHashSet<String>()
    private val order = ArrayList<String>()

    val count: Int get() = seen.size
    /** Newest first, at most five. */
    val recent: List<String> get() = order.asReversed().take(5)

    fun offer(value: String): Boolean {
        val v = value.trim()
        if (v.isEmpty() || !seen.add(v)) return false
        order.add(v)
        return true
    }
}
