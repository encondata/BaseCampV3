package com.serversherpa.kiosk.data.station

import com.serversherpa.kiosk.data.api.MemorySecretStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StationKeyStoreTest {
    private val secrets = MemorySecretStore()
    private val store = StationKeyStore(secrets)
    private val home = "https://api.example.com:443"

    @Test fun emptyUntilPut() = assertNull(store.get(home))

    @Test fun putGetClearUnderTheStationKeyAccount() {
        store.put("k3y", home)
        assertEquals("k3y", store.get(home))
        assertEquals("k3y", secrets.get("station_key"))
        assertEquals(home, secrets.get("station_key_origin"))
        store.put("n3w", home)
        assertEquals("n3w", store.get(home))
        store.clear()
        assertNull(store.get(home)); assertNull(secrets.get("station_key")); assertNull(secrets.get("station_key_origin"))
    }

    @Test fun clearLeavesOtherSecretsAlone() {
        secrets.put("ss_refresh", "r1")
        store.put("k3y", home); store.clear()
        assertEquals("r1", secrets.get("ss_refresh"))
    }

    @Test fun aBlankKeyReadsAsNone() {
        secrets.put("station_key", "  ")
        assertNull(store.get(home))
    }

    /** The key never leaves for another server: asked for under another origin, it is cleared. */
    @Test fun aKeyAskedForUnderAnotherOriginIsCleared() {
        store.put("k3y", home)
        assertNull(store.get("https://evil.example.com:443"))
        assertNull(secrets.get("station_key"))
        assertEquals(false, store.present.value)
        assertNull(store.get(home))                                    // gone for good
    }

    @Test fun aKeyWithNoRecordedOriginIsCleared() {
        secrets.put("station_key", "legacy")
        assertNull(store.get(home))
        assertNull(secrets.get("station_key"))
    }

    @Test fun keepOnlyForClearsAnotherOriginsKeyAndKeepsItsOwn() {
        store.put("k3y", home)
        store.keepOnlyFor(home)
        assertEquals("k3y", store.get(home))
        store.keepOnlyFor("http://10.0.0.5:8000")
        assertNull(secrets.get("station_key"))
    }
}
