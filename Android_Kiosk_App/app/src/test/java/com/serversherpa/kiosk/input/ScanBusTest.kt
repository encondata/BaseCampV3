package com.serversherpa.kiosk.input

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ScanBusTest {
    @Test fun deliversToTheActiveCollector() = runTest {
        val bus = ScanBus()
        val got = ArrayList<ScanEvent>()
        val job = launch { bus.events.collect { got += it } }
        advanceUntilIdle()
        bus.publish(ScanEvent(" A-1 ", ScanSource.KEYBOARD))
        bus.publish(ScanEvent("", ScanSource.CAMERA))            // blank: dropped
        advanceUntilIdle()
        assertEquals(listOf(ScanEvent("A-1", ScanSource.KEYBOARD)), got)
        job.cancel()
    }
}
