package com.serversherpa.kiosk.ui.screens.timeclock.flow

import com.serversherpa.kiosk.core.model.KioskTimeclockPerson
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/** kiosk/src/timeclock/flow.test.ts, case for case. */
class TimeclockFlowTest {
    private val off = KioskTimeclockStatus(KioskTimeclockPerson("p-1", "Alex Worker"), clocked_in = false)
    private val on = off.copy(clocked_in = true)

    private val network = "Can't reach the portal. Your punch was not recorded. Try again."
    private val other = "Something went wrong. Your punch was not recorded. Try again."
    private val changed = "Your status changed. Please choose again."

    private fun at(step: TcStep, mode: TcMode = TcMode.STATION, over: TcState.() -> TcState = { this }): TcState =
        initialState(mode).copy(step = step, status = off).over()

    // ---- constants ----

    @Test fun pinsTheTimers() {
        assertEquals(20_000L, IDLE_MS)
        assertEquals(8_000L, DONE_MS)
        assertEquals(3_000L, PRINTING_MS)
        assertEquals(5_000L, MESSAGE_MS)
        assertEquals(1_500L, SCAN_QUIET_MS)
        assertEquals(10_000L, READ_TIMEOUT_MS)
    }

    @Test fun startsOnWelcomeInStationModeAndNameInKioskMode() {
        assertEquals(TcStep.WELCOME, startStep(TcMode.STATION))
        assertEquals(TcStep.NAME, startStep(TcMode.KIOSK))
        assertEquals(
            TcState(step = TcStep.WELCOME, status = null, busy = false, error = null, notice = null, punched = null),
            initialState(TcMode.STATION),
        )
        assertEquals(TcStep.NAME, initialState(TcMode.KIOSK).step)
    }

    // ---- reducer ----

    @Test fun enterNameGoesFromWelcomeToNameAndNowhereElse() {
        assertEquals(TcStep.NAME, reduce(at(TcStep.WELCOME), TcEvent.EnterName, TcMode.STATION).step)
        val confirm = at(TcStep.CONFIRM)
        assertSame(confirm, reduce(confirm, TcEvent.EnterName, TcMode.STATION))
    }

    @Test fun identifiedStoresTheStatusAndGoesToConfirmClearingErrorNoticeAndPunched() {
        val s = reduce(
            at(TcStep.NAME) { copy(error = "x", notice = "y", punched = Punched.IN, busy = true) },
            TcEvent.Identified(on), TcMode.STATION,
        )
        assertEquals(TcState(TcStep.CONFIRM, on, busy = false, error = null, notice = null, punched = null), s)
    }

    @Test fun confirmNoAndBackFromConfirmReturnToName() {
        assertEquals(TcStep.NAME, reduce(at(TcStep.CONFIRM), TcEvent.ConfirmNo, TcMode.STATION).step)
        assertEquals(TcStep.NAME, reduce(at(TcStep.CONFIRM), TcEvent.Back, TcMode.STATION).step)
    }

    @Test fun backFromNameGoesToWelcomeInStationModeAndIsANoOpInKioskMode() {
        assertEquals(TcStep.WELCOME, reduce(at(TcStep.NAME), TcEvent.Back, TcMode.STATION).step)
        val kiosk = at(TcStep.NAME, TcMode.KIOSK)
        assertEquals(kiosk, reduce(kiosk, TcEvent.Back, TcMode.KIOSK))
    }

    @Test fun confirmYesGoesToAction() {
        assertEquals(TcStep.ACTION, reduce(at(TcStep.CONFIRM), TcEvent.ConfirmYes, TcMode.STATION).step)
    }

    @Test fun chooseOutGoesToClockOutOnlyWhenClockedIn() {
        assertEquals(TcStep.CLOCK_OUT, reduce(at(TcStep.ACTION) { copy(status = on) }, TcEvent.ChooseOut, TcMode.STATION).step)
        val off = at(TcStep.ACTION)
        assertEquals(off, reduce(off, TcEvent.ChooseOut, TcMode.STATION))
    }

    @Test fun chooseInWhenNotClockedInStaysOnActionAndGoesBusy() {
        val s = reduce(at(TcStep.ACTION), TcEvent.ChooseIn, TcMode.STATION)
        assertEquals(TcStep.ACTION, s.step)
        assertEquals(true, s.busy)
    }

    @Test fun chooseInIsIgnoredWhenAlreadyClockedIn() {
        val on = at(TcStep.ACTION) { copy(status = on) }
        assertEquals(on, reduce(on, TcEvent.ChooseIn, TcMode.STATION))
    }

    @Test fun punchStartedSetsBusyAndClearsTheError() {
        val s = reduce(at(TcStep.CLOCK_OUT) { copy(status = on, error = "x") }, TcEvent.PunchStarted, TcMode.STATION)
        assertEquals(TcStep.CLOCK_OUT, s.step)
        assertEquals(true, s.busy)
        assertNull(s.error)
    }

    @Test fun punchSucceededInGoesToBadgeOutGoesToDone() {
        val inn = reduce(at(TcStep.ACTION) { copy(busy = true) }, TcEvent.PunchSucceeded(on, Punched.IN), TcMode.STATION)
        assertEquals(TcStep.BADGE, inn.step); assertEquals(on, inn.status); assertEquals(Punched.IN, inn.punched)
        assertEquals(false, inn.busy); assertNull(inn.error)
        val out = reduce(at(TcStep.CLOCK_OUT) { copy(status = on, busy = true) }, TcEvent.PunchSucceeded(off, Punched.OUT), TcMode.STATION)
        assertEquals(TcStep.DONE, out.step); assertEquals(off, out.status); assertEquals(Punched.OUT, out.punched)
        assertEquals(false, out.busy)
    }

