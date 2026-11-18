package com.serversherpa.kiosk.data.update

import com.serversherpa.kiosk.core.update.NO_DEVICES_HOST
import com.serversherpa.kiosk.core.update.RECHECK_INTERVAL_MS
import com.serversherpa.kiosk.core.update.UpdateAnswer
import com.serversherpa.kiosk.core.update.UpdateOffer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.fakeSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class DirectAppUpdatesTest {
    private val dispatcher = StandardTestDispatcher()
    private val scope = TestScope(dispatcher)
    private val auth = MutableStateFlow<AuthState>(AuthState.Anon)
    private val front = MutableStateFlow(true)
    private val events = MutableSharedFlow<InstallEvent>(extraBufferCapacity = 16)
    private var now = 1_000_000L
    private val pkg = "com.serversherpa.kiosk"

    private val checker = FakeChecker()
    private val source = FakeSource()
    private val installer = FakeInstall()

    private fun offer(build: Long = 3) = UpdateOffer("1.$build.0", build, "Fixes", 1234, "https://devices.test/d/$build")

    private fun updates() = DirectAppUpdates(
        checker, source, installer, pkg, auth, front, scope,
        events = events, clock = { now }, io = dispatcher,
    )

    private fun signedIn() { auth.value = AuthState.Authed(fakeSession()) }

    /** Started, signed in, in front, with build 3 on offer. */
    private fun available(): DirectAppUpdates {
        checker.answer = { UpdateAnswer.Available(offer()) }
        val u = updates()
        u.start()
        signedIn()
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now), u.state.value)
        return u
    }

    private fun bounce() {
        front.value = false
        scope.runCurrent()
        front.value = true
        scope.runCurrent()
    }

    @Before fun setUp() = InstallEvents.resetForTest()

    @After fun tearDown() {
        scope.cancel()
        InstallEvents.resetForTest()
    }

    @Test fun checksOnceWhenSignedInAndInFront() {
        val u = updates()
        assertTrue(u.supported)
        u.start()
        scope.runCurrent()
        assertEquals(0, checker.calls)
        assertEquals(UpdateState.Idle, u.state.value)

        signedIn()
        scope.runCurrent()
        assertEquals(1, checker.calls)
        assertEquals(UpdateState.UpToDate(now), u.state.value)
    }

    @Test fun mirrorsTheFrontIntoInstallEvents() {
        updates().start()
        scope.runCurrent()
        assertTrue(InstallEvents.foreground)
        front.value = false
        scope.runCurrent()
        assertFalse(InstallEvents.foreground)
    }

    @Test fun rechecksOnReturnOnlyAfterAnHour() {
        updates().start()
        signedIn()
        scope.runCurrent()
        assertEquals(1, checker.calls)

        now += RECHECK_INTERVAL_MS - 60_000
        bounce()
        assertEquals(1, checker.calls)

        now += 60_000
        bounce()
        assertEquals(2, checker.calls)
    }

    @Test fun checkButtonAlwaysChecksAndCoalesces() {
        val u = updates()
        u.start()
        signedIn()
        scope.runCurrent()
        assertEquals(1, checker.calls)

        val gate = CompletableDeferred<UpdateAnswer>()
        checker.answer = { gate.await() }
        u.check()   // within the hour: the button still checks
        scope.runCurrent()
        assertEquals(2, checker.calls)
        assertEquals(UpdateState.Checking, u.state.value)
        u.check()
        scope.runCurrent()
        assertEquals(2, checker.calls)

        gate.complete(UpdateAnswer.UpToDate)
        scope.runCurrent()
        assertEquals(UpdateState.UpToDate(now), u.state.value)
    }

    @Test fun signedOutCheckDoesNothing() {
        val u = updates()
        u.start()
        scope.runCurrent()
        u.check()
        scope.runCurrent()
        assertEquals(0, checker.calls)
        assertEquals(UpdateState.Idle, u.state.value)
    }

    @Test fun signingOutKeepsTheLastState() {
        val u = available()
        auth.value = AuthState.Anon
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now), u.state.value)
    }

    @Test fun availableShowsTheBanner() {
        val u = available()
        assertTrue(u.homeBannerVisible.value)
    }

    @Test fun laterHidesItForThatBuildOnly() {
        val u = available()
        u.later()
        scope.runCurrent()
        assertFalse(u.homeBannerVisible.value)

        u.check()
        scope.runCurrent()
        assertFalse(u.homeBannerVisible.value)   // build 3 again: still snoozed

        checker.answer = { UpdateAnswer.Available(offer(4)) }
        u.check()
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(4), now), u.state.value)
        assertTrue(u.homeBannerVisible.value)
    }

    @Test fun blockedShowsTheBannerWithoutAnOffer() {
        val msg = "Reinstall this app from the Devices site to keep getting updates."
        checker.answer = { UpdateAnswer.Blocked(msg) }
        val u = updates()
        u.start()
        signedIn()
        scope.runCurrent()
        assertEquals(UpdateState.Blocked(msg, now), u.state.value)
        assertTrue(u.homeBannerVisible.value)

        u.later()
        scope.runCurrent()
        assertFalse(u.homeBannerVisible.value)
    }

    @Test fun unavailableNeverShowsTheBanner() {
        checker.answer = { UpdateAnswer.Blocked(NO_DEVICES_HOST) }
        val u = updates()
        u.start()
        signedIn()
        scope.runCurrent()
        assertEquals(UpdateState.Unavailable(NO_DEVICES_HOST), u.state.value)
        assertFalse(u.homeBannerVisible.value)
    }

    @Test fun aFailedCheckHidesTheBanner() {
        val u = available()
        checker.answer = { throw UpdateError("m") }
        u.check()
        scope.runCurrent()
        assertEquals(UpdateState.Failed("m", now), u.state.value)
        assertFalse(u.homeBannerVisible.value)
        assertTrue(auth.value is AuthState.Authed)
    }

    @Test fun anUnexpectedCheckErrorGetsTheGenericCopy() {
        checker.answer = { throw IllegalStateException("boom") }
        val u = updates()
        u.start()
        signedIn()
        scope.runCurrent()
        assertEquals(UpdateState.Failed("Couldn't check for updates. Try again later.", now), u.state.value)
    }

    @Test fun updateWithoutPermissionOpensSettingsThenContinues() {
        val u = available()
        installer.canInstall = false
        u.update()
        scope.runCurrent()
        assertEquals(1, installer.settingsOpened)
        assertEquals(0, source.fetches)

        val fresh = offer().copy(installUrl = "https://devices.test/d/3-fresh")
        checker.answer = { UpdateAnswer.Available(fresh) }
        installer.canInstall = true
        bounce()
        assertEquals(2, checker.calls)   // the trip may have taken long enough for the link to expire
        assertEquals(listOf(fresh.installUrl), source.fetched.map { it.installUrl })
        assertEquals(listOf(Triple(pkg, 3L, "1.3.0")), installer.checked)
        assertEquals(listOf(source.file), installer.installed)
        assertEquals(UpdateState.Installing(fresh), u.state.value)
    }

    @Test fun permissionStillOffShowsTheNotice() {
        val u = available()
        installer.canInstall = false
        u.update()
        scope.runCurrent()
        bounce()
        assertEquals(0, source.fetches)
        assertEquals(
            UpdateState.Available(offer(), now, notice = "Installs from this app are off. Turn on Allow from this source, then tap Update."),
            u.state.value,
        )
        bounce()   // the trip is over: a later return doesn't repeat it
        assertEquals(1, installer.settingsOpened)
    }

    @Test fun downloadProgressThenInstall() {
        val u = available()
        val gate = CompletableDeferred<Unit>()
        source.progress = listOf(0.5f)
        source.gate = gate
        u.update()
        scope.runCurrent()
        assertEquals(UpdateState.Downloading(offer(), fraction = 0.5f), u.state.value)
        assertTrue(u.homeBannerVisible.value)

        u.check()   // busy: no check
        scope.runCurrent()
        assertEquals(2, checker.calls)   // the first check and update()'s re-check

        gate.complete(Unit)
        scope.runCurrent()
        assertEquals(UpdateState.Installing(offer()), u.state.value)
        assertEquals(1, installer.installed.size)
    }

    @Test fun updateRechecksAndDownloadsTheFreshLink() {
        val u = available()
        now += 31 * 60_000L   // the offer's link has expired by now
        val gate = CompletableDeferred<UpdateAnswer>()
        checker.answer = { gate.await() }
        u.update()
        assertEquals(UpdateState.Downloading(offer(), null), u.state.value)   // the button reacts at once
        scope.runCurrent()
        assertEquals(2, checker.calls)
        assertEquals(0, source.fetches)

        val fresh = offer().copy(installUrl = "https://devices.test/d/3-fresh")
        gate.complete(UpdateAnswer.Available(fresh))
        scope.runCurrent()
        assertEquals(listOf(fresh.installUrl), source.fetched.map { it.installUrl })
        assertEquals(UpdateState.Installing(fresh), u.state.value)
    }

    @Test fun updateTakesANewerBuildOnOffer() {
        val u = available()
        checker.answer = { UpdateAnswer.Available(offer(4)) }
        u.update()
        scope.runCurrent()
        assertEquals(listOf(offer(4)), source.fetched)
        assertEquals(listOf(Triple(pkg, 4L, "1.4.0")), installer.checked)
        assertEquals(UpdateState.Installing(offer(4)), u.state.value)
    }

    @Test fun updateShowsAnOlderOfferWithoutDownloading() {
        val u = available()
        now += 60_000
        checker.answer = { UpdateAnswer.Available(offer(2)) }
        u.update()
        scope.runCurrent()
        assertEquals(0, source.fetches)
        assertEquals(UpdateState.Available(offer(2), now), u.state.value)
    }

    @Test fun aFailedRecheckKeepsTheOfferAndDoesNotDownload() {
        val u = available()
        now += 31 * 60_000L
        checker.answer = { throw UpdateError("m") }
        u.update()
        scope.runCurrent()
        assertEquals(0, source.fetches)
        assertEquals(UpdateState.Available(offer(), 1_000_000L, notice = "m"), u.state.value)
        assertTrue(u.homeBannerVisible.value)

        checker.answer = { throw IllegalStateException("boom") }
        u.update()
        scope.runCurrent()
        assertEquals(0, source.fetches)
        assertEquals(UpdateState.Available(offer(), 1_000_000L, notice = "Couldn't check for updates. Try again later."), u.state.value)
    }

    @Test fun anUpToDateRecheckInstallsNothing() {
        val u = available()
        now += 60_000
        checker.answer = { UpdateAnswer.UpToDate }
        u.update()
        scope.runCurrent()
        assertEquals(0, source.fetches)
        assertEquals(UpdateState.UpToDate(now), u.state.value)
        assertFalse(u.homeBannerVisible.value)
    }

    @Test fun aBlockedRecheckShowsTheMessage() {
        val u = available()
        now += 60_000
        checker.answer = { UpdateAnswer.Blocked("Reinstall") }
        u.update()
        scope.runCurrent()
        assertEquals(0, source.fetches)
        assertEquals(UpdateState.Blocked("Reinstall", now), u.state.value)
    }

    @Test fun aDownloadRefusalShowsItsMessage() {
        val u = available()
        source.error = UpdateError("The download was cut short. Try again.")
        u.update()
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now, notice = "The download was cut short. Try again."), u.state.value)
        assertTrue(installer.installed.isEmpty())
    }

    @Test fun anUnexpectedDownloadErrorGetsTheGenericCopy() {
        val u = available()
        source.error = java.io.IOException("disk full")
        u.update()
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now, notice = "The download failed. Try again."), u.state.value)
    }

    @Test fun aBadArchiveIsDeletedAndReported() {
        val u = available()
        val clearsBefore = source.clears
        installer.archiveNotice = "x"
        u.update()
        scope.runCurrent()
        assertEquals(clearsBefore + 1, source.clears)
        assertEquals(UpdateState.Available(offer(), now, notice = "x"), u.state.value)
        assertTrue(installer.installed.isEmpty())
    }

    @Test fun cancelReturnsToAvailable() {
        val u = available()
        u.update()
        scope.runCurrent()
        assertEquals(UpdateState.Installing(offer()), u.state.value)
        val clearsBefore = source.clears

        events.tryEmit(InstallEvent.Canceled)
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now, notice = "Install canceled."), u.state.value)
        assertEquals(clearsBefore + 1, source.clears)

        u.update()
        scope.runCurrent()
        events.tryEmit(InstallEvent.Failed("m"))
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now, notice = "m"), u.state.value)
        assertEquals(clearsBefore + 2, source.clears)
    }

    @Test fun anInstallEventOutsideInstallingIsIgnored() {
        val u = available()
        events.tryEmit(InstallEvent.Canceled)
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now), u.state.value)
    }

    @Test fun returningToTheFrontLaunchesAPendingConfirm() {
        val u = available()
        u.update()
        scope.runCurrent()
        assertEquals(UpdateState.Installing(offer()), u.state.value)
        assertEquals(0, installer.confirmsLaunched)

        bounce()
        assertEquals(1, installer.confirmsLaunched)
    }

    @Test fun returningWithNoConfirmLeftEndsTheInstall() {
        val u = available()
        u.update()
        scope.runCurrent()
        val clearsBefore = source.clears
        installer.confirmResult = { false }   // e.g. Home from the confirm screen, then back to the kiosk

        bounce()
        scope.advanceTimeBy(1_499)
        scope.runCurrent()
        assertEquals(UpdateState.Installing(offer()), u.state.value)   // an installer event may still be on its way
        assertEquals(clearsBefore, source.clears)
        scope.advanceTimeBy(1)
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now, notice = "The install didn't finish. Tap Update to try again."), u.state.value)
        assertEquals(clearsBefore + 1, source.clears)

        events.tryEmit(InstallEvent.Canceled)   // late: ignored
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now, notice = "The install didn't finish. Tap Update to try again."), u.state.value)
        assertEquals(clearsBefore + 1, source.clears)
    }

    @Test fun aCancelArrivingJustAfterTheReturnSaysCanceled() {
        val u = available()
        u.update()
        scope.runCurrent()
        val clearsBefore = source.clears
        installer.confirmResult = { false }   // Back on the confirm screen: the ABORTED broadcast lags the return

        bounce()
        scope.advanceTimeBy(1_000)
        scope.runCurrent()
        events.tryEmit(InstallEvent.Canceled)
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now, notice = "Install canceled."), u.state.value)

        scope.advanceTimeBy(1_000)   // past the wait: nothing replaces the canceled notice
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now, notice = "Install canceled."), u.state.value)
        assertEquals(clearsBefore + 1, source.clears)
    }

    @Test fun aConfirmThatWontOpenClearsTheFiles() {
        val u = available()
        u.update()
        scope.runCurrent()
        val clearsBefore = source.clears
        installer.confirmResult = { throw IllegalStateException("no activity") }

        bounce()
        assertEquals(UpdateState.Available(offer(), now, notice = "The install failed. Try again."), u.state.value)
        assertEquals(clearsBefore + 1, source.clears)
    }

    @Test fun aBackgroundRecheckKeepsTheOfferUntilTheAnswer() {
        val u = available()
        val gate = CompletableDeferred<UpdateAnswer>()
        checker.answer = { gate.await() }
        now += RECHECK_INTERVAL_MS
        bounce()
        assertEquals(2, checker.calls)
        assertEquals(UpdateState.Available(offer(), 1_000_000L), u.state.value)
        assertTrue(u.homeBannerVisible.value)

        gate.complete(UpdateAnswer.UpToDate)
        scope.runCurrent()
        assertEquals(UpdateState.UpToDate(now), u.state.value)
        assertFalse(u.homeBannerVisible.value)
    }

    @Test fun aFailedBackgroundRecheckKeepsTheOffer() {
        val u = available()
        checker.answer = { throw UpdateError("m") }
        now += RECHECK_INTERVAL_MS
        bounce()
        assertEquals(2, checker.calls)
        assertEquals(UpdateState.Available(offer(), 1_000_000L), u.state.value)
        assertTrue(u.homeBannerVisible.value)
    }

    @Test fun aFailedBackgroundRecheckKeepsBlocked() {
        checker.answer = { UpdateAnswer.Blocked("Reinstall") }
        val u = updates()
        u.start()
        signedIn()
        scope.runCurrent()
        checker.answer = { throw IllegalStateException("boom") }
        now += RECHECK_INTERVAL_MS
        bounce()
        assertEquals(2, checker.calls)
        assertEquals(UpdateState.Blocked("Reinstall", 1_000_000L), u.state.value)
        assertTrue(u.homeBannerVisible.value)
    }

    @Test fun anUpdateDuringABackgroundRecheckWins() {
        val u = available()
        val gate = CompletableDeferred<UpdateAnswer>()
        // The background recheck waits on the gate; update()'s own re-check answers at once.
        checker.answer = { if (checker.calls == 2) gate.await() else UpdateAnswer.Available(offer()) }
        now += RECHECK_INTERVAL_MS
        bounce()
        u.update()
        scope.runCurrent()
        assertEquals(UpdateState.Installing(offer()), u.state.value)

        gate.complete(UpdateAnswer.UpToDate)
        scope.runCurrent()
        assertEquals(UpdateState.Installing(offer()), u.state.value)
    }

    @Test fun aClearThatThrowsKeepsEventsFlowing() {
        source.clearError = IllegalStateException("read-only")
        val u = available()
        u.update()
        scope.runCurrent()
        events.tryEmit(InstallEvent.Canceled)
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now, notice = "Install canceled."), u.state.value)

        u.update()
        scope.runCurrent()
        events.tryEmit(InstallEvent.Failed("m"))
        scope.runCurrent()
        assertEquals(UpdateState.Available(offer(), now, notice = "m"), u.state.value)
    }

    @Test fun returningToTheFrontOutsideInstallingDiscardsAPendingConfirm() {
        available()
        val stale = android.content.Intent()
        InstallEvents.pendingConfirm = stale
        bounce()
        assertEquals(0, installer.confirmsLaunched)
        assertEquals(null, InstallEvents.pendingConfirm)
    }

    @Test fun startClearsOldDownloadsAndSessions() {
        updates().start()
        scope.runCurrent()
        assertEquals(1, source.clears)
        assertEquals(1, installer.abandons)
    }

    @Test fun anAbandonThatThrowsDoesNotStopStart() {
        installer.abandonError = IllegalStateException("no installer")
        val u = available()   // started, checked and offered as usual
        assertEquals(1, installer.abandons)
        assertEquals(1, source.clears)
        assertTrue(u.homeBannerVisible.value)
    }

    private class FakeChecker : UpdateChecker {
        var calls = 0
        var answer: suspend () -> UpdateAnswer = { UpdateAnswer.UpToDate }
        override suspend fun check(): UpdateAnswer {
            calls++
            return answer()
        }
    }

    private class FakeSource : ApkSource {
        var fetches = 0
        val fetched = mutableListOf<UpdateOffer>()
        var clears = 0
        val file = File("3.apk")
        var progress: List<Float?> = emptyList()
        var gate: CompletableDeferred<Unit>? = null
        var error: Exception? = null
        var clearError: RuntimeException? = null
        override suspend fun fetch(offer: UpdateOffer, onProgress: (Float?) -> Unit): File {
            fetches++
            fetched += offer
            progress.forEach(onProgress)
            gate?.await()
            error?.let { throw it }
            return file
        }
        override fun clear() {
            clears++
            clearError?.let { throw it }
        }
    }

    private class FakeInstall : ApkInstall {
        var canInstall = true
        var settingsOpened = 0
        var archiveNotice: String? = null
        val checked = mutableListOf<Triple<String, Long, String>>()
        val installed = mutableListOf<File>()
        var confirmsLaunched = 0
        var confirmResult: () -> Boolean = { true }
        var abandons = 0
        var abandonError: RuntimeException? = null
        override fun canRequestInstalls() = canInstall
        override fun openInstallPermissionSettings() { settingsOpened++ }
        override fun checkArchive(file: File, packageName: String, build: Long, versionName: String): String? {
            checked += Triple(packageName, build, versionName)
            return archiveNotice
        }
        override fun install(file: File) { installed += file }
        override fun launchPendingConfirm(): Boolean {
            confirmsLaunched++
            return confirmResult()
        }
        override fun abandonSessions() {
            abandons++
            abandonError?.let { throw it }
        }
    }
}
