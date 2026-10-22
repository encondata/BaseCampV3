package com.serversherpa.kiosk.data.station

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.data.api.MemorySecretStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StationStatusTest {
    private val home = "https://api.example.com:443"
    private val keys = StationKeyStore(MemorySecretStore())
    private val status = StationStatus(keys, apiBase = { "$home/" }, io = Dispatchers.Unconfined)

    /** A punch still running under the old key answers 401 after a new key was issued: the new
     *  key stays (iOS TimeclockStation's clear-if-same rule). */
    @Test fun aLate401UnderAnOldKeyLeavesANewOne() = runBlocking {
        keys.put("new", home)
        status.failed(ApiError(401, "station_key_invalid"), key = "old")
        assertEquals("new", keys.get(home))
        status.failed(ApiError(403, "wrong_station_type"), key = "old")
        assertEquals("new", keys.get(home))
    }

    @Test fun a401UnderTheStoredKeyDropsIt() = runBlocking {
        keys.put("k1", home)
        status.failed(ApiError(401, "station_key_invalid"), key = "k1")
        assertNull(keys.get(home))
        keys.put("k2", home)
        status.failed(ApiError(403, "wrong_station_type"), key = "k2")
        assertNull(keys.get(home))
    }

    @Test fun notRegisteredPausesAndKeepsTheKey() = runBlocking {
        keys.put("k1", home)
        status.failed(ApiError(403, "kiosk_not_registered"), key = "k1")
        assertEquals(true, status.paused.value)
        assertEquals("k1", keys.get(home))
    }
}
