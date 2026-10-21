package com.serversherpa.kiosk.data.labels

import kotlinx.coroutines.runBlocking
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
        assertEquals(Int.MAX_VALUE, g.maxBatch()) // not connected yet
        assertEquals(answer, g.call("withPrintMode", "{}"))
        assertTrue(isolates[0].scripts.any { it.startsWith(LabelScripts.RESULT) })
        assertEquals(LabelGenerator.LIMITED_BATCH, g.maxBatch())
    }

    @Test fun unlimitedEnginesUseOneEvaluation() = runBlocking<Unit> {
        unlimited = true
        val g = generator()
        assertEquals(answer, g.call("withPrintMode", "{}"))
        assertEquals("labelgen.withPrintMode(\"{}\")", isolates[0].scripts.last())
        assertEquals(Int.MAX_VALUE, g.maxBatch())
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
