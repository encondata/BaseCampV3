package com.serversherpa.kiosk.ui.screens.setup

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.serversherpa.kiosk.data.sync.PartState
import com.serversherpa.kiosk.data.sync.SYNC_PARTS
import com.serversherpa.kiosk.data.sync.SyncPart
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.data.sync.SyncStatus
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class SyncSummaryTest {
    @get:Rule val compose = createComposeRule()

    private fun parts(vararg states: Pair<String, SyncPart>): List<SyncPart> {
        val by = states.toMap()
        return SYNC_PARTS.map { by[it] ?: SyncPart(it, PartState.WAITING) }
    }
    private fun done(templates: Int? = 4, fonts: Int? = 2, templatesState: PartState = PartState.DONE, fontsState: PartState = PartState.DONE) = SyncStatus(
        SyncPhase.DONE, 10, 3, 2, 1, "2026-10-21T14:14:00Z",
        parts = parts(
            "assets" to SyncPart("assets", PartState.DONE, 10), "people" to SyncPart("people", PartState.DONE, 3),
            "containers" to SyncPart("containers", PartState.DONE, 2), "trucks" to SyncPart("trucks", PartState.DONE, 1),
            "templates" to SyncPart("templates", templatesState, templates.takeIf { templatesState == PartState.DONE }),
            "fonts" to SyncPart("fonts", fontsState, fonts.takeIf { fontsState == PartState.DONE }),
        ),
    )

    @Test fun localDataLineAddsTemplatesAndFontsWhenSynced() {
        val line = localDataLine(done())
        assertEquals("Local data: 10 assets · 3 people · 2 containers · 1 trucks · 4 label templates · 2 fonts", line.substringBefore(" · synced"))
        org.junit.Assert.assertTrue(" · synced " in line)
    }

    @Test fun localDataLineSaysSingularAndSkipsPartsThatAreNotDone() {
        val one = localDataLine(done(templates = 1, fonts = 1)).substringBefore(" · synced")
        assertEquals("Local data: 10 assets · 3 people · 2 containers · 1 trucks · 1 label template · 1 font", one)
        // Never synced (after the version 2 upgrade) or failed: no label counts at all.
        val waiting = localDataLine(done(templatesState = PartState.WAITING, fontsState = PartState.WAITING)).substringBefore(" · synced")
        assertEquals("Local data: 10 assets · 3 people · 2 containers · 1 trucks", waiting)
        val failed = localDataLine(done(templatesState = PartState.FAILED, fontsState = PartState.FAILED)).substringBefore(" · synced")
        assertEquals("Local data: 10 assets · 3 people · 2 containers · 1 trucks", failed)
    }

    @Test fun partLinesCoverEveryPartInOrderWithItsState() {
        val running = SyncStatus(SyncPhase.RUNNING, parts = parts(
            "assets" to SyncPart("assets", PartState.DONE, 10), "people" to SyncPart("people", PartState.RUNNING),
            "containers" to SyncPart("containers", PartState.FAILED),
        ))
        assertEquals(
            listOf("Assets · done (10)", "People · downloading…", "Containers · failed", "Trucks · waiting", "Label templates · waiting", "Fonts · waiting"),
            partLines(running).map { it.text },
        )
        assertEquals(listOf("Assets", "People", "Containers", "Trucks", "Label templates", "Fonts"), partLines(running).map { it.label })
        assertEquals(listOf(PartState.DONE, PartState.RUNNING, PartState.FAILED, PartState.WAITING, PartState.WAITING, PartState.WAITING), partLines(running).map { it.state })
    }

    @Test fun labelsWarningNamesTheStepThatFailed() {
        assertNull(labelsWarning(done()))
        assertEquals("Label templates couldn't be downloaded. Labels may be out of date.",
            labelsWarning(done(templatesState = PartState.FAILED).copy(labelsError = "network")))
        assertEquals("Fonts couldn't be downloaded. Labels may be out of date.",
            labelsWarning(done(fontsState = PartState.FAILED).copy(labelsError = "network")))
        assertEquals("Label templates and fonts couldn't be downloaded. Labels may be out of date.",
            labelsWarning(done(templatesState = PartState.FAILED, fontsState = PartState.FAILED).copy(labelsError = "network")))
        // An error code with no failed part still warns.
        assertEquals("Label data couldn't be downloaded. Labels may be out of date.", labelsWarning(done().copy(labelsError = "x")))
    }

    @Test fun runningShowsEachPartsState() {
        val st = SyncStatus(SyncPhase.RUNNING, parts = parts("assets" to SyncPart("assets", PartState.DONE, 10), "people" to SyncPart("people", PartState.RUNNING)))
        compose.setContent { KioskTheme { SyncSection(st, onSync = {}) } }
        compose.onNodeWithText("Downloading move data…").assertIsDisplayed()
        compose.onNodeWithText("Assets · done (10)").assertIsDisplayed()
        compose.onNodeWithText("People · downloading…").assertIsDisplayed()
        compose.onNodeWithText("Fonts · waiting").assertIsDisplayed()
    }

    @Test fun doneShowsTheCountsAndTheLabelsWarning() {
        val st = done(templatesState = PartState.FAILED).copy(labelsError = "network")
        compose.setContent { KioskTheme { SyncSection(st, onSync = {}) } }
        compose.onNodeWithText("Local data: 10 assets", substring = true).assertIsDisplayed()
        compose.onNodeWithText("2 fonts", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Label templates couldn't be downloaded. Labels may be out of date.").assertIsDisplayed()
        compose.onNodeWithText("Sync again").assertIsDisplayed()
    }

    @Test fun idleAndErrorKeepTheirButtons() {
        compose.setContent { KioskTheme { SyncSection(SyncStatus(), onSync = {}) } }
        compose.onNodeWithText("No move data on this kiosk yet.").assertIsDisplayed()
        compose.onNodeWithText("Sync now").assertIsDisplayed()
    }
}
