package com.serversherpa.kiosk.input.rfid

import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RfidPermissionsTest {
    @Test fun theManifestDeclaresEveryPermissionTheSledNeeds() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val declared = context.packageManager
            .getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions?.toSet().orEmpty()
        for (p in RfidPermissions.REQUIRED) {
            assertTrue("manifest is missing $p", declared.contains(p))
        }
        // Zebra's library needs location for its Bluetooth configuration on
        // Google reference platforms, which is not obvious from the API.
        assertTrue(declared.contains("android.permission.ACCESS_FINE_LOCATION"))
    }

    @Test fun nothingIsGrantedInAFreshTestApp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        assertTrue(RfidPermissions.missing(context).isNotEmpty())
    }
}
