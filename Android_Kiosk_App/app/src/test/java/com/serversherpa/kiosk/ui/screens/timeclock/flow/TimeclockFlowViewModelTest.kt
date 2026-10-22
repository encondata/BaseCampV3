package com.serversherpa.kiosk.ui.screens.timeclock.flow

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskTimeclockPerson
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.ui.flash.FlashController
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private val JIMMY = KioskPersonRow(
    "p1", "Jimmy Henderson", "James", "Henderson", "Jimmy", "000000000000000000100348", true, true,
    badge_uid = "B-UID-1", job_title = "Crew lead", external_id = "E-42",
)
private val TINA = KioskPersonRow("p2", "Tina Timeclock", "Tina", "Timeclock", null, "1003", true, false)

private fun off(id: String) = KioskTimeclockStatus(KioskTimeclockPerson(id, if (id == "p1") "Jimmy Henderson" else "Tina Timeclock"), clocked_in = false)
private fun on(id: String) = off(id).copy(clocked_in = true, today_minutes = 444)

/** Records every call; each answer is a swappable suspend lambda so a test can hold one open. */
class FakeTcBackend : TcBackend {
    val calls = ArrayList<String>()
    var peopleResult: suspend () -> List<KioskPersonRow> = { listOf(JIMMY, TINA) }
    var statusResult: suspend (String) -> KioskTimeclockStatus = { off(it) }
    var clockInResult: suspend (String) -> KioskTimeclockStatus = { on(it) }
    var clockOutResult: suspend (String) -> KioskTimeclockStatus = { off(it) }
    override suspend fun people(): List<KioskPersonRow> { calls += "people"; return peopleResult() }
    override suspend fun status(personId: String): KioskTimeclockStatus { calls += "status:$personId"; return statusResult(personId) }
    override suspend fun clockIn(personId: String): KioskTimeclockStatus { calls += "clockIn:$personId"; return clockInResult(personId) }
    override suspend fun clockOut(personId: String): KioskTimeclockStatus { calls += "clockOut:$personId"; return clockOutResult(personId) }
}

@OptIn(ExperimentalCoroutinesApi::class)
class TimeclockFlowViewModelTest {
    private val unreachable = "Can't reach the portal. Your punch was not recorded. Try again."
    private val changed = "Your status changed. Please choose again."
    private val notFound = "We couldn't find that code."

    private class Rig(val vm: TimeclockFlowViewModel, val backend: FakeTcBackend, val flash: FlashController, val exits: MutableList<Unit>)

    private fun TestScope.rig(
        mode: TcMode = TcMode.KIOSK,
        backend: FakeTcBackend = FakeTcBackend(),
        reloads: MutableSharedFlow<Unit> = MutableSharedFlow(),
    ): Rig {
        val flash = FlashController(backgroundScope)
        val vm = TimeclockFlowViewModel(mode, backend, flash, sound = null, appearance = flowOf(DEFAULT_APPEARANCE), peopleReloads = reloads, scopeOverride = backgroundScope)
        val exits = ArrayList<Unit>()
        backgroundScope.launch { vm.exits.collect { exits += it } }
        runCurrent()
        return Rig(vm, backend, flash, exits)
    }

    private val Rig.step get() = vm.state.value.flow.step
    private val Rig.ui get() = vm.state.value

    /** Name → Jimmy (by badge) → Is this you? → Yes. */
    private fun TestScope.toAction(r: Rig) {
        r.vm.onScan("B-UID-1"); runCurrent()
        assertEquals(TcStep.CONFIRM, r.step)
        r.vm.confirmYes(); runCurrent()
        assertEquals(TcStep.ACTION, r.step)
    }

    // ---- start, people, finding a person ----

    @Test fun kioskModeStartsOnNameAndLoadsThePeople() = runTest {
        val r = rig()
        assertEquals(TcStep.NAME, r.step)
        assertEquals(listOf("people"), r.backend.calls)
        assertEquals(2, r.ui.rosterSize)
    }

