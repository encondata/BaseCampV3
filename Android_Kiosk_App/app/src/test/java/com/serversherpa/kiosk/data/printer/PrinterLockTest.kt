package com.serversherpa.kiosk.data.printer

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The RFID controller reads [PrinterLock.isLocked] so no sled attempt starts while a label or a
 *  Printer Setup call holds the printer connection. */
@OptIn(ExperimentalCoroutinesApi::class)
class PrinterLockTest {
    @Test fun isLockedOnlyWhileABlockRuns() = runTest {
        val lock = PrinterLock()
        assertFalse(lock.isLocked)
        val release = CompletableDeferred<Unit>()
        val job = launch { lock.withLock { release.await() } }
        runCurrent()
        assertTrue(lock.isLocked)
        release.complete(Unit)
        job.join()
        assertFalse(lock.isLocked)

        // A block that throws lets go too.
        runCatching { lock.withLock { error("printer gone") } }
        assertFalse(lock.isLocked)
    }
}
