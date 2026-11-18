package com.serversherpa.kiosk.data.update

import android.app.Application
import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UpdateInstallReceiverTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val seen = mutableListOf<InstallEvent>()
    private var collector: Job? = null

    @Before fun setUp() {
        InstallEvents.resetForTest()
        @Suppress("OPT_IN_USAGE")
        collector = kotlinx.coroutines.GlobalScope.launch(Dispatchers.Unconfined) { InstallEvents.events.collect { seen += it } }
    }

    @After fun tearDown() { collector?.cancel(); InstallEvents.resetForTest() }

    private fun status(code: Int, message: String? = null, confirm: Intent? = null) =
        Intent(app, UpdateInstallReceiver::class.java).apply {
            putExtra(PackageInstaller.EXTRA_STATUS, code)
            message?.let { putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, it) }
            confirm?.let { putExtra(Intent.EXTRA_INTENT, it) }
        }

    private fun confirmIntent() = Intent("android.content.pm.action.CONFIRM_INSTALL").setPackage("com.android.packageinstaller")

    @Test fun pendingUserActionInForegroundOpensTheConfirmScreen() {
        InstallEvents.foreground = true
        UpdateInstallReceiver().onReceive(app, status(PackageInstaller.STATUS_PENDING_USER_ACTION, confirm = confirmIntent()))
        val started = shadowOf(app).nextStartedActivity
        assertEquals("android.content.pm.action.CONFIRM_INSTALL", started.action)
        assertTrue(started.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertNull(InstallEvents.pendingConfirm)
        assertTrue(seen.isEmpty())
    }

    @Test fun pendingUserActionInBackgroundIsKept() {
        InstallEvents.foreground = false
        UpdateInstallReceiver().onReceive(app, status(PackageInstaller.STATUS_PENDING_USER_ACTION, confirm = confirmIntent()))
        assertNull(shadowOf(app).nextStartedActivity)
        assertEquals("android.content.pm.action.CONFIRM_INSTALL", InstallEvents.pendingConfirm?.action)

        assertTrue(AndroidApkInstall(app).launchPendingConfirm())
        val started = shadowOf(app).nextStartedActivity
        assertEquals("android.content.pm.action.CONFIRM_INSTALL", started.action)
        assertTrue(started.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertNull(InstallEvents.pendingConfirm)
    }

    @Test fun abortedIsCanceled() {
        UpdateInstallReceiver().onReceive(app, status(PackageInstaller.STATUS_FAILURE_ABORTED, message = "User rejected permissions"))
        assertEquals(listOf<InstallEvent>(InstallEvent.Canceled), seen)
    }

    @Test fun aFailureCarriesItsMessage() {
        UpdateInstallReceiver().onReceive(app, status(PackageInstaller.STATUS_FAILURE_CONFLICT, message = "x"))
        assertEquals(listOf<InstallEvent>(InstallEvent.Failed("The install didn't finish: x")), seen)
    }

    @Test fun aFailureWithoutAMessageCarriesTheStatus() {
        UpdateInstallReceiver().onReceive(app, status(PackageInstaller.STATUS_FAILURE_INVALID))
        assertEquals(listOf<InstallEvent>(InstallEvent.Failed("The install didn't finish: 4")), seen)
    }

    @Test fun successEmitsNothing() {
        UpdateInstallReceiver().onReceive(app, status(PackageInstaller.STATUS_SUCCESS))
        UpdateInstallReceiver().onReceive(app, Intent(app, UpdateInstallReceiver::class.java))   // no status at all
        assertTrue(seen.isEmpty())
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test fun eventsWaitingForASlowCollectorAreNotDropped() = runBlocking {
        collector?.cancel()
        val slow = mutableListOf<InstallEvent>()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val job = launch(Dispatchers.Unconfined) { InstallEvents.events.collect { gate.await(); slow += it } }
        repeat(3) { InstallEvents.onStatus(app, status(PackageInstaller.STATUS_FAILURE_ABORTED)) }   // never suspends
        gate.complete(Unit)
        kotlinx.coroutines.yield()
        assertEquals(3, slow.size)
        assertSame(InstallEvent.Canceled, slow.first())
        job.cancel()
    }
}