    @Test fun aTypedBadgeIdentifiesAtOnceButAnAmbiguousPrefixWaits() = runTest {
        val r = rig()
        r.vm.onType("1003"); runCurrent()                // 1003 is also the start of 100348
        assertEquals(TcStep.NAME, r.step)
        assertEquals("1003", r.ui.query)
        r.vm.onType("100348"); runCurrent()
        assertEquals(TcStep.CONFIRM, r.step)
        assertEquals("p1", r.ui.flow.status?.person?.id)
        assertEquals("", r.ui.query)
        assertEquals(hslToArgb(DEFAULT_APPEARANCE.goodScan), r.flash.state.value?.argb)
    }

    @Test fun searchShowsMatchesAndSearchPicksASingleOne() = runTest {
        val r = rig()
        r.vm.onType("hen jim"); runCurrent()
        assertEquals(listOf("p1"), r.ui.results.map { it.id })
        r.vm.onSearch(); runCurrent()
        assertEquals(TcStep.CONFIRM, r.step)
        r.vm.confirmNo(); runCurrent()
        assertEquals(TcStep.NAME, r.step)
        r.vm.onType("nobody"); runCurrent()
        assertTrue(r.ui.noMatches)
        r.vm.onSearch(); runCurrent()
        assertEquals("No one matches that name.", r.ui.shownMessage)
        assertEquals("nobody", r.ui.query)          // a name that matches nobody stays to fix
        assertFalse(r.ui.noMatches)                 // the message replaces the hint
    }

    @Test fun anUnknownQrShowsNotFoundAndTheNotFoundFlashThenClears() = runTest {
        val r = rig()
        r.vm.onScan("ASSET-000123"); runCurrent()
        assertEquals(TcStep.NAME, r.step)
        assertEquals(notFound, r.ui.shownMessage)
        assertEquals(hslToArgb(DEFAULT_APPEARANCE.notFoundScan), r.flash.state.value?.argb)
        assertEquals(listOf("people"), r.backend.calls)      // no status read for a code nobody owns
        advanceTimeBy(MESSAGE_MS - 1); runCurrent()
        assertEquals(notFound, r.ui.shownMessage)
        advanceTimeBy(2); runCurrent()
        assertNull(r.ui.shownMessage)
    }

    @Test fun scansAreIgnoredOffTheTypingSteps() = runTest {
        val r = rig()
        toAction(r)
        r.vm.onScan("1003"); runCurrent()
        assertEquals(TcStep.ACTION, r.step)
        assertEquals("p1", r.ui.flow.status?.person?.id)
    }

    @Test fun aStatusReadThatFailsSaysSoAndStaysOnName() = runTest {
        val backend = FakeTcBackend().apply { statusResult = { throw ApiError(0, "network") } }
        val r = rig(backend = backend)
        r.vm.onScan("B-UID-1"); runCurrent()
        assertEquals(TcStep.NAME, r.step)
        assertEquals("Can't reach the portal. Try again.", r.ui.shownMessage)
        backend.statusResult = { throw ApiError(500, "boom") }
        r.vm.onScan("B-UID-1"); runCurrent()
        assertEquals("Something went wrong. Try again.", r.ui.shownMessage)
    }

    @Test fun aStatusReadTimesOutAfterTenSeconds() = runTest {
        val backend = FakeTcBackend().apply { statusResult = { awaitCancellation() } }
        val r = rig(backend = backend)
        r.vm.onScan("B-UID-1"); runCurrent()
        assertTrue(r.ui.looking)
        advanceTimeBy(READ_TIMEOUT_MS - 1); runCurrent()
        assertTrue(r.ui.looking)
        advanceTimeBy(2); runCurrent()
        assertFalse(r.ui.looking)
        assertEquals("Can't reach the portal. Try again.", r.ui.shownMessage)
    }

    @Test fun aLateStatusAnswerAfterLeavingIsDropped() = runTest {
        val gate = CompletableDeferred<KioskTimeclockStatus>()
        val backend = FakeTcBackend().apply { statusResult = { gate.await() } }
        val r = rig(backend = backend)
        r.vm.onScan("B-UID-1"); runCurrent()
        r.vm.back(); runCurrent()                     // kiosk: Back on Name leaves
        assertEquals(1, r.exits.size)
        gate.complete(off("p1")); runCurrent()
        assertEquals(TcStep.NAME, r.step)
        assertNull(r.ui.flow.status)
    }

