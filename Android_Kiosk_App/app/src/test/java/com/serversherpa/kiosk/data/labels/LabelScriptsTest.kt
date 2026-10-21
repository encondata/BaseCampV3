package com.serversherpa.kiosk.data.labels

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The scripts LabelGenerator evaluates in the sandbox: no Android, no JavaScript engine. */
class LabelScriptsTest {
    private val args = """{"zpl":"^XA\"q\" \\ Café 😀  ^XZ","peel":true}"""

    /** The text a JS string literal of ours stands for (JSON string syntax is a JS string literal). */
    private fun literal(js: String): String = Json.parseToJsonElement(js).jsonPrimitive.content

    @Test fun aSmallCallIsOneScript() {
        val scripts = LabelScripts.call("withPrintMode", args, chunkChars = 1_000)
        assertEquals(1, scripts.size)
        val s = scripts.single()
        assertTrue(s, s.startsWith("labelgen.withPrintMode(") && s.endsWith(")"))
        assertEquals(args, literal(s.removePrefix("labelgen.withPrintMode(").removeSuffix(")")))
    }

    @Test fun aLargeCallIsSentInChunksThatJoinBackExactly() {
        val big = """{"assetsJson":"${"x😀\\\"".repeat(400)}"}"""
        val scripts = LabelScripts.call("buildPlan", big, chunkChars = 64)
        // reset, the pushes, then the call on the joined text
        assertEquals("globalThis.__labelgenArgs = []; 0", scripts.first())
        assertEquals("labelgen.buildPlan(globalThis.__labelgenArgs.splice(0).join(''))", scripts.last())
        val pushes = scripts.subList(1, scripts.size - 1)
        assertTrue(pushes.size > 1)
        val parts = pushes.map {
            assertTrue(it, it.startsWith("globalThis.__labelgenArgs.push(") && it.endsWith("); 0"))
            literal(it.removePrefix("globalThis.__labelgenArgs.push(").removeSuffix("); 0"))
        }
        assertEquals(big, parts.joinToString(""))
        // No chunk ends inside a surrogate pair (each crosses the Binder as valid UTF-16).
        parts.forEach { p ->
            assertFalse(Character.isHighSurrogate(p.last()))
            assertFalse(Character.isLowSurrogate(p.first()))
            assertTrue(p.length <= 64)
        }
    }

    @Test fun onlyTheSurfaceFunctionsCanBeCalled() {
        assertThrows(IllegalArgumentException::class.java) { LabelScripts.call("constructor", "{}", 100) }
        assertThrows(IllegalArgumentException::class.java) { LabelScripts.call("buildPlan); evil(", "{}", 100) }
        for (fn in listOf("buildPlan", "renderLabels", "sampleLabel", "applyPrintSettings", "withPrintMode", "alignmentTestZpl")) {
            assertEquals(1, LabelScripts.call(fn, "{}", 100).size)
        }
    }
}
