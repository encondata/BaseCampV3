package com.serversherpa.kiosk

import android.content.Intent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.FragmentActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * MainActivity is a FragmentActivity (androidx.biometric's prompt needs one), and every
 * ActivityResult launcher in the app (camera, photo, RFID, Bluetooth, printer permissions) runs
 * through it. Fragment 1.2.x's FragmentActivity rejected their request codes (above 16 bits) with
 * "Can only use lower 16 bits for requestCode"; the explicit fragment-ktx dependency keeps a
 * release that doesn't, whatever else leaves the dependency graph.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FragmentActivityTest {
    @Test fun mainActivityIsAFragmentActivity() {
        assertTrue(FragmentActivity::class.java.isAssignableFrom(MainActivity::class.java))
    }

    @Test fun aFragmentActivityLaunchesAnActivityResultContract() {
        val controller = Robolectric.buildActivity(FragmentActivity::class.java).create()
        val activity = controller.get()
        val launcher = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { }
        controller.start().resume()
        val intent = Intent("com.serversherpa.kiosk.TEST_RESULT")
        launcher.launch(intent)   // threw IllegalArgumentException on fragment 1.2.5
        val started = shadowOf(activity).nextStartedActivityForResult
        assertEquals("com.serversherpa.kiosk.TEST_RESULT", started.intent.action)
        assertTrue("a 32-bit request code (${started.requestCode})", started.requestCode > 0xffff)
    }
}
