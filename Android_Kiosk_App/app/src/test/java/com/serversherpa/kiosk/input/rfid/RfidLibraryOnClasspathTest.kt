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

    /** Same idea, for the second Zebra SDK the same `.aar` bundles —
     *  `com.zebra.scannercontrol`, which [ZebraBarcodeEngine] uses to stand
     *  the sled's barcode imager down. Confirmed present via `javap` before
     *  `ZebraBarcodeEngine.kt` was written against it; this is what keeps
     *  that confirmation true. */
    @Test fun zebraScannerControlClassesAreOnTheClasspath() {
        assertNotNull(Class.forName("com.zebra.scannercontrol.SDKHandler"))
        assertNotNull(Class.forName("com.zebra.scannercontrol.IDcsSdkApi"))
        assertNotNull(Class.forName("com.zebra.scannercontrol.IDcsSdkApiDelegate"))
        assertNotNull(Class.forName("com.zebra.scannercontrol.DCSScannerInfo"))
        assertNotNull(Class.forName("com.zebra.scannercontrol.DCSSDKDefs\$DCSSDK_MODE"))
        assertNotNull(Class.forName("com.zebra.scannercontrol.DCSSDKDefs\$DCSSDK_COMMAND_OPCODE"))
        assertNotNull(Class.forName("com.zebra.scannercontrol.DCSSDKDefs\$DCSSDK_RESULT"))
        assertNotNull(Class.forName("com.zebra.scannercontrol.DCSSDKDefs\$DCSSDK_EVENT"))
    }
}
