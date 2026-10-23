package com.serversherpa.kiosk

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests run regexes on the JVM's engine, the app on Android's ICU engine, which takes only the
 * i, m, s, w and x inline flags: (?U) (UNICODE_CHARACTER_CLASS), (?u) and (?d) throw a
 * PatternSyntaxException when the pattern is first used. The Rolodex crashed on a device that way
 * while every JVM test passed. Spell Unicode classes out instead (\p{L}, \p{N}, \p{Z}).
 */
class AndroidRegexTest {
    /** An inline flag group, like `(?iU)` or `(?u:`, holding a flag ICU doesn't take. */
    private val icuRejects = Regex("""\(\?[a-zA-Z]*[duU][a-zA-Z]*[-:)]""")

    @Test fun noRegexFlagAndroidRejects() {
        val root = File("src/main/java")
        assertTrue("main sources missing at ${root.absolutePath}", root.isDirectory)
        val offenders = root.walkTopDown().filter { it.extension == "kt" }.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line ->
                val code = line.substringBefore("//")
                if (icuRejects.containsMatchIn(code) || "UNICODE_CHARACTER_CLASS" in code || "UNIX_LINES" in code) "${file.name}:${i + 1}: ${line.trim()}" else null
            }
        }.toList()
        assertTrue("Regex flags Android's ICU engine rejects:\n${offenders.joinToString("\n")}", offenders.isEmpty())
    }
}
