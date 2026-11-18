package com.serversherpa.kiosk.data.update

import android.app.Application
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ApkInstallerTest {
    @get:Rule val tmp = TemporaryFolder()

    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val pkg = "com.serversherpa.kiosk"
    private lateinit var installer: AndroidApkInstall

    @Before fun setUp() {
        InstallEvents.resetForTest()
        installer = AndroidApkInstall(app)
    }

    private fun apk(): File = tmp.newFile("3.apk").also { it.writeBytes(ByteArray(2048) { b -> b.toByte() }) }

    private fun archive(file: File, packageName: String, build: Long) {
        val info = PackageInfo().apply { this.packageName = packageName; longVersionCode = build }
        shadowOf(app.packageManager).setPackageArchiveInfo(file.path, info)
    }

    @Test fun installWritesASessionAndCommits() {
        val finished = mutableListOf<Pair<Int, Boolean>>()
        app.packageManager.packageInstaller.registerSessionCallback(object : PackageInstaller.SessionCallback() {
            override fun onCreated(sessionId: Int) {}
            override fun onBadgingChanged(sessionId: Int) {}
            override fun onActiveChanged(sessionId: Int, active: Boolean) {}
            override fun onProgressChanged(sessionId: Int, progress: Float) {}
            override fun onFinished(sessionId: Int, success: Boolean) { finished += sessionId to success }
        }, Handler(Looper.getMainLooper()))

        installer.install(apk())
        shadowOf(Looper.getMainLooper()).idle()

        val sessions = app.packageManager.packageInstaller.allSessions
        assertEquals(1, sessions.size)
        assertEquals(pkg, sessions.single().appPackageName)
        // The shadow finishes a session only from commit(), and then fires its status receiver.
        assertEquals(listOf(sessions.single().sessionId to true), finished)
        val status = shadowOf(app).broadcastIntents.last()
        assertEquals(UpdateInstallReceiver::class.java.name, status.component?.className)
        assertEquals(pkg, status.`package`)
    }

    @Test fun checkArchiveRejectsAnotherPackage() {
        val f = apk()
        archive(f, "com.example.other", 3)
        assertEquals("The downloaded file isn't ServerSherpa Kiosk 1.4.0.", installer.checkArchive(f, pkg, 3, "1.4.0"))
    }

    @Test fun checkArchiveRejectsAnotherBuild() {
        val f = apk()
        archive(f, pkg, 2)
        assertEquals("The downloaded file isn't ServerSherpa Kiosk 1.4.0.", installer.checkArchive(f, pkg, 3, "1.4.0"))
    }

    @Test fun checkArchiveRejectsAnUnreadableFile() {
        assertEquals("The downloaded file isn't an app this phone can install.", installer.checkArchive(apk(), pkg, 3, "1.4.0"))
    }

    @Test fun checkArchiveAcceptsOurBuild() {
        val f = apk()
        archive(f, pkg, 3)
        assertNull(installer.checkArchive(f, pkg, 3, "1.4.0"))
    }

    @Test fun openInstallPermissionSettingsStartsTheSystemPage() {
        installer.openInstallPermissionSettings()
        val started = shadowOf(app).nextStartedActivity
        assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, started.action)
        assertEquals(Uri.parse("package:$pkg"), started.data)
        assertTrue(started.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
    }

    @Test fun launchPendingConfirmWithNothingPendingReturnsFalse() {
        assertFalse(installer.launchPendingConfirm())
        assertNull(shadowOf(app).nextStartedActivity)
    }
}
