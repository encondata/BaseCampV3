package com.serversherpa.kiosk.input.rfid

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RfidPermissionsTest {
    @Test fun theManifestDeclaresEveryPermissionTheSledNeeds() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val declared = context.packageManager
            .getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions?.toSet().orEmpty()
        for (p in RfidPermissions.REQUESTED) {
            assertTrue("manifest is missing $p", declared.contains(p))
        }
        // Zebra's library needs location for its Bluetooth configuration on
        // Google reference platforms, which is not obvious from the API.
        assertTrue(declared.contains("android.permission.ACCESS_FINE_LOCATION"))
    }

    /** Android 12+ ignores a request for precise location alone: the prompt asks for approximate
     *  with it, at every level (as Bluetooth printing does). What must be granted is unchanged. */
    @Test fun preciseLocationIsAskedTogetherWithApproximate() {
        val fine = Manifest.permission.ACCESS_FINE_LOCATION
        val coarse = Manifest.permission.ACCESS_COARSE_LOCATION
        assertEquals(listOf(fine, coarse), RfidPermissions.requestedFor(30))
        assertEquals(
            listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN, fine, coarse),
            RfidPermissions.requestedFor(31),
        )
        assertEquals(RfidPermissions.requestedFor(36), RfidPermissions.requestedFor(31))
        assertEquals(listOf(fine), RfidPermissions.requiredFor(30))
        assertEquals(listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN, fine), RfidPermissions.requiredFor(34))
        assertEquals(RfidPermissions.requestedFor(34), RfidPermissions.REQUESTED)
    }

    /** Approximate alone (Android 12+'s "Approximate" answer) isn't enough for the sled; precise
     *  with approximate is, as precise was before. */
    @Test fun approximateAloneIsNotGranted() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val shadow = Shadows.shadowOf(app)
        shadow.denyPermissions(*RfidPermissions.REQUESTED.toTypedArray())
        shadow.grantPermissions(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.ACCESS_COARSE_LOCATION)
        assertEquals(listOf(Manifest.permission.ACCESS_FINE_LOCATION), RfidPermissions.missing(app))
        assertFalse(RfidPermissions.granted(app))
        shadow.grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        assertTrue(RfidPermissions.granted(app))
    }

    @Test fun nothingIsGrantedInAFreshTestApp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        assertTrue(RfidPermissions.missing(context).isNotEmpty())
    }
}
