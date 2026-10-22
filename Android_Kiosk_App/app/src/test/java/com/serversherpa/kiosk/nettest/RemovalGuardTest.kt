package com.serversherpa.kiosk.nettest

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Design 8: Internet Test is built to be removed. Outside its own package the
 * app knows about it in a short, named list of places, and every line there
 * carries `// INTERNET-TEST`. This test keeps both true while the feature
 * lives, so `nettest/REMOVAL.md` stays accurate:
 *
 * - [touchPointsAreKnown]: the files outside the package that refer to Internet
 *   Test are exactly [TOUCH_POINTS]. A new one fails here until it is added to
 *   the list on purpose, and to REMOVAL.md.
 * - [everyMentionCarriesTheMarker]: in those files, every line that refers to
 *   Internet Test ends in the marker, so "delete every marked line" finds all
 *   of it. (That the marked lines can be deleted whole is
 *   [MarkedLinesAreDeletableTest]'s job.)
 * - [eachTouchPointHasItsMarkedLines]: each of those files has exactly the
 *   number of marked lines [TOUCH_POINTS] gives it. Some marked lines name no
 *   Internet Test symbol (`OkHttpKioskApi`'s `route` parameter and `.let(route)`,
 *   `MoveSetupGuard`'s `onDropped`), so a marker lost in a reformat or a merge
 *   would otherwise go unnoticed and leave dead plumbing behind after removal.
 * - [noTestOutsideThePackageRefersToIt]: deleting the test package must not
 *   break the build, so no other test may use Internet Test.
 *
 * Run from the app module, as Gradle does.
 */
class RemovalGuardTest {
    @Test fun touchPointsAreKnown() {
        val found = filesOutsideThePackage(MAIN)
            .filter { RemovalScan.refers(it.readText()) }
            .map { it.relativeTo(MAIN).invariantSeparatorsPath }
            .toSortedSet()

        assertEquals("files outside nettest/ that refer to Internet Test", TOUCH_POINTS.keys.toSortedSet(), found)
    }

    @Test fun everyMentionCarriesTheMarker() {
        val problems = TOUCH_POINTS.keys.flatMap { path ->
            val file = File(MAIN, path)
            assertTrue("${file.path} not found (run from the app module)", file.isFile)
            RemovalScan.unmarkedMentions(path, file.readLines())
        }

        assertEquals("lines that refer to Internet Test without ${RemovalScan.MARKER}", emptyList<String>(), problems)
    }

    @Test fun eachTouchPointHasItsMarkedLines() {
        val counts = TOUCH_POINTS.mapValues { (path, _) ->
            val file = File(MAIN, path)
            assertTrue("${file.path} not found (run from the app module)", file.isFile)
            RemovalScan.markedLines(file.readLines())
        }

        assertEquals("marked lines per touch point (update TOUCH_POINTS and REMOVAL.md together)", TOUCH_POINTS, counts)
    }

    @Test fun noTestOutsideThePackageRefersToIt() {
        val users = filesOutsideThePackage(TEST)
            .filter { RemovalScan.refers(it.readText()) }
            .map { it.relativeTo(TEST).invariantSeparatorsPath }

        assertEquals("test files outside nettest/ that refer to Internet Test", emptyList<String>(), users)
    }

    @Test fun theScannerReportsAMentionWithoutTheMarker() {
        val lines = listOf(
            "import com.serversherpa.kiosk.nettest.InternetTest",
            "val internetTest = InternetTest(dataStore, scope) ${RemovalScan.MARKER}",
            "    NetTestChip(onClick = {}) // not the marker",
            "    netTestFootValue()",
            "val unrelated = 1",
            "    // INTERNET-TEST",
        )

        assertEquals(
            listOf(
                "Fixture.kt:1: import com.serversherpa.kiosk.nettest.InternetTest",
                "Fixture.kt:3: NetTestChip(onClick = {}) // not the marker",
                "Fixture.kt:4: netTestFootValue()",
            ),
            RemovalScan.unmarkedMentions("Fixture.kt", lines),
        )
    }

    @Test fun theScannerSeesEveryNameInternetTestUses() {
        listOf(
            "import com.serversherpa.kiosk.nettest.Presets",
            "val internetTest = x",
            "InternetTestRoutes::portal",
            "InternetTestSection()",
            "NetTestChip()",
            "netTestFootValue()",
            "// INTERNET-TEST",
        ).forEach { assertTrue("should refer: $it", RemovalScan.refers(it)) }

        listOf("val internet = connection", "val test = 1", "import okhttp3.OkHttpClient").forEach {
            assertTrue("should not refer: $it", !RemovalScan.refers(it))
        }
    }

    @Test fun removalMdNamesEveryTouchPoint() {
        // REMOVAL.md lists the touch points by path, each with its marked-line
        // count, and gives the totals in words. Keep the two in step.
        val removalMd = File(MAIN, "$APP/nettest/REMOVAL.md")
        assertTrue("${removalMd.path} not found (run from the app module)", removalMd.isFile)
        val text = removalMd.readText()
        val rows = text.lines().filter { it.startsWith("| `") }

        assertEquals(
            "touch points REMOVAL.md's table doesn't list with their marked-line counts",
            emptyList<String>(),
            TOUCH_POINTS.filterNot { (path, count) -> rows.any { it.startsWith("| `${path.removePrefix("$APP/")}` | $count |") } }.keys.toList(),
        )
        assertEquals("rows in REMOVAL.md's table", TOUCH_POINTS.size, rows.size)
        // The prose wraps, so compare it with its line breaks as spaces.
        val prose = text.replace(Regex("""\s+"""), " ")
        val total = TOUCH_POINTS.values.sum()
        val files = NUMBER_WORDS[TOUCH_POINTS.size]
        for (phrase in listOf("There are $total of them in the $files files", "in exactly these $files files")) {
            assertTrue("REMOVAL.md should say \"$phrase\"", phrase in prose)
        }
    }

    private fun filesOutsideThePackage(root: File): List<File> {
        assertTrue("${root.absolutePath} not found (run from the app module)", root.isDirectory)
        return root.walk()
            .filter { it.isFile && it.extension in TEXT_EXTENSIONS }
            .filterNot { it.invariantSeparatorsPath.contains("/$APP/nettest/") }
            .toList()
    }

    private companion object {
        val MAIN = File("src/main")
        val TEST = File("src/test")
        const val APP = "java/com/serversherpa/kiosk"

        /** Text files that could refer to Internet Test (sources, manifest, resources, build files). */
        val TEXT_EXTENSIONS = setOf("kt", "java", "xml", "kts", "gradle", "pro", "json", "properties", "txt", "md")

        /**
         * The only files outside `nettest/` that may refer to it, each with its
         * number of marked lines. REMOVAL.md's table names the same files with
         * the same counts.
         */
        val TOUCH_POINTS = mapOf(
            "$APP/AppContainer.kt" to 7,
            "$APP/data/api/OkHttpKioskApi.kt" to 2,
            "$APP/data/auth/MoveSetupGuard.kt" to 2,
            "$APP/data/printer/NetworkZebra.kt" to 2,
            "$APP/ui/screens/timeclock/screens/ConfirmPerson.kt" to 2,
            "$APP/ui/screens/settings/DeveloperPanel.kt" to 2,
            "$APP/ui/shell/KioskShell.kt" to 4,
        )

        /** How REMOVAL.md spells a count of files. */
        val NUMBER_WORDS = listOf("no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve")
    }
}

/** What counts as referring to Internet Test, and what a marked line looks like. */
internal object RemovalScan {
    const val MARKER = "// INTERNET-TEST"

    /**
     * Case-insensitive `nettest`, which is inside every name the feature gives
     * the rest of the app: the package `...kiosk.nettest`, `InternetTest`,
     * `InternetTestRoutes`, `internetTest`, `NetTestChip`, `netTestFootValue`.
     * The marker alone counts too.
     */
    fun refers(text: String): Boolean = text.contains("nettest", ignoreCase = true) || MARKER in text

    /** How many of [lines] carry the marker, anywhere on the line: the lines REMOVAL.md's `sed` deletes. */
    fun markedLines(lines: List<String>): Int = lines.count { MARKER in it }

    /** The lines of [lines] that refer to Internet Test but don't end in the marker, as `file:line: text`. */
    fun unmarkedMentions(file: String, lines: List<String>): List<String> = lines.indices
        .filter { lines[it].contains("nettest", ignoreCase = true) && !lines[it].trimEnd().endsWith(MARKER) }
        .map { "$file:${it + 1}: ${lines[it].trim()}" }
}
