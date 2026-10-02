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

    /** The two files this app deliberately lets import `com.zebra`: the RFID
     *  radio (`com.zebra.rfid.api3`) and the sled's separate barcode imager
     *  (`com.zebra.scannercontrol`) — two different vendor SDKs for two
     *  different physical devices inside one RFD40 housing; see
     *  `ZebraBarcodeEngine`'s class doc for why the second one exists at
     *  all. Any other file importing `com.zebra` is this rule quietly
     *  breaking, which is exactly what this test exists to catch. */
    private val filesAllowedToImportTheZebraSdk = setOf("ZebraRfidReader.kt", "ZebraBarcodeEngine.kt")

    @Test fun onlyDesignatedFilesImportTheZebraSdk() {
        val root = File("src/main/java/com/serversherpa/kiosk")
        assertTrue("main source root missing at ${root.absolutePath}", root.isDirectory)
        val offenders = root.walkTopDown().filter { it.extension == "kt" }.filter { file ->
            file.readLines().any { it.trim().startsWith("import com.zebra") }
        }.map { it.name }.filter { it !in filesAllowedToImportTheZebraSdk }.toList()
        assertTrue(
            "Files other than $filesAllowedToImportTheZebraSdk import com.zebra:\n${offenders.joinToString("\n")}",
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
