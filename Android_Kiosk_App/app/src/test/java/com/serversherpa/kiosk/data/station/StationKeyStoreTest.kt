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

    /** A store that dies (the app is killed) on its [dieAt]th write. */
    private class Dying(val inner: MemorySecretStore, val dieAt: Int) : com.serversherpa.kiosk.data.api.SecretStore {
        var writes = 0
        private fun write(block: () -> Unit) { if (++writes == dieAt) throw IllegalStateException("killed"); block() }
        override fun get(key: String) = inner.get(key)
        override fun put(key: String, value: String) = write { inner.put(key, value) }
        override fun remove(key: String) = write { inner.remove(key) }
    }

    /** Re-keying for a new API, killed after any write: the old key is never left bound to the
     *  new origin (and the new key never to the old one). */
    @Test fun aPutKilledHalfwayNeverBindsAKeyToTheWrongOrigin() {
        val other = "https://other.example.com:443"
        for (dieAt in 1..4) {
            val mem = MemorySecretStore().apply { put("station_key", "old"); put("station_key_origin", home) }
            runCatching { StationKeyStore(Dying(mem, dieAt)).put("new", other) }
            val after = { MemorySecretStore().also { c -> for (k in listOf("station_key", "station_key_origin")) mem.get(k)?.let { c.put(k, it) } } }
            val underNew = StationKeyStore(after()).get(other)
            val underOld = StationKeyStore(after()).get(home)
            org.junit.Assert.assertTrue("died at write $dieAt: $underNew handed to the new origin", underNew == null || underNew == "new")
            org.junit.Assert.assertTrue("died at write $dieAt: $underOld handed to the old origin", underOld == null || underOld == "old")
        }
    }
}