    @Test fun noPeopleOnAKioskSaysSyncFromKioskSetup() = runTest {
        val r = rig(backend = FakeTcBackend().apply { peopleResult = { emptyList() } })
        assertEquals("No people on this kiosk. Sync from Kiosk Setup.", r.ui.shownMessage)
    }

    @Test fun aPeopleListThatFailsToLoadSaysSo() = runTest {
        val r = rig(backend = FakeTcBackend().apply { peopleResult = { throw ApiError(0, "network") } })
        assertEquals("Can't load the people list. Try again shortly.", r.ui.shownMessage)
    }

    @Test fun aKioskReloadsThePeopleWhenASyncFinishes() = runTest {
        val reloads = MutableSharedFlow<Unit>()
        val backend = FakeTcBackend()
        val r = rig(backend = backend, reloads = reloads)
        backend.peopleResult = { listOf(JIMMY) }
        reloads.emit(Unit); runCurrent()
        assertEquals(2, backend.calls.count { it == "people" })
        assertEquals(1, r.ui.rosterSize)
    }

    // ---- station mode: Welcome ----

    @Test fun stationModeStartsOnWelcomeAndBackFromNameReturnsThere() = runTest {
        val r = rig(mode = TcMode.STATION)
        assertEquals(TcStep.WELCOME, r.step)
        r.vm.enterName(); runCurrent()
        assertEquals(TcStep.NAME, r.step)
        r.vm.back(); runCurrent()
        assertEquals(TcStep.WELCOME, r.step)
        assertTrue(r.exits.isEmpty())
        // back at the start, the people are read again (new hires all day)
        assertEquals(2, r.backend.calls.count { it == "people" })
        assertNull(r.ui.shownMessage)                        // no "No people" notice on a station
    }

    @Test fun welcomeForgetsAnUnfinishedValueAfterAQuietSpellButSettlesAnExactOne() = runTest {
        val r = rig(mode = TcMode.STATION)
        r.vm.onType("zz"); runCurrent()
        advanceTimeBy(SCAN_QUIET_MS + 1); runCurrent()
        assertEquals("", r.ui.query)
        assertEquals(TcStep.WELCOME, r.step)
        r.vm.onType("1003"); runCurrent()                     // waits: also the start of 100348
        assertEquals(TcStep.WELCOME, r.step)
        advanceTimeBy(SCAN_QUIET_MS + 1); runCurrent()
        assertEquals(TcStep.CONFIRM, r.step)
        assertEquals("p2", r.ui.flow.status?.person?.id)
    }

    @Test fun enterOnWelcomeWithAnUnknownCodeIsNotFoundAndClears() = runTest {
        val r = rig(mode = TcMode.STATION)
        r.vm.onType("nope"); r.vm.onSearch(); runCurrent()
        assertEquals(notFound, r.ui.shownMessage)
        assertEquals("", r.ui.query)
    }

    // ---- timers ----

    @Test fun idleOffTheStartLeavesAfterTwentySecondsAndATouchRestartsIt() = runTest {
        val r = rig()
        advanceTimeBy(IDLE_MS * 2); runCurrent()
        assertTrue("no idle timer on the start step", r.exits.isEmpty())
        r.vm.onScan("B-UID-1"); runCurrent()
        advanceTimeBy(IDLE_MS - 1_000); runCurrent()
        r.vm.onActivity()
        advanceTimeBy(IDLE_MS - 1_000); runCurrent()
        assertEquals(TcStep.CONFIRM, r.step)
        assertTrue(r.exits.isEmpty())
        advanceTimeBy(1_001); runCurrent()
        assertEquals(1, r.exits.size)
        assertEquals(TcStep.NAME, r.step)
        assertNull(r.ui.flow.status)
    }

