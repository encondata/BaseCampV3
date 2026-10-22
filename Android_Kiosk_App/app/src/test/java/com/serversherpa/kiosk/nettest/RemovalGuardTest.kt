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

        assertEquals("files outside nettest/ that refer to Internet Test", TOUCH_POINTS.toSortedSet(), found)
    }

    @Test fun everyMentionCarriesTheMarker() {
        val problems = TOUCH_POINTS.flatMap { path ->
            val file = File(MAIN, path)
            assertTrue("${file.path} not found (run from the app module)", file.isFile)
            RemovalScan.unmarkedMentions(path, file.readLines())
        }

        assertEquals("lines that refer to Internet Test without ${RemovalScan.MARKER}", emptyList<String>(), problems)
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
        // REMOVAL.md lists the touch points by path. Keep the two in step.
        val removalMd = File(MAIN, "$APP/nettest/REMOVAL.md")
        assertTrue("${removalMd.path} not found (run from the app module)", removalMd.isFile)
        val text = removalMd.readText()

        assertEquals(
            "touch points REMOVAL.md doesn't name",
            emptyList<String>(),
            TOUCH_POINTS.filterNot { it.removePrefix("$APP/") in text },
        )
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

        /** The only files outside `nettest/` that may refer to it; REMOVAL.md names the same seven. */
        val TOUCH_POINTS = listOf(
            "$APP/AppContainer.kt",
            "$APP/data/api/OkHttpKioskApi.kt",
            "$APP/data/auth/MoveSetupGuard.kt",
            "$APP/data/printer/NetworkZebra.kt",
            "$APP/ui/screens/timeclock/screens/ConfirmPerson.kt",
            "$APP/ui/screens/settings/DeveloperPanel.kt",
            "$APP/ui/shell/KioskShell.kt",
        )
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

    /** The lines of [lines] that refer to Internet Test but don't end in the marker, as `file:line: text`. */
    fun unmarkedMentions(file: String, lines: List<String>): List<String> = lines.indices
        .filter { lines[it].contains("nettest", ignoreCase = true) && !lines[it].trimEnd().endsWith(MARKER) }
        .map { "$file:${it + 1}: ${lines[it].trim()}" }
}
