package com.serversherpa.kiosk

import android.app.Application
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The merged manifest of the Direct flavor: only the direct build may ask to install packages. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FlavorManifestTest {
    private fun requested(): List<String> {
        val app = ApplicationProvider.getApplicationContext<Application>()
        @Suppress("DEPRECATION")
        return app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_PERMISSIONS)
            .requestedPermissions.orEmpty().toList()
    }

    @Test fun theDirectBuildMayRequestInstalls() { assertTrue(requested().toString(), "android.permission.REQUEST_INSTALL_PACKAGES" in requested()) }
}
