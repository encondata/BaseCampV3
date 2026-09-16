package com.serversherpa.kiosk.data.identity

import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

const val NAME_MAX = 80

data class KioskIdentity(val serial: String, val name: String)

fun newSerial(): String = "kiosk-android-${UUID.randomUUID()}"

fun defaultName(serial: String): String = "Kiosk ${serial.takeLast(4).uppercase()}"

/** Who this kiosk is: a serial generated once, and a friendly name. */
class Identity(private val prefs: KioskPrefs) {
    private val mutex = Mutex()

    /** Generates and persists the serial the first time it is asked for. */
    suspend fun get(): KioskIdentity {
        val serial = prefs.serial.first() ?: mutex.withLock {
            prefs.serial.first() ?: newSerial().also { prefs.setSerial(it) }
        }
        val stored = prefs.name.first()?.trim()
        return KioskIdentity(serial, if (stored.isNullOrEmpty()) defaultName(serial) else stored)
    }

    /** Live identity; emits once a serial exists (call get() at startup). */
    val identity: Flow<KioskIdentity> = combine(prefs.serial, prefs.name) { serial, name ->
        val s = serial ?: ""
        KioskIdentity(s, name?.trim()?.takeIf { it.isNotEmpty() } ?: defaultName(s))
    }

    /** Trims and stores; false when blank or too long. */
    suspend fun setName(name: String): Boolean {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || trimmed.length > NAME_MAX) return false
        prefs.setName(trimmed)
        return true
    }
}
