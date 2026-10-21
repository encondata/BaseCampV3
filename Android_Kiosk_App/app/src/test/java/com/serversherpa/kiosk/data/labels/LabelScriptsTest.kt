package com.serversherpa.kiosk.data.labels

import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A stand-in JavaScript engine that understands exactly the scripts LabelScripts and
 * LabelGenerator send (the real scripts are checked against the bundle in node; see the
 * Task 6 report). `functions` answers each surface call from its argument text. It records
 * every script and every answer so tests can bound what crosses.
 */
class FakeJs(
    override val unlimited: Boolean = false,
    val bundle: String = "BUNDLE",
    var version: String = "1",
    val functions: Map<String, (String) -> String> = emptyMap(),
) : JsIsolate {
    val scripts = ArrayList<String>()
    val answers = ArrayList<String>()
    var closed = false
    var bundleLoaded = false
    /** Hangs the next surface call (never answers until cancelled). */
    var hang = false
    /** Throws LabelEngineDeadException from the next surface call. */
    var die = false
    private var args: StringBuilder? = null
    var result: String? = null
        private set

    private fun lit(js: String) = Json.parseToJsonElement(js).jsonPrimitive.content
    private val push = Regex("""^globalThis\.__labelgenArgs\.push\((".*")\); 0$""", RegexOption.DOT_MATCHES_ALL)
    private val kept = Regex("""^globalThis\.__labelgenResult = labelgen\.(\w+)\((.*)\); String\(globalThis\.__labelgenResult\.length\)$""", RegexOption.DOT_MATCHES_ALL)
    private val direct = Regex("""^labelgen\.(\w+)\((".*")\)$""", RegexOption.DOT_MATCHES_ALL)
    private val slice = Regex("""^\(function \(s, i, n\) \{.*\}\)\(globalThis\.__labelgenResult, (\d+), (\d+)\)$""", RegexOption.DOT_MATCHES_ALL)

    override suspend fun evaluate(script: String): String {
        check(!closed) { "isolate closed" }
        scripts += script
        val answer = answer(script)
        answers += answer
        return answer
    }

    private suspend fun surface(fn: String, argsText: String): String {
        if (hang) { hang = false; awaitCancellation() }
        if (die) { die = false; throw LabelEngineDeadException() }
        check(bundleLoaded) { "labelgen is not defined" }
        return functions.getValue(fn)(argsText)
    }

    private suspend fun answer(script: String): String {
        if (script == bundle) { bundleLoaded = true; return "undefined" }
        if (script == LabelScripts.VERSION_SCRIPT) return if (bundleLoaded) version else "undefined"
        if (script == "globalThis.__labelgenArgs = []; 0") { args = StringBuilder(); return "0" }
        if (script == "globalThis.__labelgenResult = null; 0") { result = null; return "0" }
        push.matchEntire(script)?.let { args!!.append(lit(it.groupValues[1])); return "0" }
        kept.matchEntire(script)?.let { m ->
            val expr = m.groupValues[2]
            val text = if (expr == "globalThis.__labelgenArgs.splice(0).join('')") args!!.toString().also { args = StringBuilder() } else lit(expr)
            result = surface(m.groupValues[1], text)
            return result!!.length.toString()
        }
        slice.matchEntire(script)?.let { m ->
            val s = result!!
            val i = m.groupValues[1].toInt()
            var e = minOf(i + m.groupValues[2].toInt(), s.length)
            if (e < s.length && e > i + 1 && Character.isHighSurrogate(s[e - 1])) e--
            return s.substring(i, e)
        }
        direct.matchEntire(script)?.let { m -> return surface(m.groupValues[1], lit(m.groupValues[2])) }
        error("unknown script: ${script.take(80)}")
    }

    override fun close() { closed = true }
}

/** The scripts LabelGenerator evaluates in the sandbox: no Android, no JavaScript engine. */
class LabelScriptsTest {
    private fun literal(js: String): String = Json.parseToJsonElement(js).jsonPrimitive.content

    @Test fun directIsOneLiteralCall() {
        val args = """{"zpl":"^XA\"q\" \\ Café 😀 ^XZ","peel":true}"""
        val s = LabelScripts.direct("withPrintMode", args)
        assertTrue(s.startsWith("labelgen.withPrintMode(") && s.endsWith(")"))
        assertEquals(args, literal(s.removePrefix("labelgen.withPrintMode(").removeSuffix(")")))
    }

    @Test fun piecesAreMeasuredAfterEscapingAndNeverSplitAPair() {
        // Quotes and backslashes double when escaped; control chars grow up to six times.
        val text = "\"\\😀\n\u0001x".repeat(500)
        val pieces = LabelScripts.pieces(text, 40)
        assertEquals(text, pieces.joinToString(""))
        pieces.forEach { p ->
            assertTrue(LabelScripts.literal(p).length <= 40)
            assertFalse(Character.isHighSurrogate(p.last()))
            assertFalse(Character.isLowSurrogate(p.first()))
        }
        assertThrows(IllegalArgumentException::class.java) { LabelScripts.pieces("abc", 7) }
    }

    @Test fun boundedSendsAndReturnsInPiecesAndJoinsBackExactly() = runBlocking<Unit> {
        val big = """{"assetsJson":"${"x😀\\\"".repeat(3_000)}"}"""
        val answer = "{\"results\":\"${"é😀ZPL^FS".repeat(4_000)}\"}"
        val js = FakeJs(functions = mapOf("renderLabels" to { a -> assertEquals(big, a); answer })).apply { bundleLoaded = true }

        val out = LabelScripts.bounded("renderLabels", big, 1_000, js::evaluate)

        assertEquals(answer, out)
        assertTrue(js.scripts.size > 10)
        // Every crossing is bounded both ways (a script's wrapper adds a few dozen chars).
        js.scripts.forEach { assertTrue(it.length.toString(), it.length <= 1_000 + 300) }
        js.answers.forEach { assertTrue(it.length.toString(), it.length <= 1_000) }
        // The kept result is released.
        assertNull(js.result)
    }

    @Test fun boundedSendsSmallArgumentsInOneScript() = runBlocking<Unit> {
        val js = FakeJs(functions = mapOf("withPrintMode" to { "{\"zpl\":\"^XA^MMP^XZ\"}" })).apply { bundleLoaded = true }
        assertEquals("{\"zpl\":\"^XA^MMP^XZ\"}", LabelScripts.bounded("withPrintMode", "{}", 1_000, js::evaluate))
        // the call (kept result), one slice, the release
        assertEquals(3, js.scripts.size)
    }

    @Test fun anEmptyResultNeedsNoSlices() = runBlocking<Unit> {
        val js = FakeJs(functions = mapOf("sampleLabel" to { "" })).apply { bundleLoaded = true }
        assertEquals("", LabelScripts.bounded("sampleLabel", "{}", 1_000, js::evaluate))
    }

    @Test fun onlyTheSurfaceFunctionsCanBeCalled() = runBlocking<Unit> {
        assertThrows(IllegalArgumentException::class.java) { LabelScripts.direct("constructor", "{}") }
        assertThrows(IllegalArgumentException::class.java) { LabelScripts.direct("buildPlan); evil(", "{}") }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { LabelScripts.bounded("eval", "{}", 100) { "" } } }
        for (fn in listOf("buildPlan", "renderLabels", "sampleLabel", "applyPrintSettings", "withPrintMode", "alignmentTestZpl")) {
            LabelScripts.direct(fn, "{}")
        }
    }
}
