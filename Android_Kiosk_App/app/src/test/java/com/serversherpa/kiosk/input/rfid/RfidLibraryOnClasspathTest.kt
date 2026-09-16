package com.serversherpa.kiosk.input.rfid

import org.junit.Assert.assertNotNull
import org.junit.Test

/** The vendor library is a hand-placed .aar, not a Gradle coordinate, so a
 *  bad path fails silently at runtime instead of at build time. This is the
 *  cheapest possible proof that it is really on the classpath. */
class RfidLibraryOnClasspathTest {
    @Test fun zebraApi3ClassesAreOnTheClasspath() {
        assertNotNull(Class.forName("com.zebra.rfid.api3.RFIDReader"))
        assertNotNull(Class.forName("com.zebra.rfid.api3.Readers"))
        assertNotNull(Class.forName("com.zebra.rfid.api3.TagData"))
        assertNotNull(Class.forName("com.zebra.rfid.api3.RfidEventsListener"))
    }
}
