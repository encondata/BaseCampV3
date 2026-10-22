package com.serversherpa.kiosk.data.labels

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class LabelSettingsStoreTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var prefs: KioskPrefs
    private lateinit var store: LabelSettingsStore
    private val printer = SavedPrinter("10.0.0.7", "ZD421", "D4J123456", 203)

    @Before fun setUp() {
        scope = CoroutineScope(Dispatchers.IO + Job())
        prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "l.preferences_pb") })
        store = LabelSettingsStore(prefs)
    }

    @After fun tearDown() { scope.cancel() }

    private fun selection(kind: String? = null) =
        if (kind == null) KioskSetupSelection("i", "Move", "s", "Site", "source", "pre_stage", "Pre-stage")
        else KioskSetupSelection("i", "Move", "s", "Site", "source", "pre_stage", "Pre-stage", labelKind = kind)

    @Test fun defaultsWhenNothingIsSaved() = runBlocking {
        assertEquals(LabelSettings(), store.settings.first())
    }

    @Test fun roundTripsPrinterOffsetsAndPeel() = runBlocking {
        store.setPrinter(printer)
        store.setOffsets(-12, 30)
        store.setPeel(true)
        assertEquals(LabelSettings(LabelKind.TOP, printer, -12, 30, true), store.settings.first())
        store.setPrinter(null)
        assertEquals(LabelSettings(LabelKind.TOP, null, -12, 30, true), store.settings.first())
    }

    @Test fun eachSetterKeepsTheOtherFields() = runBlocking {
        store.setPrinter(printer); store.setPeel(true); store.setOffsets(5, 6)
        val s = store.settings.first()
        assertEquals(printer, s.printer); assertEquals(true, s.peel); assertEquals(5 to 6, s.offsetX to s.offsetY)
    }

    @Test fun theKindComesFromTheSetupSelection() = runBlocking {
        prefs.setSetupSelection(selection("front"))
        assertEquals(LabelKind.FRONT, store.settings.first().kind)
        prefs.setSetupSelection(selection("top"))
        assertEquals(LabelKind.TOP, store.settings.first().kind)
    }

    @Test fun noSelectionReadsAsTop() = runBlocking {
        prefs.setSetupSelection(selection("front")); prefs.setSetupSelection(null)
        assertEquals(LabelKind.TOP, store.settings.first().kind)
    }

    @Test fun theFirstValueIsTheStoredOneNotTheDefaults() = runBlocking {
        prefs.setSetupSelection(selection("front")); store.setPrinter(printer)
        // A fresh store over the same file: the first emission already carries everything.
        val first = withTimeout(5_000) { LabelSettingsStore(prefs).settings.first() }
        assertEquals(LabelSettings(LabelKind.FRONT, printer), first)
    }

    @Test fun unrelatedWritesDoNotRepeatTheSettings() = runBlocking {
        val seen = java.util.concurrent.CopyOnWriteArrayList<LabelSettings>()
        val job = scope.launch { store.settings.collect { seen += it } }
        fun waitFor(n: Int) { val end = System.currentTimeMillis() + 5_000; while (seen.size < n && System.currentTimeMillis() < end) Thread.sleep(10) }
        waitFor(1)
        store.setPeel(true); waitFor(2)
        prefs.setDevMode(true); prefs.setName("Dock 4")
        store.setPeel(false); waitFor(3)
        Thread.sleep(200)
        job.cancel()
        assertEquals(listOf(LabelSettings(), LabelSettings(peel = true), LabelSettings()), seen.toList())
    }
}
