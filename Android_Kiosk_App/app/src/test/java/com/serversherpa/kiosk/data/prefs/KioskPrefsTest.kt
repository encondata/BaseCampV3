package com.serversherpa.kiosk.data.prefs

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
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

    /** A selection saved before the Top/Front step has no labelKind: it reads as "top". */
    @Test fun aSelectionSavedBeforeTheLabelStepReadsAsTop() = runBlocking {
        val raw = """{"initiativeId":"i","initiativeName":"Move","siteId":"s","siteName":"Site","siteRole":"source","scanStatus":"pre_stage","scanLabel":"Pre-stage"}"""
        androidx.datastore.preferences.core.PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "old.preferences_pb") }.let { store ->
            store.edit { it[stringPreferencesKey("ss.kiosk.setup")] = raw }
            val sel = KioskPrefs(store).setupSelection.first()
            assertEquals("top", sel?.labelKind)
            // and as a regular kiosk, with every move field as saved
            assertNull(sel?.stationType); assertEquals("i", sel?.initiativeId); assertEquals("pre_stage", sel?.scanStatus)
        }
    }

    /** A printer saved before Bluetooth has only `host`: it loads as the same network printer and
     *  the offsets and peel beside it survive (a decode failure would fall back to fresh settings). */
    @Test fun aPrinterSavedBeforeBluetoothLoadsAsNetwork() = runBlocking {
        val raw = """{"printer":{"host":"10.0.0.5","model":"ZD421","serial":"X","dpi":203},"offsetX":3,"offsetY":-2,"peel":true}"""
        val store = PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "old-printer.preferences_pb") }
        store.edit { it[stringPreferencesKey("ss.kiosk.labels")] = raw }
        val labels = KioskPrefs(store).labels.first()
        assertEquals(SavedPrinter("10.0.0.5", "ZD421", "X", 203), labels.printer)
        assertEquals(PrinterConnection.Network("10.0.0.5"), labels.printer?.connection)
        assertEquals(3, labels.offsetX); assertEquals(-2, labels.offsetY); assertEquals(true, labels.peel)
    }

    @Test fun aBluetoothPrinterRoundTripsThroughThePrefs() = runBlocking {
        val bt = SavedPrinter(PrinterConnection.Bluetooth("D8J224508535", "C4:7B:A3:00:11:22"), "ZD421", "D8J224508535", 300)
        prefs.updateLabels { it.copy(printer = bt, offsetX = 5) }
        val labels = prefs.labels.first()
        assertEquals(bt, labels.printer); assertEquals(5, labels.offsetX)
        // the old `host` key is there, blank, for an older build
        assertEquals(true, prefs.snapshot()[stringPreferencesKey("ss.kiosk.labels")]?.contains(""""host":"""""))
    }

    @Test fun aTimeclockStationSelectionRoundTrips() = runBlocking {
        val sel = KioskSetupSelection(siteId = "s", siteName = "Dallas", siteRole = "other", stationType = "timeclock")
        prefs.setSetupSelection(sel)
        val back = prefs.setupSelection.first()
        assertEquals(sel, back); assertNull(back?.initiativeId); assertNull(back?.scanStatus)
    }

    @Test fun labelKindRoundTripsInTheSelection() = runBlocking {
        val sel = KioskSetupSelection("i", "Move", "s", "Site", "source", "pre_stage", "Pre-stage", labelKind = "front")
        prefs.setSetupSelection(sel)
        assertEquals("front", prefs.setupSelection.first()?.labelKind)
    }

    /** Same stored shape as the web kiosk's setupClear.ts: all three fields, even at their defaults. */
    @Test fun setupClearIsStoredWithAllThreeFields() = runBlocking {
        prefs.applySetupClear("x1")
        assertEquals("""{"id":"x1","acked":false,"notice":true}""", prefs.snapshot()[stringPreferencesKey("ss.kiosk.setupClear")])
        prefs.settleSetupClearAck(sentAck = "x1", replyId = null); prefs.dismissSetupClearNotice()
        assertEquals("""{"id":"x1","acked":true,"notice":false}""", prefs.snapshot()[stringPreferencesKey("ss.kiosk.setupClear")])
        assertEquals(SetupClearRecord("x1", acked = true, notice = false), prefs.setupClear.first())
    }
}
