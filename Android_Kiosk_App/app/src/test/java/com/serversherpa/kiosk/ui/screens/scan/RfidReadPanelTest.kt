package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.onTagRead
import com.serversherpa.kiosk.core.rfid.startSession
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class RfidReadPanelTest {
    @get:Rule val compose = createComposeRule()

    private fun session(vararg epcs: String, queued: Set<String> = emptySet(), policy: RepeatSweepPolicy = RepeatSweepPolicy.ALWAYS_QUEUE) =
        epcs.fold(startSession(0)) { s, e -> onTagRead(s, e, queued, policy) }

    @Test fun showsUniqueAndTotalAndTheTagsItHasSeen() {
        compose.setContent {
            KioskTheme { RfidReadPanel(session("100348", "100349", "100348"), showSkipped = false, onStop = {}) }
        }
        compose.onNodeWithText("2").assertIsDisplayed()          // unique
        compose.onNodeWithText("3 reads").assertIsDisplayed()    // total
        compose.onNodeWithText("100349").assertIsDisplayed()     // newest first
    }

    @Test fun countsSkippedRepeatsOnlyWhenThePolicyAsksForIt() {
        val s = session("100348", "100350", queued = setOf("100348"), policy = RepeatSweepPolicy.SKIP_AND_COUNT)
        assertEquals(1, s.skippedRepeats)
        compose.setContent { KioskTheme { RfidReadPanel(s, showSkipped = true, onStop = {}) } }
        compose.onNodeWithText("1 already sent").assertIsDisplayed()
    }

    @Test fun theStopButtonReportsBack() {
        var stopped = 0
        compose.setContent { KioskTheme { RfidReadPanel(session("100348"), showSkipped = false, onStop = { stopped++ }) } }
        compose.onNodeWithText("Stop").performClick()
        assertEquals(1, stopped)
    }

    @Test fun aBurstThatHasFoundNothingYetStillReadsAsReading() {
        compose.setContent { KioskTheme { RfidReadPanel(startSession(0), showSkipped = false, onStop = {}) } }
        compose.onNodeWithText("Reading…").assertIsDisplayed()
        compose.onNodeWithText("0").assertIsDisplayed()
    }
}
