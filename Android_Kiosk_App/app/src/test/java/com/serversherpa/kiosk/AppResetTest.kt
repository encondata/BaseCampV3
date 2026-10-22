package com.serversherpa.kiosk

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.labels.LabelBuildNeed
import com.serversherpa.kiosk.core.labels.LabelBuildPhase
import com.serversherpa.kiosk.core.labels.LabelBuildStatus
import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.outbox.OutboxMachine
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.db.GeneratedLabelEntity
import com.serversherpa.kiosk.data.db.LabelFontEntity
import com.serversherpa.kiosk.data.db.LabelTemplateEntity
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.fakeSession
import java.io.File
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppResetTest {
    private val selection = KioskSetupSelection("i1", "Move A", "s1", "Dallas", "source", "packed", "Packed", labelKind = "front")
    private val fontsDir get() = File(ApplicationProvider.getApplicationContext<Application>().filesDir, "label-fonts")

    /** A set-up, signed-in kiosk with a printer, a synced move, its labels and fonts, and one unsent scan. */
    private fun setUpKiosk(): AppContainer {
        val c = testContainer()
        runBlocking {
            c.prefs.setSetupSelection(selection)
            c.prefs.setSetupState(SetupState.COMPLETE)
            c.labelSettings.setPrinter(SavedPrinter("10.0.0.5", "ZD421", "S1", 300))
            c.labelSettings.setOffsets(12, -4)
            c.labelSettings.setPeel(true)
            c.prefs.setName("Dock 4")
            c.prefs.setSerial("K-123")
            c.prefs.setDevMode(true)
            c.db.assets().insertAll(listOf(KioskAssetRow("a1", "A-1", make_model = "X").toEntity()))
            c.db.labelTemplates().insertAll(listOf(LabelTemplateEntity("t1", "{}")))
            c.db.labelFonts().insertAll(listOf(LabelFontEntity("f1", "ROBOTO.TTF", 4, resident = false, fileName = "f1.ttf")))
            c.db.generatedLabels().upsert(listOf(GeneratedLabelEntity("a1", "^XA^XZ", "ok", "fp", "t1")))
            c.db.outbox().upsert(listOf(OutboxMachine.newRow(EnqueueInput("A-1", "barcode", null, "s1", "i1", "packed"), "c1", 1, 0).toEntity()))
        }
        fontsDir.mkdirs()
        File(fontsDir, "f1.ttf").writeText("font")
        c.auth.completePair(fakeSession())
        return c
    }

    @Test fun resetClearsTheSetupLabelsAndMoveDataButKeepsScansSignInAndKiosk() = runBlocking<Unit> {
        val c = setUpKiosk()

        c.resetApp()

        assertNull(c.prefs.setupSelection.first())
        assertEquals(SetupState.INCOMPLETE, c.prefs.setupState.first())
        assertEquals(LabelSettings(), c.labelSettings.settings.first())
        assertEquals(LabelKind.TOP, c.labelSettings.settings.first().kind)
        assertEquals(0, c.db.assets().count())
        assertEquals(0, c.db.labelTemplates().count())
        assertEquals(0, c.db.labelFonts().count())
        assertTrue(c.db.generatedLabels().all().isEmpty())
        assertEquals(emptyList<String>(), fontsDir.listFiles()?.map { it.name } ?: emptyList<String>())
        // Kept: the unsent scan, the sign-in, the server and the kiosk's identity and preferences.
        assertEquals(listOf("c1"), c.db.outbox().all().map { it.clientScanId })
        assertTrue(c.auth.state.value is AuthState.Authed)
        assertEquals("http://127.0.0.1:1", c.prefs.apiUrl.first())
        assertEquals("Dock 4", c.prefs.name.first())
        assertEquals("K-123", c.prefs.serial.first())
        assertTrue(c.prefs.devMode.first())
        // The label builder ends stopped, waiting for a sync.
        withTimeout(5_000) { c.labelBuilder.status.first { it == LabelBuildStatus(LabelBuildPhase.IDLE, needs = LabelBuildNeed.SYNC) } }
        assertNull(c.labelBuilder.pick.value)
    }

    @Test fun aFailedClearLeavesTheSetupAsItWas() = runBlocking<Unit> {
        val c = setUpKiosk()

        try {
            c.resetApp(clearLocalData = { throw java.io.IOException("disk full") })
            fail("the reset should have failed")
        } catch (e: java.io.IOException) {
            assertEquals("disk full", e.message)
        }

        assertEquals(selection, c.prefs.setupSelection.first())
        assertEquals(SetupState.COMPLETE, c.prefs.setupState.first())
        assertEquals(SavedPrinter("10.0.0.5", "ZD421", "S1", 300), c.labelSettings.settings.first().printer)
    }
}
