package com.serversherpa.kiosk.ui

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Ruling 31: every RFID settings change a screen makes goes through
 * `KioskPrefs.updateRfid { it.copy(…) }`, one atomic edit, so two changes
 * landing together never overwrite each other. No screen writes a whole
 * snapshot with `setRfid`, which stays for tests only.
 */
class NoRfidSnapshotWriteTest {
    @Test fun noScreenCallsSetRfid() {
        val root = File("src/main/java/com/serversherpa/kiosk/ui")
        assertTrue("ui/ missing at ${root.absolutePath}", root.isDirectory)
        val files = root.walkTopDown().filter { it.extension == "kt" }.toList()
        assertTrue("no Kotlin files under ${root.absolutePath}", files.size > 20)
        val offenders = files.flatMap { file ->
            stripCommentsAndStrings(file.readText()).lines().mapIndexedNotNull { i, line ->
                if (line.contains(".setRfid(")) "${file.relativeTo(root)}:${i + 1}: ${line.trim()}" else null
            }
        }
        assertTrue("Screens write a whole RFID settings snapshot (use updateRfid):\n${offenders.joinToString("\n")}", offenders.isEmpty())
    }

    /** The stripper keeps code and line breaks and drops comments and string and char literals. */
    @Test fun theStripperDropsCommentsAndStringsOnly() {
        val source = """
            |prefs.setRfid(a) // prefs.setRfid(b)
            |/* prefs.setRfid(c)
            |   /* nested */ prefs.setRfid(d) */ keep()
            |val s = "prefs.setRfid(e) \" still a string"
            |val raw = ${"\"\"\""}prefs.setRfid(f)${"\"\"\""}
            |val ch = '"'; after()
        """.trimMargin()
        val stripped = stripCommentsAndStrings(source)
        assertEquals(source.lines().size, stripped.lines().size)
        assertEquals(1, Regex("""\.setRfid\(""").findAll(stripped).count())
        assertTrue(stripped.lines()[0].startsWith("prefs.setRfid(a)"))
        assertTrue(stripped.lines()[2].contains("keep()"))
        assertTrue(stripped.lines()[5].contains("after()"))
    }

    /** Kotlin source with comments (nested block comments included) and string and char
     *  literals (raw strings included) replaced by nothing; line breaks are kept so line
     *  numbers still match. Template expressions inside strings are dropped with them. */
    private fun stripCommentsAndStrings(src: String): String {
        val out = StringBuilder(src.length)
        var i = 0
        fun at(s: String) = src.startsWith(s, i)
        while (i < src.length) {
            when {
                at("//") -> { while (i < src.length && src[i] != '\n') i++ }
                at("/*") -> {
                    var depth = 0
                    while (i < src.length) {
                        when {
                            at("/*") -> { depth++; i += 2 }
                            at("*/") -> { depth--; i += 2; if (depth == 0) break }
                            else -> { if (src[i] == '\n') out.append('\n'); i++ }
                        }
                    }
                }
                at("\"\"\"") -> {
                    i += 3
                    while (i < src.length && !at("\"\"\"")) { if (src[i] == '\n') out.append('\n'); i++ }
                    i += 3
                    while (i < src.length && src[i] == '"') i++
                }
                src[i] == '"' || src[i] == '\'' -> {
                    val quote = src[i]
                    i++
                    while (i < src.length && src[i] != quote && src[i] != '\n') { if (src[i] == '\\') i++; i++ }
                    i++
                }
                else -> { out.append(src[i]); i++ }
            }
        }
        return out.toString()
    }
}