    /** The system keyboard sends no key events the screen could see: typing itself is activity. */
    @Test fun idleResetsOnTyping() = runTest {
        val r = rig(mode = TcMode.STATION)
        r.vm.enterName(); runCurrent()
        advanceTimeBy(IDLE_MS - 1_000); runCurrent()
        r.vm.onType("S")
        advanceTimeBy(IDLE_MS - 1_000); runCurrent()
        r.vm.onType("Sa")
        advanceTimeBy(IDLE_MS - 1_000); runCurrent()
        assertEquals(TcStep.NAME, r.step)
        advanceTimeBy(1_001); runCurrent()
        assertEquals(TcStep.WELCOME, r.step)
    }

    @Test fun idleOnAStationReturnsToWelcome() = runTest {
        val r = rig(mode = TcMode.STATION)
        r.vm.enterName(); runCurrent()
        advanceTimeBy(IDLE_MS + 1); runCurrent()
        assertEquals(TcStep.WELCOME, r.step)
        assertTrue(r.exits.isEmpty())
    }

    @Test fun allSetLeavesAfterEightSecondsAndIdleDoesNotRunThere() = runTest {
        val backend = FakeTcBackend().apply { statusResult = { on(it) } }
        val r = rig(backend = backend)
        toAction(r)
        r.vm.chooseOut(); runCurrent()
        assertEquals(TcStep.CLOCK_OUT, r.step)
        r.vm.confirmClockOut(); runCurrent()
        assertEquals(TcStep.DONE, r.step)
        advanceTimeBy(DONE_MS - 1); runCurrent()
        assertEquals(TcStep.DONE, r.step)
        assertTrue(r.exits.isEmpty())
        advanceTimeBy(2); runCurrent()
        assertEquals(1, r.exits.size)
        assertEquals(TcStep.NAME, r.step)
        advanceTimeBy(IDLE_MS * 2); runCurrent()
        assertEquals(1, r.exits.size)
    }

    @Test fun printingMovesToVerifyAfterThreeSeconds() = runTest {
        val r = rig()
        toAction(r)
        r.vm.chooseIn(); runCurrent()
        assertEquals(TcStep.BADGE, r.step)
        r.vm.badgeNew(); runCurrent()
        assertEquals(TcStep.PRINTING, r.step)
        advanceTimeBy(PRINTING_MS - 1); runCurrent()
        assertEquals(TcStep.PRINTING, r.step)
        advanceTimeBy(2); runCurrent()
        assertEquals(TcStep.VERIFY, r.step)
        r.vm.verifyContinue(); runCurrent()
        assertEquals(TcStep.DONE, r.step)
        r.vm.done(); runCurrent()
        assertEquals(1, r.exits.size)
    }

    // ---- punches ----

    @Test fun aSecondTapWhilePunchingIsIgnored() = runTest {
        val gate = CompletableDeferred<KioskTimeclockStatus>()
        val backend = FakeTcBackend().apply { clockInResult = { gate.await() } }
        val r = rig(backend = backend)
        toAction(r)
        r.vm.chooseIn(); r.vm.chooseIn(); r.vm.retry(); runCurrent()
        r.vm.chooseIn(); runCurrent()
        assertEquals(1, backend.calls.count { it.startsWith("clockIn") })
        assertTrue(r.ui.busy)
        r.vm.back(); runCurrent()
        assertEquals("Back waits for the punch", TcStep.ACTION, r.step)
        gate.complete(on("p1")); runCurrent()
        assertEquals(TcStep.BADGE, r.step)
        assertEquals(Punched.IN, r.ui.flow.punched)
        assertEquals(1, backend.calls.count { it.startsWith("clockIn") })
    }

    @Test fun aPunchNeverTimesOut() = runTest {
        val gate = CompletableDeferred<KioskTimeclockStatus>()
        val backend = FakeTcBackend().apply { clockInResult = { gate.await() } }
        val r = rig(backend = backend)
        toAction(r)
        r.vm.chooseIn(); runCurrent()
        repeat(3) { advanceTimeBy(READ_TIMEOUT_MS); r.vm.onActivity() }
        runCurrent()
        assertTrue(r.ui.busy)
        assertNull(r.ui.flow.error)
        gate.complete(on("p1")); runCurrent()
        assertEquals(TcStep.BADGE, r.step)
    }

