package com.serversherpa.kiosk

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** Play policy: the Play build carries no self-update code. src/main and src/play are scanned
 *  (this file lives in src/test, which is not); the install code lives only in src/direct. */
class PlayHasNoInstallerTest {
    // Built from pieces so this test's own text is plainly data, not a hit.
    private val forbidden = listOf(
        "Package" + "Installer",
        "REQUEST_INSTALL_" + "PACKAGES",
        "ACTION_MANAGE_UNKNOWN_" + "APP_SOURCES",
        "canRequestPackage" + "Installs",
    )

    @Test fun mainAndPlayCarryNoSelfUpdateCode() {
        val roots = listOf("main", "play").map { File("src", it) }.filter { it.isDirectory }
        assertTrue("src/main must exist (working dir is the module)", roots.any { it.name == "main" })
        val hits = roots.flatMap { root -> root.walkTopDown().filter { it.isFile }.toList() }
            .filter { f -> f.extension in setOf("kt", "java", "xml", "kts", "md") }
            .flatMap { f -> val t = f.readText(); forbidden.filter { it in t }.map { "${f.path}: $it" } }
        assertTrue(hits.toString(), hits.isEmpty())
    }
}
