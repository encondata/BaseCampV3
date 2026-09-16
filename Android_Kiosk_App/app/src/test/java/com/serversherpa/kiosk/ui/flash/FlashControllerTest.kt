package com.serversherpa.kiosk.ui.flash

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FlashControllerTest {
    @Test fun aNewerFlashOwnsTheScreen() = runTest {
        val c = FlashController(backgroundScope)
        c.flash(0xFF00FF00.toInt(), 350)
        val first = c.state.value!!
        advanceTimeBy(200)
        c.flash(0xFFFF0000.toInt(), 350)
        assertEquals(first.id + 1, c.state.value!!.id)
        advanceTimeBy(200); runCurrent()
        assertEquals(0xFFFF0000.toInt(), c.state.value!!.argb)   // the first flash's timer did not clear the second
        advanceTimeBy(200); runCurrent()
        assertNull(c.state.value)
    }
}
