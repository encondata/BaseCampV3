package com.serversherpa.kiosk.data.printer

import android.Manifest
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What Bluetooth printing asks Android for, by API level, and the manifest it relies on. */
class BluetoothPermissionsTest {
    /** API 30 (the MC2200): precise location, which Bluetooth scans need, asked with approximate. */
    @Test fun api30AsksForLocation() {
        assertEquals(
            listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
            BluetoothPermissions.requiredFor(30),
        )
    }

    /** API 31+: the nearby-devices pair, and precise location too, since the manifest's
     *  BLUETOOTH_SCAN doesn't disavow location (below), asked with approximate (Android 12+
     *  ignores a request for precise alone). */
    @Test fun api31AndUpAskForNearbyDevicesAndLocation() {
        val expected = listOf(
            Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        assertEquals(expected, BluetoothPermissions.requiredFor(31))
        assertEquals(expected, BluetoothPermissions.requiredFor(36))
    }

    /** BLUETOOTH_SCAN is shared with the RFD40's SDK and carries no `neverForLocation`, so Android
     *  filters scan results without location permission: [BluetoothPermissions] asks for it on 31+
     *  as long as that stays so. Bluetooth LE is optional hardware (a device without it still
     *  installs and prints over the network). */
    @Test fun theManifestTiesScansToLocationAndKeepsBluetoothLeOptional() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val scan = Regex("""<uses-permission[^>]*android\.permission\.BLUETOOTH_SCAN"[^>]*>""").find(manifest)?.value
            ?: throw AssertionError("the manifest declares no BLUETOOTH_SCAN")
        assertFalse(scan.contains("neverForLocation"))
        assertTrue(BluetoothPermissions.requiredFor(31).contains(Manifest.permission.ACCESS_FINE_LOCATION))
        // Every permission asked for is declared (approximate location included).
        for (permission in BluetoothPermissions.requiredFor(36)) {
            assertTrue(permission, manifest.contains("""<uses-permission android:name="$permission" />"""))
        }
        assertTrue(
            Regex("""<uses-feature\s+android:name="android\.hardware\.bluetooth_le"\s+android:required="false"\s*/>""")
                .containsMatchIn(manifest),
        )
    }
}
