package com.serversherpa.kiosk.data.labels

import androidx.javascriptengine.SandboxUnsupportedException
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** LabelGenerator's call handling over a fake isolate: no Android, no JavaScript engine. */
class LabelGeneratorTest {
    private val answer = "{\"zpl\":\"^XA^MMT^XZ\"}"
    private val isolates = ArrayList<FakeJs>()
    private var unlimited = false
    private var supported = true
    private var bundleReads = 0

    private fun generator(timeoutMs: Long = 2_000) = LabelGenerator(
        connector = {
            FakeJs(unlimited, functions = mapOf("withPrintMode" to { answer }, "renderLabels" to { "{\"results\":[]}" }))
                .also { isolates += it }
        },
        bundle = { bundleReads++; "BUNDLE" },
        supported = { supported },
        timeoutMs = { timeoutMs },
        connectTimeoutMs = 2_000,
    )

    @Test fun connectsOnceLoadsTheBundleAndChecksItsVersion() = runBlocking<Unit> {
        val g = generator()
        assertEquals(answer, g.call("withPrintMode", "{}"))
        assertEquals(answer, g.call("withPrintMode", "{}"))
        assertEquals(1, isolates.size)
        assertEquals(1, bundleReads)
        assertEquals(listOf("BUNDLE", LabelScripts.VERSION_SCRIPT), isolates[0].scripts.take(2))
    }

    @Test fun aWrongBundleVersionClosesTheIsolate() = runBlocking<Unit> {
        val g = LabelGenerator(
            connector = { FakeJs(version = "2").also { isolates += it } },
            bundle = { "BUNDLE" }, supported = { true },
        )
        assertThrows(IllegalStateException::class.java) { runBlocking { g.call("withPrintMode", "{}") } }
        assertTrue(isolates.single().closed)
    }

    @Test fun limitedEnginesUseBoundedCallsAndSmallerBatches() = runBlocking<Unit> {
        unlimited = false
        val g = generator()
        // Asked before any call: it connects first, never guesses an unbounded batch.
        assertEquals(LabelGenerator.LIMITED_BATCH, g.maxBatch())
        assertEquals(1, isolates.size)
        assertEquals(answer, g.call("withPrintMode", "{}"))
        assertEquals(1, isolates.size)
        assertTrue(isolates[0].scripts.any { it.startsWith(LabelScripts.RESULT) })
        assertEquals(LabelGenerator.LIMITED_BATCH, g.maxBatch())
    }

    @Test fun unlimitedEnginesUseOneEvaluation() = runBlocking<Unit> {
        unlimited = true
        val g = generator()
        assertEquals(Int.MAX_VALUE, g.maxBatch())
        assertEquals(answer, g.call("withPrintMode", "{}"))
        assertEquals("labelgen.withPrintMode(\"{}\")", isolates[0].scripts.last())
        assertEquals(1, isolates.size)
    }

    @Test fun maxBatchOnAnUnsupportedDeviceSaysSo() = runBlocking<Unit> {
        supported = false
        assertThrows(LabelEngineUnsupportedException::class.java) { runBlocking { generator().maxBatch() } }
        assertTrue(isolates.isEmpty())
    }

    // The sandbox connect (FutureConnector): the library binds one sandbox per process, so a
    // sandbox from a connect nobody waits for any more must be closed, or every later connect fails.

    private class FakeSandbox(val n: Int) { var closes = 0 }

    private val sandboxes = ArrayList<FakeSandbox>()
    private val futures = ArrayList<SettableFuture<FakeSandbox>>()
    /** Each connect's future: by default it delivers a fresh sandbox at once. */
    private var nextFuture: () -> ListenableFuture<FakeSandbox> = { delivered() }

    private fun delivered(): ListenableFuture<FakeSandbox> =
        SettableFuture.create<FakeSandbox>().also { futures += it; it.set(FakeSandbox(futures.size).also { s -> sandboxes += s }) }

    private fun pending(): SettableFuture<FakeSandbox> = SettableFuture.create<FakeSandbox>().also { futures += it }

    private fun deliver(future: SettableFuture<FakeSandbox>) = FakeSandbox(futures.indexOf(future) + 1).also { sandboxes += it; future.set(it) }

    private val opened = ArrayList<FakeSandbox>()

    private fun futureConnector(open: (FakeSandbox) -> JsIsolate = { s ->
        opened += s
        FakeJs(unlimited, functions = mapOf("withPrintMode" to { answer })).also { isolates += it }
    }) = FutureConnector(connectAsync = { nextFuture() }, closeSandbox = { it.closes++ }, open = open)

    private fun sandboxGenerator(connector: JsConnector = futureConnector(), connectTimeoutMs: Long = 2_000) = LabelGenerator(
        connector = connector, bundle = { "BUNDLE" }, supported = { true }, timeoutMs = { 2_000 }, connectTimeoutMs = connectTimeoutMs,
    )

    @Test fun aCancelledConnectClosesTheSandboxItDeliversLaterAndTheNextCallConnectsFresh() = runBlocking<Unit> {
        val g = sandboxGenerator()
        nextFuture = { pending() }
        val waiting = launch(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) { g.call("withPrintMode", "{}") }
        withTimeout(2_000) { while (futures.isEmpty()) delay(5) }
        waiting.cancelAndJoin()

        // The bind finishes after nobody waits for it: that sandbox is closed, never used.
        val late = deliver(futures[0])
        assertEquals(1, late.closes)
        assertTrue(opened.isEmpty())

        nextFuture = { delivered() }
        assertEquals(answer, g.call("withPrintMode", "{}"))
        assertEquals(2, futures.size)
        assertEquals(listOf(sandboxes[1]), opened)
        assertEquals(0, sandboxes[1].closes)
    }

