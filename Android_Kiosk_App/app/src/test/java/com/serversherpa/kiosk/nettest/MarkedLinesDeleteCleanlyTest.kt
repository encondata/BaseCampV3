package com.serversherpa.kiosk.nettest

import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Design 8: Internet Test comes out by deleting its package and every line
 * marked `// INTERNET-TEST`, with nothing restored by hand. So for each touch
 * point outside the package, deleting the marked lines must give back the file
 * as it was before Internet Test (the branch base), token for token. Line breaks
 * and indentation may differ, and a trailing comma before `)` doesn't count
 * (Kotlin compiles a call the same with or without one).
 *
 * The base is read with `git show`; where git or that commit isn't available,
 * the test is skipped.
 */
class MarkedLinesDeleteCleanlyTest {
    @Test fun deletingTheMarkedLinesGivesBackEveryTouchPoint() {
        assumeTrue("git or the branch base $BASE isn't available here", git("rev-parse", "--verify", "--quiet", "$BASE^{commit}") != null)
        val marked = TOUCH_POINTS.filter { MARKER in source(it).readText() }
        assertTrue("no touch point carries $MARKER", marked.isNotEmpty())

        val broken = marked.filter { path ->
            val base = git("show", "$BASE:./$SOURCE_ROOT/$path")
                ?: throw AssertionError("$path isn't in the branch base $BASE")
            val deleted = source(path).readLines().filterNot { MARKER in it }.joinToString("\n")
            tokens(deleted) != tokens(base)
        }

        assertEquals("deleting the $MARKER lines doesn't give back the original code in", emptyList<String>(), broken)
    }

    private fun source(path: String): File = File(SOURCE_ROOT, path).also {
        assertTrue("${it.absolutePath} not found (run from the app module)", it.isFile)
    }

    /** Runs git in the app module and returns what it prints, or null when it fails or isn't installed. */
    private fun git(vararg args: String): String? = try {
        val process = ProcessBuilder("git", *args)
            .directory(File("."))
            .redirectError(ProcessBuilder.Redirect.INHERIT)
            .start()
        val out = process.inputStream.bufferedReader().readText()
        if (process.waitFor(30, TimeUnit.SECONDS) && process.exitValue() == 0) out else null
    } catch (_: IOException) {
        null
    }

    private companion object {
        const val MARKER = "// INTERNET-TEST"

        /** The commit the Internet Test branch started from. */
        const val BASE = "798ba91b"

        const val SOURCE_ROOT = "src/main/java/com/serversherpa/kiosk"

        /** Every file outside the package that Internet Test touches. One without a marker yet is skipped. */
        val TOUCH_POINTS = listOf(
            "AppContainer.kt",
            "data/api/OkHttpKioskApi.kt",
            "data/auth/MoveSetupGuard.kt",
            "data/printer/NetworkZebra.kt",
            "ui/screens/timeclock/TimeclockScreen.kt",
            "ui/screens/settings/DeveloperPanel.kt",
            "ui/shell/KioskShell.kt",
        )

        /**
         * One-line string and char literals whole (so spacing inside them still
         * counts), then words, then any other single character. Whitespace
         * between tokens is dropped.
         */
        private val TOKEN = Regex(""""(?:[^"\\\n]++|\\.)*+"|'(?:[^'\\\n]++|\\.)*+'|\w+|\S""")

        fun tokens(code: String): List<String> {
            val all = TOKEN.findAll(code).map { it.value }.toList()
            return all.filterIndexed { i, t -> !(t == "," && all.getOrNull(i + 1) == ")") }
        }
    }
}
