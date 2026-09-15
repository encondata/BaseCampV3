package com.serversherpa.kiosk.ui.screens.login

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PairPoll
import com.serversherpa.kiosk.core.model.PairStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.testIdentity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class PairViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun requestsThenPollsUntilApproved() = runTest {
        val api = FakeKioskApi()
        var polls = 0
        api.pollResult = { if (++polls < 3) PairPoll(PairStatus.PENDING, null) else PairPoll(PairStatus.APPROVED, fakeSession()) }
        val vm = PairViewModel(api, testIdentity(tmp.root, backgroundScope), backgroundScope, clock = { testScheduler.currentTime + 1_000_000_000_000L })
        var approved = false
        vm.request(); runCurrent()
        assertEquals(PairPhase.SHOWING, vm.state.value.phase)
        vm.startPolling { approved = true }
        advanceTimeBy(2_001); runCurrent(); assertEquals(1, polls)
        advanceTimeBy(4_001); runCurrent()
        assertTrue(approved)
        assertEquals("ABCD-1234", formatCode(vm.state.value.pair!!.code))
    }

    @Test fun deniedAndRateLimited() = runTest {
        val api = FakeKioskApi().apply { pollResult = { PairPoll(PairStatus.DENIED, null) } }
        val vm = PairViewModel(api, testIdentity(tmp.root, backgroundScope), backgroundScope, clock = { testScheduler.currentTime + 1_000_000_000_000L })
        vm.request(); runCurrent(); vm.startPolling {}; advanceTimeBy(2_001); runCurrent()
        assertEquals(PairPhase.DENIED, vm.state.value.phase)
        api.pairCreated = { throw ApiError(429, "pair_rate_limited") }
        vm.request(); runCurrent()
        assertEquals(PairPhase.ERROR, vm.state.value.phase)
        assertEquals("too many codes requested — wait a few minutes", vm.state.value.error)
    }
}
