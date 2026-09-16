package com.serversherpa.kiosk.data.identity

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class IdentityTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var identity: Identity

    @Before fun setUp() {
        scope = CoroutineScope(Dispatchers.IO + Job())
        identity = Identity(KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "t.preferences_pb") }))
    }

    @After fun tearDown() { scope.cancel() }

    @Test fun serialIsGeneratedOnceAndStable() = runBlocking {
        val a = identity.get()
        val b = identity.get()
        assertTrue(a.serial.startsWith("kiosk-android-"))
        assertEquals(a.serial, b.serial)
        assertEquals("Kiosk " + a.serial.takeLast(4).uppercase(), a.name)
    }

    @Test fun nameValidation() = runBlocking {
        identity.get()
        assertFalse(identity.setName("   "))
        assertFalse(identity.setName("x".repeat(81)))
        assertTrue(identity.setName("  Dock 4 "))
        assertEquals("Dock 4", identity.get().name)
    }

    @Test fun helpers() {
        assertEquals("Kiosk AB12", defaultName("kiosk-android-0000-ab12"))
        assertTrue(newSerial().matches(Regex("kiosk-android-[0-9a-f-]{36}")))
    }
}
