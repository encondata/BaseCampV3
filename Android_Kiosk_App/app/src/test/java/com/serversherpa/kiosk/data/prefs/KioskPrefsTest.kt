package com.serversherpa.kiosk.data.prefs

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.settings.CheckpointId
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.DEFAULT_SOUND_SETTINGS
import com.serversherpa.kiosk.core.settings.SoundChoice
import com.serversherpa.kiosk.core.setup.SetupState
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class KioskPrefsTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var prefs: KioskPrefs

    @Before fun setUp() {
        scope = CoroutineScope(Dispatchers.IO + Job())
        prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "t.preferences_pb") })
    }

    @After fun tearDown() { scope.cancel() }

    @Test fun defaultsWhenEmpty() = runBlocking {
        assertEquals(SetupState.INCOMPLETE, prefs.setupState.first())
        assertNull(prefs.setupSelection.first())
        assertEquals(DEFAULT_APPEARANCE, prefs.appearance.first())
        assertEquals(DEFAULT_SOUND_SETTINGS, prefs.sound.first())
        assertEquals("pre_stage", prefs.checkpoint(CheckpointId.ENROLL).first())
        assertEquals(false, prefs.devMode.first())
        assertNull(prefs.apiUrl.first())
        assertNull(prefs.serial.first())
    }

    @Test fun roundTrips() = runBlocking {
        prefs.setSetupState(SetupState.COMPLETE)
        val sel = KioskSetupSelection("i", "Move", "s", "Site", "source", "pre_stage", "Pre-stage")
        prefs.setSetupSelection(sel)
        prefs.setAppearance(DEFAULT_APPEARANCE.copy(flashMs = 900))
        prefs.setSound(DEFAULT_SOUND_SETTINGS.copy(good = SoundChoice.None))
        prefs.setCheckpoint(CheckpointId.ENROLL, "received")
        prefs.setDevMode(true)
        prefs.setApiUrl("http://10.0.2.2:8000")
        prefs.setSerial("kiosk-android-x"); prefs.setName("Dock 4")
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())
        assertEquals(sel, prefs.setupSelection.first())
        assertEquals(900, prefs.appearance.first().flashMs)
        assertEquals(SoundChoice.None, prefs.sound.first().good)
        assertEquals("received", prefs.checkpoint(CheckpointId.ENROLL).first())
        assertEquals(true, prefs.devMode.first())
        assertEquals("http://10.0.2.2:8000", prefs.apiUrl.first())
        assertEquals("kiosk-android-x", prefs.serial.first()); assertEquals("Dock 4", prefs.name.first())
        prefs.setSetupSelection(null); assertNull(prefs.setupSelection.first())
    }
}