    @Test fun aConnectPastItsDeadlineIsClosedOnArrivalAndTheNextConnectWaitsForThatFirst() = runBlocking<Unit> {
        val g = sandboxGenerator(connectTimeoutMs = 300)
        nextFuture = { pending() }
        assertThrows(LabelEngineTimeoutException::class.java) { runBlocking { g.call("withPrintMode", "{}") } }
        assertEquals(1, futures.size)

        nextFuture = { delivered() }
        val next = async(Dispatchers.Default) { g.call("withPrintMode", "{}") }
        delay(100)
        // Still bound by the first connect: no second bind until its sandbox arrives and closes.
        assertEquals(1, futures.size)
        val late = deliver(futures[0])
        assertEquals(answer, next.await())
        assertTrue(late.closes >= 1)
        assertEquals(2, futures.size)
        assertEquals(listOf(sandboxes[1]), opened)
        assertEquals(0, sandboxes[1].closes)
    }

    @Test fun alreadyBoundCountsAsADeadSandboxAndIsTriedOnceMore() = runBlocking<Unit> {
        var binds = 0
        nextFuture = {
            if (++binds == 1) Futures.immediateFailedFuture(IllegalStateException("Binding to already bound service")) else delivered()
        }
        val g = sandboxGenerator()
        assertEquals(answer, g.call("withPrintMode", "{}"))
        assertEquals(2, binds)

        // Always bound: the call fails, and the next one tries again rather than giving up for good.
        val stuck = sandboxGenerator(FutureConnector(
            connectAsync = { binds++; Futures.immediateFailedFuture(IllegalStateException("Binding to already bound service")) },
            closeSandbox = { _: FakeSandbox -> }, open = { error("never") },
        ))
        binds = 0
        assertThrows(LabelEngineDeadException::class.java) { runBlocking { stuck.call("withPrintMode", "{}") } }
        assertThrows(LabelEngineDeadException::class.java) { runBlocking { stuck.call("withPrintMode", "{}") } }
        assertEquals(4, binds)
    }

    @Test fun anUnsupportedSandboxSaysSoAndAFailedOpenClosesTheSandbox() = runBlocking<Unit> {
        nextFuture = { Futures.immediateFailedFuture(SandboxUnsupportedException("no")) }
        assertThrows(LabelEngineUnsupportedException::class.java) { runBlocking { sandboxGenerator().call("withPrintMode", "{}") } }

        nextFuture = { delivered() }
        val g = sandboxGenerator(futureConnector(open = { throw IllegalStateException("no isolate") }))
        assertThrows(IllegalStateException::class.java) { runBlocking { g.call("withPrintMode", "{}") } }
        assertTrue(sandboxes.isNotEmpty())
        assertTrue(sandboxes.all { it.closes == 1 })
    }

    @Test fun aHungCallTimesOutClosesTheSandboxAndTheNextCallStartsFresh() = runBlocking<Unit> {
        val g = generator(timeoutMs = 200)
        g.call("withPrintMode", "{}")
        isolates[0].hang = true

        assertThrows(LabelEngineTimeoutException::class.java) { runBlocking { g.call("withPrintMode", "{}") } }
        assertTrue(isolates[0].closed)

        // The lock was released and a fresh sandbox answers.
        assertEquals(answer, g.call("withPrintMode", "{}"))
        assertEquals(2, isolates.size)
        assertFalse(isolates[1].closed)
    }

    @Test fun aDeadSandboxIsReplacedAndTheCallTriedOnceMore() = runBlocking<Unit> {
        val g = generator()
        g.call("withPrintMode", "{}")
        isolates[0].die = true

        assertEquals(answer, g.call("withPrintMode", "{}"))
        assertTrue(isolates[0].closed)
        assertEquals(2, isolates.size)
    }

    @Test fun aSandboxThatKeepsDyingFailsAfterOneRetry() = runBlocking<Unit> {
        val g = LabelGenerator(
            connector = { FakeJs(functions = mapOf("withPrintMode" to { throw LabelEngineDeadException() })).also { isolates += it } },
            bundle = { "BUNDLE" }, supported = { true },
        )
        assertThrows(LabelEngineDeadException::class.java) { runBlocking { g.call("withPrintMode", "{}") } }
        assertEquals(2, isolates.size)
        assertTrue(isolates.all { it.closed })
    }

    @Test fun unsupportedDevicesNeverConnect() = runBlocking<Unit> {
        supported = false
        val g = generator()
        assertFalse(g.isSupported())
        assertThrows(LabelEngineUnsupportedException::class.java) { runBlocking { g.call("withPrintMode", "{}") } }
        assertTrue(isolates.isEmpty())
    }

    @Test fun printHelpersGetShortTimeoutsAndTheBuildGenerousOnes() {
        assertEquals(5_000L, LabelGenerator.defaultTimeoutMs("withPrintMode"))
        assertEquals(5_000L, LabelGenerator.defaultTimeoutMs("applyPrintSettings"))
        assertTrue(LabelGenerator.defaultTimeoutMs("renderLabels") >= 60_000L)
        assertTrue(LabelGenerator.defaultTimeoutMs("buildPlan") >= 60_000L)
    }
}
