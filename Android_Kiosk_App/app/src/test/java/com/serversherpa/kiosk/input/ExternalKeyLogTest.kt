package com.serversherpa.kiosk.input

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Spec test 26, the log half: the first key from each external keyboard (a sled typing its
 *  barcodes) is logged once, with its name and ids, so a trace shows which device typed. */
class ExternalKeyLogTest {
    private val lines = mutableListOf<String>()
    private val log = ExternalKeyLog { lines += it }

    @Test fun theFirstKeyFromEachExternalKeyboardIsLoggedOnce() {
        log.note(7, "RFD4031", 0x05e0, 0x1900, external = true, virtual = false)
        log.note(7, "RFD4031", 0x05e0, 0x1900, external = true, virtual = false)
        log.note(9, "Barcode Keyboard", 1155, 22352, external = true, virtual = false)
        log.note(7, "RFD4031", 0x05e0, 0x1900, external = true, virtual = false)
        log.note(9, "Barcode Keyboard", 1155, 22352, external = true, virtual = false)

        assertEquals(2, lines.size)
        assertTrue(lines[0], lines[0].contains("RFD4031"))
        assertTrue(lines[0], lines[0].contains("1504"))
        assertTrue(lines[0], lines[0].contains("6400"))
        assertTrue(lines[1], lines[1].contains("Barcode Keyboard"))
        assertTrue(lines[1], lines[1].contains("1155"))
        assertTrue(lines[1], lines[1].contains("22352"))
    }

    @Test fun virtualAndBuiltInDevicesAreNotLogged() {
        log.note(-1, "Virtual", 0, 0, external = false, virtual = true)
        log.note(2, "gpio-keys", 0, 0, external = false, virtual = false)
        log.note(3, "uinput", 0, 0, external = true, virtual = true)
        assertEquals(emptyList<String>(), lines)
        // A name the device does not give is still a line.
        log.note(4, null, 1, 2, external = true, virtual = false)
        assertEquals(1, lines.size)
    }
}