    @Test fun punchFailedAlreadyOrNotClockedInReturnsToActionWithANotice() {
        for (code in listOf("already_clocked_in", "not_clocked_in")) {
            val s = reduce(at(TcStep.CLOCK_OUT) { copy(status = on, busy = true) }, TcEvent.PunchFailed(code), TcMode.STATION)
            assertEquals(code, TcStep.ACTION, s.step)
            assertEquals(code, false, s.busy)
            assertEquals(code, changed, s.notice)
            assertNull(code, s.error)
        }
    }

    @Test fun statusRefreshedReplacesTheStatusAndKeepsTheNotice() {
        val s = reduce(at(TcStep.ACTION) { copy(notice = changed) }, TcEvent.StatusRefreshed(on), TcMode.STATION)
        assertEquals(TcStep.ACTION, s.step); assertEquals(on, s.status); assertEquals(changed, s.notice); assertEquals(false, s.busy)
    }

    @Test fun punchFailedNetworkOrEdgeOfflineSaysThePortalIsUnreachable() {
        for (code in listOf("network", "edge_offline")) {
            val s = reduce(at(TcStep.ACTION) { copy(busy = true) }, TcEvent.PunchFailed(code), TcMode.STATION)
            assertEquals(code, TcStep.ACTION, s.step); assertEquals(code, false, s.busy); assertEquals(code, network, s.error)
        }
    }

    @Test fun punchFailedWithAnyOtherCodeIsTheGenericErrorAndStaysOnTheStep() {
        val s = reduce(at(TcStep.CLOCK_OUT) { copy(status = on, busy = true) }, TcEvent.PunchFailed("boom"), TcMode.STATION)
        assertEquals(TcStep.CLOCK_OUT, s.step); assertEquals(false, s.busy); assertEquals(other, s.error)
    }

    @Test fun punchFailedCloudSignInAndReadOnlyHaveTheirOwnMessages() {
        val cases = listOf(
            "cloud_sign_in_required" to "Sign in again while online to do this.",
            "read_only_mode" to "The portal is in read-only mode. Your punch was not recorded. Try again shortly.",
        )
        for ((code, text) in cases) {
            assertEquals(code, text, reduce(at(TcStep.ACTION) { copy(busy = true) }, TcEvent.PunchFailed(code), TcMode.STATION).error)
        }
    }

    @Test fun aGenericPunchFailedClearsAnEarlierNotice() {
        val s = reduce(at(TcStep.ACTION) { copy(busy = true, notice = changed) }, TcEvent.PunchFailed("network"), TcMode.STATION)
        assertEquals(false, s.busy); assertEquals(network, s.error); assertNull(s.notice)
    }

    @Test fun punchStartingEventsWhileBusyAreIgnoredSoADoubleTapNeverSendsTwoPunches() {
        val cases = listOf(
            TcEvent.ChooseIn to at(TcStep.ACTION) { copy(busy = true) },
            TcEvent.ChooseOut to at(TcStep.ACTION) { copy(status = on, busy = true) },
            TcEvent.PunchStarted to at(TcStep.CLOCK_OUT) { copy(status = on, busy = true) },
        )
        for ((event, busy) in cases) assertSame(event.toString(), busy, reduce(busy, event, TcMode.STATION))
    }

    @Test fun badgeBranches() {
        assertEquals(TcStep.PRINTING, reduce(at(TcStep.BADGE), TcEvent.BadgeNew, TcMode.STATION).step)
        assertEquals(TcStep.VERIFY, reduce(at(TcStep.PRINTING), TcEvent.PrintingDone, TcMode.STATION).step)
        assertEquals(TcStep.DONE, reduce(at(TcStep.VERIFY), TcEvent.VerifyContinue, TcMode.STATION).step)
        assertEquals(TcStep.DONE, reduce(at(TcStep.BADGE), TcEvent.BadgeExisting, TcMode.STATION).step)
    }

    @Test fun backFromActionGoesToConfirmAndFromClockOutToAction() {
        assertEquals(TcStep.CONFIRM, reduce(at(TcStep.ACTION), TcEvent.Back, TcMode.STATION).step)
        assertEquals(TcStep.ACTION, reduce(at(TcStep.CLOCK_OUT) { copy(status = on) }, TcEvent.Back, TcMode.STATION).step)
    }

    @Test fun backFromBadgeStaysOnBadge() {
        val s = at(TcStep.BADGE) { copy(punched = Punched.IN) }
        assertEquals(s, reduce(s, TcEvent.Back, TcMode.STATION))
    }

    @Test fun resetReturnsToTheInitialStateForTheMode() {
        assertEquals(initialState(TcMode.STATION), reduce(at(TcStep.DONE) { copy(punched = Punched.OUT) }, TcEvent.Reset, TcMode.STATION))
        assertEquals(initialState(TcMode.KIOSK), reduce(at(TcStep.DONE, TcMode.KIOSK) { copy(punched = Punched.OUT) }, TcEvent.Reset, TcMode.KIOSK))
    }
}
