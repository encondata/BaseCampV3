package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RepeatSweepPolicy
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `FakeRfidReader` refuses `startInventory()`/`apply()` unless it is
 * `Connected`, and throws from `emitTrigger`/`emitTag` if nothing is
 * collecting yet — the same as a real sled, which delivers no trigger events
 * at all before it is connected. So every test that drives a trigger connects
 * the fake first (`r.controller.connectNow()`), and always after
 * `r.controller.start()` has been settled, so the controller's collectors are
 * already subscribed when the emission lands.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RfidControllerTest {
    /** The controller's collectors live in backgroundScope, which
     *  advanceUntilIdle() does not drive. Each hop needs a runCurrent(). */
    private fun kotlinx.coroutines.test.TestScope.settle() { repeat(5) { runCurrent() } }

    private class Rig(val scope: kotlinx.coroutines.CoroutineScope) {
        val reader = FakeRfidReader()
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true))
        var now = 0L
        val controller = RfidController(reader, settings, scope) { now }
    }

    @Test fun aHeldTriggerRunsAnInventoryAndQueuesItsTagsOnRelease() = runTest {
        val r = Rig(backgroundScope)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()

        r.reader.emitTrigger(TriggerEvent.PRESSED); settle()
        assertTrue("inventory should be running", r.reader.inventoryRunning)
        assertEquals(0, r.controller.session.value?.uniqueCount)

        r.reader.emitTag("100348"); r.reader.emitTag("100349"); r.reader.emitTag("100348"); settle()
        assertEquals(3, r.controller.session.value?.totalReads)
        assertEquals(2, r.controller.session.value?.uniqueCount)

        r.now = 1_200
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()
        assertEquals(false, r.reader.inventoryRunning)
        assertNull("the panel closes when the burst ends", r.controller.session.value)
        assertEquals(listOf(listOf("100348", "100349")), bursts)
    }

    /** The rule the whole app follows: a read never lands on a screen that is
     *  not on top. Only the Scanning screen arms this. Disarmed, the trigger
     *  is short-circuited before the controller ever calls the reader, so no
     *  connection is needed for this one — the point is that nothing happens
     *  at all. */
    @Test fun aTriggerDoesNothingWhileDisarmed() = runTest {
        val r = Rig(backgroundScope)
        r.controller.start(); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); settle()
        assertEquals(false, r.reader.inventoryRunning)
        assertNull(r.controller.session.value)
    }

    @Test fun leavingTheScreenStopsAReadInProgress() = runTest {
        val r = Rig(backgroundScope)
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100348"); settle()
        r.controller.disarm(); settle()
        assertEquals(false, r.reader.inventoryRunning)
        assertNull(r.controller.session.value)
    }

    @Test fun theStopButtonEndsALatchedReadAndStillQueues() = runTest {
        val r = Rig(backgroundScope)
        r.settings.value = DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerMode = RfidTriggerMode.TOGGLE)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()

        r.reader.emitTrigger(TriggerEvent.PRESSED); settle()
        r.reader.emitTag("100350"); settle()
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()
        assertTrue("toggle keeps reading after the trigger comes up", r.reader.inventoryRunning)

        r.controller.stopBurst(); settle()
        assertEquals(false, r.reader.inventoryRunning)
        assertEquals(listOf(listOf("100350")), bursts)
    }

    @Test fun aSecondSweepSkipsTagsAlreadySentWhenThePolicySaysSo() = runTest {
        val r = Rig(backgroundScope)
        r.settings.value = DEFAULT_RFID_SETTINGS.copy(enabled = true, repeatPolicy = RepeatSweepPolicy.SKIP_AND_COUNT)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()

        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100348"); settle()
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100348"); r.reader.emitTag("100351"); settle()
        assertEquals(1, r.controller.session.value?.skippedRepeats)
        r.reader.emitTrigger(TriggerEvent.RELEASED); settle()

        assertEquals(listOf(listOf("100348"), listOf("100351")), bursts)
    }

    @Test fun aDisconnectMidBurstStillQueuesWhatWasRead() = runTest {
        val r = Rig(backgroundScope)
        val bursts = mutableListOf<List<String>>()
        backgroundScope.launch { r.controller.bursts.collect { bursts += it } }
        r.controller.start(); r.controller.arm(); settle()
        r.controller.connectNow(); settle()
        r.reader.emitTrigger(TriggerEvent.PRESSED); r.reader.emitTag("100348"); settle()

        r.reader.setConnection(RfidConnection.Failed("The reader disconnected.")); settle()
        assertNull(r.controller.session.value)
        assertEquals(listOf(listOf("100348")), bursts)
    }

    @Test fun settingsReachTheReaderOnConnectAndOnEveryChange() = runTest {
        val r = Rig(backgroundScope)
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals(27, r.reader.applied?.powerDbm)

        r.settings.value = RfidSettings(enabled = true, powerDbm = 12); settle()
        assertEquals(12, r.reader.applied?.powerDbm)
        assertNull("a setting the reader took leaves no complaint", r.controller.applyError.value)
    }

    /** A reader that refuses a setting must say so rather than leaving the
     *  operator looking at a number the radio never took. */
    @Test fun aSettingTheReaderRefusesIsReported() = runTest {
        val r = Rig(backgroundScope)
        r.reader.applyResult = Result.failure(IllegalStateException("Power out of range."))
        r.controller.start(); settle()
        r.controller.connectNow(); settle()
        assertEquals("Power out of range.", r.controller.applyError.value)
    }
}
