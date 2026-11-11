package com.serversherpa.kiosk

import android.app.Application
import android.content.ComponentName
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Looper
import android.view.InputDevice
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.core.view.WindowCompat
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.ui.components.LocalSledScanGuard
import com.serversherpa.kiosk.ui.components.ScanInput
import com.serversherpa.kiosk.ui.theme.StatusBarIcons
import com.serversherpa.kiosk.ui.theme.uiModeNightChanged
import java.time.Duration
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowInputDevice
import org.robolectric.shadows.ShadowLog
import org.robolectric.util.ReflectionHelpers

/**
 * The activity and manifest (spec tests 26, 29 and 30; ruling 15): every configuration change of
 * ruling 15 is handled in place (a burst survives a keyboard attaching or the phone turning),
 * edge-to-edge and the status-bar icons follow only a night-mode change, the vendor's
 * READ_EXTERNAL_STORAGE is gone, and every key goes on to the screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = TestKioskApplication::class)
class MainActivityConfigTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()

    private fun idle(ms: Long = 0) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    @Test fun mainActivityHandlesEveryConfigChangeOfRuling15() {
        val info = app.packageManager.getActivityInfo(ComponentName(app, MainActivity::class.java), 0)
        val ruling15 = mapOf(
            "orientation" to ActivityInfo.CONFIG_ORIENTATION,
            "screenSize" to ActivityInfo.CONFIG_SCREEN_SIZE,
            "smallestScreenSize" to ActivityInfo.CONFIG_SMALLEST_SCREEN_SIZE,
            "screenLayout" to ActivityInfo.CONFIG_SCREEN_LAYOUT,
            "keyboard" to ActivityInfo.CONFIG_KEYBOARD,
            "keyboardHidden" to ActivityInfo.CONFIG_KEYBOARD_HIDDEN,
            "navigation" to ActivityInfo.CONFIG_NAVIGATION,
            "uiMode" to ActivityInfo.CONFIG_UI_MODE,
            "density" to ActivityInfo.CONFIG_DENSITY,
            "fontScale" to ActivityInfo.CONFIG_FONT_SCALE,
        )
        for ((name, bit) in ruling15) assertTrue(name, info.configChanges and bit == bit)
    }

    @Test fun theAppNoLongerRequestsReadExternalStorage() {
        @Suppress("DEPRECATION")
        val requested = app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions!!.toList()
        // The merged manifest is the one read: the sled's permissions are there.
        assertTrue(requested.toString(), "android.permission.BLUETOOTH_CONNECT" in requested)
        assertFalse(requested.toString(), "android.permission.READ_EXTERNAL_STORAGE" in requested)
    }

    @Test fun edgeToEdgeRunsAgainOnlyOnANightModeChange() {
        val no = Configuration.UI_MODE_NIGHT_NO
        val yes = Configuration.UI_MODE_NIGHT_YES
        val normal = Configuration.UI_MODE_TYPE_NORMAL
        val desk = Configuration.UI_MODE_TYPE_DESK
        assertTrue(uiModeNightChanged(no or normal, yes or normal))
        assertTrue(uiModeNightChanged(yes or normal, no or normal))
        assertTrue(uiModeNightChanged(Configuration.UI_MODE_NIGHT_UNDEFINED, no))
        assertFalse(uiModeNightChanged(no or normal, no or normal))
        assertFalse(uiModeNightChanged(yes or normal, yes or desk))
        assertFalse(uiModeNightChanged(no or normal, no or desk))

        // On the activity: an orientation change re-applies nothing (an icon color set by hand
        // stays); a night-mode change does.
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        idle(500)
        val activity = controller.get()
        val insets = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        val screens = insets.isAppearanceLightStatusBars
        insets.isAppearanceLightStatusBars = !screens
        controller.configurationChange(Configuration(activity.resources.configuration).apply { orientation = Configuration.ORIENTATION_LANDSCAPE })
        idle(500)
        assertEquals(!screens, insets.isAppearanceLightStatusBars)
        val night = Configuration(activity.resources.configuration).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                (if (uiMode and Configuration.UI_MODE_NIGHT_MASK == yes) no else yes)
        }
        assertSame(activity, controller.configurationChange(night).get())
        idle(500)
        assertEquals(screens, insets.isAppearanceLightStatusBars)
    }

    @Test fun statusBarIconsReapplyAfterANightModeChange() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val base = Configuration(activity.resources.configuration).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or Configuration.UI_MODE_NIGHT_NO
        }
        var config by mutableStateOf(base)
        activity.setContent { CompositionLocalProvider(LocalConfiguration provides config) { StatusBarIcons(darkIcons = true) } }
        idle(200)
        val insets = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        assertTrue(insets.isAppearanceLightStatusBars)

        // enableEdgeToEdge() resets the color behind the screen's back.
        insets.isAppearanceLightStatusBars = false
        config = Configuration(base).apply { orientation = Configuration.ORIENTATION_LANDSCAPE }
        idle(200)
        assertFalse("nothing re-applied without a night-mode change", insets.isAppearanceLightStatusBars)
        config = Configuration(base).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or Configuration.UI_MODE_NIGHT_YES
        }
        idle(200)
        assertTrue(insets.isAppearanceLightStatusBars)
    }

    @Test fun aConfigurationChangeMidBurstKeepsTheSession() = runBlocking<Unit> {
        val activityController = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = activityController.get()
        val testApp = activity.application as TestKioskApplication
        val container = testApp.container
        val reader = testApp.reader
        reader.setConnection(RfidConnection.Connected("Fake RFD40", 80))
        container.rfid.arm()
        delay(300)
        reader.emitTrigger(TriggerEvent.PRESSED)
        withTimeout(5_000) { while (container.rfid.session.value == null) delay(20) }
        reader.emitTag("000000000000000000100348")
        withTimeout(5_000) { while (container.rfid.session.value?.tags.isNullOrEmpty()) delay(20) }

        val after = activityController.configurationChange(
            Configuration(activity.resources.configuration).apply {
                keyboard = Configuration.KEYBOARD_QWERTY
                orientation = Configuration.ORIENTATION_LANDSCAPE
            },
        )
        idle(200)
        delay(300)

        assertSame("the activity is kept, not recreated", activity, after.get())
        val session = container.rfid.session.value
        assertNotNull("the burst is still open", session)
        assertEquals(listOf("000000000000000000100348"), session!!.tags.map { it.epc })
        assertTrue(reader.inventoryRunning)
    }

    @Test fun dispatchKeyEventAlwaysPassesTheKeyOn() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val activity = controller.get()
        val container = (activity.application as TestKioskApplication).container
        val sled = ShadowInputDevice.makeInputDeviceNamed("RFD4031")
        ReflectionHelpers.setField(sled, "mId", 7)
        ReflectionHelpers.setField(sled, "mIsExternal", true)
        ReflectionHelpers.setField(sled, "mVendorId", 1504)
        ReflectionHelpers.setField(sled, "mProductId", 6400)
        activity.inputDeviceFor = { if (it == 7) sled else null }
        var text = ""
        activity.setContent {
            CompositionLocalProvider(LocalAppContainer provides container, LocalSledScanGuard provides container.sledScanGuard) {
                var value by remember { mutableStateOf("") }
                ScanInput(value, { value = it; text = it }, onSubmit = {}, placeholder = "Scan")
            }
        }
        idle(500)
        ShadowLog.clear()

        fun key(action: Int, code: Int) = KeyEvent(0L, 0L, action, code, 0, 0, 7, 0, 0, InputDevice.SOURCE_KEYBOARD)
        assertTrue(activity.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_A)))
        activity.dispatchKeyEvent(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_A))
        idle(100)
        assertEquals("a", text)
        fun sledLines() = ShadowLog.getLogsForTag("SledScanGuard").count { it.msg.contains("RFD4031") }
        assertEquals(1, sledLines())

        activity.dispatchKeyEvent(key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_B))
        activity.dispatchKeyEvent(key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_B))
        idle(100)
        assertEquals("ab", text)
        assertEquals(1, sledLines())
    }
}
