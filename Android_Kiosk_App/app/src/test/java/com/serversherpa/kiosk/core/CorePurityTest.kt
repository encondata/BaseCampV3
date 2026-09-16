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

    @Test fun onlyZebraRfidReaderImportsTheZebraSdk() {
        val root = File("src/main/java/com/serversherpa/kiosk")
        assertTrue("main source root missing at ${root.absolutePath}", root.isDirectory)
        val offenders = root.walkTopDown().filter { it.extension == "kt" }.filter { file ->
            file.readLines().any { it.trim().startsWith("import com.zebra") }
        }.map { it.name }.filter { it != "ZebraRfidReader.kt" }.toList()
        assertTrue(
            "Files other than ZebraRfidReader.kt import com.zebra:\n${offenders.joinToString("\n")}",
            offenders.isEmpty()
        )
    }

    @Test fun coreRfidImportsNothingFromZebra() {
        val root = File("src/main/java/com/serversherpa/kiosk/core/rfid")
        assertTrue("core/rfid package missing at ${root.absolutePath}", root.isDirectory)
        val offenders = root.walkTopDown().filter { it.extension == "kt" }.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line ->
                val t = line.trim()
                if (t.startsWith("import com.zebra")) "${file.name}:${i + 1}: $t" else null
            }
        }.toList()
        assertTrue("Zebra imports in core/rfid/:\n${offenders.joinToString("\n")}", offenders.isEmpty())
    }
}
