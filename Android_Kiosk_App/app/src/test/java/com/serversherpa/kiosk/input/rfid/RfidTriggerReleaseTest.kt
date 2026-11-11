package com.serversherpa.kiosk.input.rfid

import com.serversherpa.kiosk.core.rfid.DEFAULT_RFID_SETTINGS
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidTriggerMode
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A trigger release with no press before it is ignored entirely (hardware
 * session 2026-11-11, log audit Problem 4): the RFD40 sent press, release and
 * then a second release 708 ms later with no press between. In Hold-or-latch
 * mode the stray release used to measure its hold from the old press and end
 * a latched sweep about 0.7 s after it started. The timings are the log's.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RfidTriggerReleaseTest {
    /** The controller's collectors live in backgroundScope, which
     *  advanceUntilIdle() does not drive. Each hop needs a runCurrent(). */
    private fun TestScope.settle() { repeat(5) { runCurrent() } }

    /** Records the start and stop calls a sweep makes, in order. */
    private class Recorder(private val inner: FakeRfidReader) : RfidReader by inner {
        val calls = CopyOnWriteArrayList<String>()

        override suspend fun startInventory(): Result<Unit> {
            calls += "start"
            return inner.startInventory()
        }

        override suspend fun stopInventory(): Result<Unit> {
            calls += "stop"
            return inner.stopInventory()
        }
    }

    private class Rig(t: TestScope, mode: RfidTriggerMode) {
        val fake = FakeRfidReader()
        val reader = Recorder(fake)
        val settings = MutableStateFlow(DEFAULT_RFID_SETTINGS.copy(enabled = true, triggerMode = mode))
        /** The controller's clock. */
        @Volatile var now = 0L
        val controller = RfidController(reader, settings, t.backgroundScope) { now }
        val bursts = CopyOnWriteArrayList<List<String>>()

        init {
            t.backgroundScope.launch { controller.bursts.collect { bursts += it } }
        }
    }

    /** Starts and arms [r], connects it through the controller, and forgets
     *  the connect's calls. */
    private fun TestScope.connectedAndArmed(r: Rig) {
        r.controller.start(); r.controller.arm(); settle()
        backgroundScope.launch { r.controller.connectNow() }; settle()
        assertTrue(r.fake.connection.value is RfidConnection.Connected)
        r.reader.calls.clear()
    }

    /** One pull, stamped [atMs] by the reader and seen by the controller at
     *  the same clock time. */
    private fun TestScope.pull(r: Rig, event: TriggerEvent, atMs: Long) {
        r.now = atMs
        r.fake.emitTrigger(event, atMs = atMs); settle()
    }

    @Test fun aStrayReleaseLeavesALatchedSweepRunning() = runTest {
        val r = Rig(this, RfidTriggerMode.HOLD_OR_LATCH)
        connectedAndArmed(r)

        pull(r, TriggerEvent.PRESSED, 0)
        pull(r, TriggerEvent.RELEASED, 350)
        assertTrue("a 350 ms click latches the sweep", r.fake.inventoryRunning)
        r.fake.emitTag("100348"); settle()
        val activity = r.controller.lastActivityMs.value

        pull(r, TriggerEvent.RELEASED, 1_060)
        assertTrue("the stray release leaves the sweep running", r.fake.inventoryRunning)
        assertNotNull(r.controller.session.value)
        assertEquals("the reader got no stop", listOf("start"), r.reader.calls)
        assertEquals("ignored entirely: not even activity", activity, r.controller.lastActivityMs.value)

        pull(r, TriggerEvent.PRESSED, 4_000)
        assertNull("the next press still ends the latched sweep", r.controller.session.value)
        assertEquals(listOf("start", "stop"), r.reader.calls)
        assertEquals(listOf(listOf("100348")), r.bursts)
        assertEquals(emptyList<String>(), r.fake.violations)
    }

    /** Runs the same pulls with and without the stray release in every mode:
     *  the reader's calls, the bursts and whether a sweep is open after each
     *  real pull are the same. The real pulls after the stray one include a
     *  long hold and a click, so the latch window is measured from the right
     *  press. */
    @Test fun theNextRealPullsDoExactlyWhatTheyWouldHaveDoneInEveryMode() = runTest {
        for (mode in RfidTriggerMode.entries) {
            fun TestScope.trace(stray: Boolean): Triple<List<String>, List<List<String>>, List<Boolean>> {
                val r = Rig(this, mode)
                connectedAndArmed(r)
                val open = mutableListOf<Boolean>()
                fun step(event: TriggerEvent, atMs: Long) { pull(r, event, atMs); open += r.controller.session.value != null }
                step(TriggerEvent.PRESSED, 0)
                r.fake.emitTag("100348"); settle()
                step(TriggerEvent.RELEASED, 350)
                if (stray) pull(r, TriggerEvent.RELEASED, 1_060)
                step(TriggerEvent.PRESSED, 4_000)
                step(TriggerEvent.RELEASED, 4_900)
                step(TriggerEvent.PRESSED, 6_000)
                r.fake.emitTag("100349"); settle()
                step(TriggerEvent.RELEASED, 6_100)
                step(TriggerEvent.PRESSED, 9_000)
                step(TriggerEvent.RELEASED, 9_200)
                assertEquals("$mode, stray=$stray", emptyList<String>(), r.fake.violations)
                return Triple(r.reader.calls.toList(), r.bursts.toList(), open)
            }
            assertEquals("$mode: a stray release changes nothing", trace(stray = false), trace(stray = true))
        }
    }

    @Test fun aStrayReleaseInHoldOrToggleModeChangesNothing() = runTest {
        for (mode in listOf(RfidTriggerMode.HOLD, RfidTriggerMode.TOGGLE)) {
            val r = Rig(this, mode)
            connectedAndArmed(r)
            pull(r, TriggerEvent.PRESSED, 0)
            pull(r, TriggerEvent.RELEASED, 350)
            val calls = r.reader.calls.toList()
            val session = r.controller.session.value
            val activity = r.controller.lastActivityMs.value

            pull(r, TriggerEvent.RELEASED, 1_060)
            assertEquals("$mode", calls, r.reader.calls)
            assertEquals("$mode", session, r.controller.session.value)
            assertEquals("$mode", activity, r.controller.lastActivityMs.value)
        }
    }

    /** A press is forgotten when its link is lost: a release arriving after
     *  that (on the lost link's last state, or once the sled is back) with no
     *  press since is ignored. */
    @Test fun aReleaseAfterALinkLossWithNoPressSinceIsIgnored() = runTest {
        val r = Rig(this, RfidTriggerMode.HOLD_OR_LATCH)
        connectedAndArmed(r)
        pull(r, TriggerEvent.PRESSED, 0)
        assertNotNull(r.controller.session.value)
        r.fake.dropLink("The sled disconnected."); settle()
        assertNull("the drop ends the sweep", r.controller.session.value)
        val activity = r.controller.lastActivityMs.value

        pull(r, TriggerEvent.RELEASED, 5_000)
        assertEquals("ignored after the loss", activity, r.controller.lastActivityMs.value)

        // Pressed on the next link, the link drops and comes back as a new
        // generation, then the release: ignored too.
        backgroundScope.launch { r.controller.connectNow() }; settle()
        pull(r, TriggerEvent.PRESSED, 10_000)
        assertNotNull(r.controller.session.value)
        r.fake.dropLink("The sled disconnected."); settle()
        backgroundScope.launch { r.controller.connectNow() }; settle()
        assertTrue(r.fake.connection.value is RfidConnection.Connected)
        val back = r.controller.lastActivityMs.value
        r.reader.calls.clear()
        pull(r, TriggerEvent.RELEASED, 20_000)
        assertEquals("ignored on the new link", back, r.controller.lastActivityMs.value)
        assertEquals(emptyList<String>(), r.reader.calls)

        // A real pull on the new link works as usual.
        pull(r, TriggerEvent.PRESSED, 30_000)
        assertNotNull(r.controller.session.value)
        pull(r, TriggerEvent.RELEASED, 31_000)
        assertNull("a 1 s hold ends the sweep", r.controller.session.value)
        assertEquals(listOf("start", "stop"), r.reader.calls)
    }

    /** A press made while the trigger is not armed still counts, so its
     *  release is not mistaken for a stray one; the release does nothing
     *  while disarmed either way. */
    @Test fun aPressWhileDisarmedIsStillBookkept() = runTest {
        val r = Rig(this, RfidTriggerMode.HOLD)
        r.controller.start(); settle()
        backgroundScope.launch { r.controller.connectNow() }; settle()
        r.reader.calls.clear()
        pull(r, TriggerEvent.PRESSED, 0)
        r.controller.arm(); settle()
        val activity = r.controller.lastActivityMs.value
        pull(r, TriggerEvent.RELEASED, 2_000)
        assertTrue("a release after a press is seen", r.controller.lastActivityMs.value > activity)
        assertEquals("nothing was reading, so nothing to stop", emptyList<String>(), r.reader.calls)
    }
}