    @Test fun a409ReturnsToActionWithTheNoticeAndRereadsTheStatus() = runTest {
        val backend = FakeTcBackend().apply {
            statusResult = { on(it) }
            clockOutResult = { throw ApiError(409, "not_clocked_in") }
        }
        val r = rig(backend = backend)
        toAction(r)
        r.vm.chooseOut(); runCurrent()
        backend.statusResult = { off(it) }                   // someone clocked them out elsewhere
        r.vm.confirmClockOut(); runCurrent()
        assertEquals(TcStep.ACTION, r.step)
        assertEquals(changed, r.ui.flow.notice)
        assertNull(r.ui.flow.error)
        assertEquals(listOf("status:p1", "clockOut:p1", "status:p1"), backend.calls.drop(1))
        assertEquals(false, r.ui.flow.status?.clocked_in)
        assertFalse(r.ui.busy)
        assertEquals(hslToArgb(DEFAULT_APPEARANCE.notFoundScan), r.flash.state.value?.argb)
    }

    @Test fun aNetworkFailureKeepsThePersonAndTryAgainRereadsTheStatusFirst() = runTest {
        val backend = FakeTcBackend().apply { clockInResult = { throw ApiError(0, "network") } }
        val r = rig(backend = backend)
        toAction(r)
        r.vm.chooseIn(); runCurrent()
        assertEquals(TcStep.ACTION, r.step)
        assertEquals(unreachable, r.ui.flow.error)
        assertFalse(r.ui.busy)
        backend.clockInResult = { on(it) }
        r.vm.retry(); runCurrent()
        assertEquals(listOf("status:p1", "clockIn:p1", "status:p1", "clockIn:p1"), backend.calls.drop(1))
        assertEquals(TcStep.BADGE, r.step)
        assertNull(r.ui.flow.error)
    }

    @Test fun tryAgainAfterAPunchThatLandedAnywayDoesNotPunchTwice() = runTest {
        val backend = FakeTcBackend().apply { clockInResult = { throw ApiError(0, "network") } }
        val r = rig(backend = backend)
        toAction(r)
        r.vm.chooseIn(); runCurrent()
        backend.statusResult = { on(it) }                    // the dropped POST was recorded
        r.vm.retry(); runCurrent()
        assertEquals(1, backend.calls.count { it.startsWith("clockIn") })
        assertEquals(TcStep.BADGE, r.step)
        assertEquals(Punched.IN, r.ui.flow.punched)
    }

    @Test fun tryAgainWhileStillOfflineShowsTheErrorAgainWithoutPunching() = runTest {
        val backend = FakeTcBackend().apply {
            statusResult = { on(it) }
            clockOutResult = { throw ApiError(0, "network") }
        }
        val r = rig(backend = backend)
        toAction(r)
        r.vm.chooseOut(); r.vm.confirmClockOut(); runCurrent()
        assertEquals(TcStep.CLOCK_OUT, r.step)
        backend.statusResult = { throw ApiError(0, "network") }
        r.vm.retry(); runCurrent()
        assertEquals(1, backend.calls.count { it.startsWith("clockOut") })
        assertEquals(unreachable, r.ui.flow.error)
        assertEquals(TcStep.CLOCK_OUT, r.step)
        assertFalse(r.ui.busy)
    }

    @Test fun aClockOutPunchesTheClockOutRouteAndEndsOnAllSetWithTheFirstName() = runTest {
        val backend = FakeTcBackend().apply { statusResult = { on(it) } }
        val r = rig(backend = backend)
        toAction(r)
        r.vm.chooseIn(); runCurrent()
        assertEquals("Clock In is dimmed for someone already in", 0, backend.calls.count { it.startsWith("clockIn") })
        r.vm.chooseOut(); r.vm.confirmClockOut(); runCurrent()
        assertEquals(TcStep.DONE, r.step)
        assertEquals("Jimmy", firstNameOf(r.ui.flow.status?.person))
        assertEquals(1, backend.calls.count { it == "clockOut:p1" })
    }
}
