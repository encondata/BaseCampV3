package com.serversherpa.kiosk.data.station

import com.serversherpa.kiosk.data.api.MemorySecretStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StationKeyStoreTest {
    private val secrets = MemorySecretStore()
    private val store = StationKeyStore(secrets)

    @Test fun emptyUntilPut() = assertNull(store.get())

    @Test fun putGetClearUnderTheStationKeyAccount() {
        store.put("k3y")
        assertEquals("k3y", store.get())
        assertEquals("k3y", secrets.get("station_key"))
        store.put("n3w")
        assertEquals("n3w", store.get())
        store.clear()
        assertNull(store.get()); assertNull(secrets.get("station_key"))
    }

    @Test fun clearLeavesOtherSecretsAlone() {
        secrets.put("ss_refresh", "r1")
        store.put("k3y"); store.clear()
        assertEquals("r1", secrets.get("ss_refresh"))
    }

    @Test fun aBlankKeyReadsAsNone() {
        secrets.put("station_key", "  ")
        assertNull(store.get())
    }
}
