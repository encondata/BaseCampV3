package com.serversherpa.kiosk.core

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** core/ is the layer the iOS app will transliterate: no Android in it. */
class CorePurityTest {
    @Test fun coreImportsNothingFromAndroid() {
        val root = File("src/main/java/com/serversherpa/kiosk/core")
        assertTrue("core/ package missing at ${root.absolutePath}", root.isDirectory)
        val offenders = root.walkTopDown().filter { it.extension == "kt" }.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line ->
                val t = line.trim()
                if (t.startsWith("import android") || t.startsWith("import androidx")) "${file.name}:${i + 1}: $t" else null
            }
        }.toList()
        assertTrue("Android imports in core/:\n${offenders.joinToString("\n")}", offenders.isEmpty())
    }
}
