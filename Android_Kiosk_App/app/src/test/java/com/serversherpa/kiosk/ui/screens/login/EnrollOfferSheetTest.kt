package com.serversherpa.kiosk.ui.screens.login

import android.app.Application
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskMove
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.auth.BIOMETRIC_ENROLL_FAILED_MESSAGE
import com.serversherpa.kiosk.data.auth.BIOMETRIC_UNSUPPORTED_MESSAGE
import com.serversherpa.kiosk.data.auth.BiometricPrompter
import com.serversherpa.kiosk.data.auth.BiometricReadiness
import com.serversherpa.kiosk.data.auth.FakeBiometricKeys
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.prefs.BiometricEnrollment
import com.serversherpa.kiosk.data.station.TIMECLOCK_STATION
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.waitUntilIdlingMain
import java.io.File
import java.io.IOException
import java.security.Signature
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Turn on sheet after a password sign-in, at 320 dp. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w320dp-h533dp")
class EnrollOfferSheetTest {
    @get:Rule val compose = createComposeRule()

    private class FakePrompter(var answer: suspend (Signature) -> Signature? = { it }) : BiometricPrompter {
        @Volatile var calls = 0
        override suspend fun authenticate(signature: Signature): Signature? { calls++; return answer(signature) }
    }

    /** Prefs whose biometric writes can be made to fail (a full disk). */
    private class FlakyStore(private val real: DataStore<Preferences>) : DataStore<Preferences> {
        @Volatile var failBiometricWrites = false
        private val key = stringPreferencesKey("ss.kiosk.biometric")
        override val data = real.data
        override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences = real.updateData { p ->
            val next = transform(p)
            if (failBiometricWrites && next[key] != null && next[key] != p[key]) throw IOException("disk full")
            next
        }
    }

    private class Phone(val c: AppContainer, val api: FakeKioskApi, val keys: FakeBiometricKeys, val store: FlakyStore)

    /** Tina's own phone, signed out, with a fingerprint set up in Android: the server will let her enroll. */
    private fun personalPhone(readiness: BiometricReadiness = BiometricReadiness.READY): Phone {
        val api = FakeKioskApi().apply {
            loginResult = { fakeSession() }
            moveLoginResult = { fakeSession(kioskMove = KioskMove("m1", "Dallas Move")) }
        }
        val keys = FakeBiometricKeys(readiness)
        val app = ApplicationProvider.getApplicationContext<Application>()
        val real = PreferenceDataStoreFactory.create(scope = CoroutineScope(Dispatchers.IO + SupervisorJob())) {
            File(app.cacheDir, "enroll-offer-${UUID.randomUUID()}.preferences_pb")
        }
        val store = FlakyStore(real)
        val c = testContainer(api = api, biometricKeys = keys, dataStore = store)
        runBlocking { c.identity.get() }
        return Phone(c, api, keys, store)
    }

    private lateinit var nav: NavHostController

    /** The app's shape: the sign-in screen and Home in a NavHost, with the offer's host beside it. */
    private fun showApp(p: Phone, prompter: BiometricPrompter) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides p.c, LocalBiometricPrompter provides prompter) {
                KioskTheme {
                    Box {
                        nav = rememberNavController()
                        NavHost(nav, startDestination = Routes.LOGIN) {
                            composable(Routes.LOGIN) { LoginScreen(nav) }
                            composable(Routes.HOME) { Text("HOME SCREEN") }
                        }
                        EnrollOfferHost(p.c.enrollOffer)
                    }
                }
            }
        }
    }

    private fun waitForText(text: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    private fun waitGone(text: String) =
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isEmpty() }

    private fun signInWithPassword() {
        compose.onNodeWithTag("login-email").performTextInput("tina@example.com")
        compose.onNodeWithTag("login-password").performTextInput("pw")
        compose.onNodeWithTag("login-submit").performScrollTo().performClick()
        waitForText("HOME SCREEN")
    }

    private fun signOutToLogin(p: Phone) {
        runBlocking { p.c.auth.logout() }
        compose.runOnUiThread { nav.navigate(Routes.LOGIN) { popUpTo(0) } }
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("login-email").fetchSemanticsNodes().isNotEmpty() }
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTag(tag: String) =
        onAllNodes(androidx.compose.ui.test.hasTestTag(tag))

    // ── the offer ───────────────────────────────────────────────────

    @Test fun enrollOfferAfterPasswordSignInOnPersonalDevice() {
        val p = personalPhone()
        val prompter = FakePrompter()
        showApp(p, prompter)
        signInWithPassword()
        waitForText(ENROLL_OFFER_TEXT)
        compose.onNodeWithText(ENROLL_OFFER_TEXT).assertIsDisplayed()
        compose.onNodeWithText("Not now").assertIsDisplayed()
        compose.onNodeWithText("Turn on").performClick()
        compose.waitUntilIdlingMain { runBlocking { p.c.prefs.biometric.first() } != null }
        assertEquals(BiometricEnrollment("key-1", "p1", "tina@example.com"), runBlocking { p.c.prefs.biometric.first() })
        assertEquals(1, prompter.calls)
        waitGone(ENROLL_OFFER_TEXT)
        compose.onNodeWithText("HOME SCREEN").assertIsDisplayed()
    }

    @Test fun notNowAsksAgainNextPasswordSignIn() {
        val p = personalPhone()
        val prompter = FakePrompter()
        showApp(p, prompter)
        signInWithPassword()
        waitForText(ENROLL_OFFER_TEXT)
        compose.onNodeWithText("Not now").performClick()
        waitGone(ENROLL_OFFER_TEXT)
        assertNull(runBlocking { p.c.prefs.biometric.first() })
        assertEquals(0, prompter.calls)
        assertFalse(p.keys.hasKey)

        signOutToLogin(p)
        signInWithPassword()
        waitForText(ENROLL_OFFER_TEXT)
        compose.onNodeWithText("Turn on").assertIsDisplayed()
    }

    @Test fun theSignInNeverWaitsForTheOffer() {
        val p = personalPhone()
        val answer = CompletableDeferred<String>()
        p.api.bioEnrollChallengeResult = { answer.await() }
        showApp(p, FakePrompter())
        signInWithPassword()                       // Home while the offer is still being decided
        compose.onNodeWithText(ENROLL_OFFER_TEXT).assertDoesNotExist()
        answer.complete("nonce-1")
        waitForText(ENROLL_OFFER_TEXT)
    }

    @Test fun noOfferWhenSignedOutBeforeTheAnswer() {
        val p = personalPhone()
        val answer = CompletableDeferred<String>()
        p.api.bioEnrollChallengeResult = { answer.await() }
        showApp(p, FakePrompter())
        signInWithPassword()
        compose.waitUntilIdlingMain { "bioEnrollChallenge" in p.api.calls }
        signOutToLogin(p)
        answer.complete("nonce-1")
        compose.waitForIdle()
        Thread.sleep(200)
        compose.waitForIdle()
        compose.onNodeWithText(ENROLL_OFFER_TEXT).assertDoesNotExist()
        assertNull(p.c.enrollOffer.state.value)
    }

    @Test fun noOfferWhenSomeoneElseIsSignedInByTheAnswer() {
        val p = personalPhone()
        val answer = CompletableDeferred<String>()
        p.api.bioEnrollChallengeResult = { answer.await() }
        runBlocking { p.c.auth.login("tina@example.com", "pw") }
        p.c.enrollOffer.afterPasswordSignIn()
        compose.waitUntilIdlingMain { "bioEnrollChallenge" in p.api.calls }
        p.c.auth.completePair(fakeSession(personId = "p2"))       // straight to another person, never signed out
        answer.complete("nonce-1")
        Thread.sleep(200)
        compose.waitForIdle()
        assertNull(p.c.enrollOffer.state.value)
    }

    @Test fun signingOutClosesTheSheet() {
        val p = personalPhone()
        showApp(p, FakePrompter())
        signInWithPassword()
        waitForText(ENROLL_OFFER_TEXT)
        signOutToLogin(p)
        waitGone(ENROLL_OFFER_TEXT)
    }

    @Test fun noOfferWithoutAFingerprintInAndroid() {
        val p = personalPhone(BiometricReadiness.NONE_ENROLLED)
        showApp(p, FakePrompter())
        signInWithPassword()
        compose.waitForIdle()
        compose.onNodeWithText(ENROLL_OFFER_TEXT).assertDoesNotExist()
        assertFalse("bioEnrollChallenge" in p.api.calls)
    }

    @Test fun noOfferAfterAMovePasswordOrOnATimeClockStation() {
        val p = personalPhone()
        showApp(p, FakePrompter())
        compose.onNodeWithText("Move password").performScrollTo().performClick()
        compose.onNodeWithTag("login-move").performTextInput("orange-kayak-42")
        compose.onNodeWithTag("login-submit-move").performScrollTo().performClick()
        waitForText("HOME SCREEN")
        compose.waitForIdle()
        compose.onNodeWithText(ENROLL_OFFER_TEXT).assertDoesNotExist()
        assertFalse("bioEnrollChallenge" in p.api.calls)

        // A Time Clock station: a person's password sign-in there (Settings, Start Time Clock) is never offered it.
        signOutToLogin(p)
        runBlocking { p.c.prefs.setSetupSelection(KioskSetupSelection(stationType = TIMECLOCK_STATION)) }
        signInWithPassword()
        compose.waitForIdle()
        compose.onNodeWithText(ENROLL_OFFER_TEXT).assertDoesNotExist()
        assertFalse("bioEnrollChallenge" in p.api.calls)
    }

    @Test fun noOfferWhileThePasswordMustChange() {
        val p = personalPhone()
        p.api.loginResult = { fakeSession(mustChange = true) }
        showApp(p, FakePrompter())
        signInWithPassword()
        compose.waitForIdle()
        compose.onNodeWithText(ENROLL_OFFER_TEXT).assertDoesNotExist()
        assertFalse("bioEnrollChallenge" in p.api.calls)
    }

    // ── Turn on's outcomes ──────────────────────────────────────────

    @Test fun aFailedPrefsWriteShowsTheEnrollFailure() {
        val p = personalPhone()
        p.store.failBiometricWrites = true
        showApp(p, FakePrompter())
        signInWithPassword()
        waitForText(ENROLL_OFFER_TEXT)
        compose.onNodeWithText("Turn on").performClick()
        waitForText(BIOMETRIC_ENROLL_FAILED_MESSAGE)
        compose.onNodeWithText(ENROLL_OFFER_TEXT).assertIsDisplayed()
        assertFalse(p.keys.hasKey)
    }

    @Test fun attestationRefusedSaysThisPhoneCantUseIt() {
        val p = personalPhone()
        p.api.bioEnrollResult = { _, _, _ -> throw ApiError(422, "attestation_failed") }
        showApp(p, FakePrompter())
        signInWithPassword()
        waitForText(ENROLL_OFFER_TEXT)
        compose.onNodeWithText("Turn on").performClick()
        waitForText(BIOMETRIC_UNSUPPORTED_MESSAGE)
        assertNull(runBlocking { p.c.prefs.biometric.first() })
    }

    @Test fun aCanceledPromptKeepsTheSheetWithNoMessage() {
        val p = personalPhone()
        val prompter = FakePrompter { null }
        showApp(p, prompter)
        signInWithPassword()
        waitForText(ENROLL_OFFER_TEXT)
        compose.onNodeWithText("Turn on").performClick()
        compose.waitUntilIdlingMain { prompter.calls == 1 }
        compose.waitUntil(5_000) { p.c.enrollOffer.state.value?.busy == false }
        compose.onNodeWithText(ENROLL_OFFER_TEXT).assertIsDisplayed()
        compose.onNodeWithText("Turn on").assertIsDisplayed()
        assertNull(p.c.enrollOffer.state.value?.message)
    }

    @Test fun lockoutDuringTurnOnHasItsOwnMessage() {
        val p = personalPhone()
        showApp(p, FakePrompter { throw BiometricLockedOut() })
        signInWithPassword()
        waitForText(ENROLL_OFFER_TEXT)
        compose.onNodeWithText("Turn on").performClick()
        waitForText(BIOMETRIC_LOCKOUT_MESSAGE)
    }

    @Test fun theSheetFits320dp() {
        val p = personalPhone()
        showApp(p, FakePrompter())
        signInWithPassword()
        waitForText(ENROLL_OFFER_TEXT)
        for (text in listOf(ENROLL_OFFER_TEXT, "Turn on", "Not now")) {
            val b = compose.onNodeWithText(text).assertIsDisplayed().getBoundsInRoot()
            assertTrue("$text starts on screen", b.left >= 0.dp)
            assertTrue("$text ends inside 320 dp (${b.right})", b.right <= 320.dp)
        }
        assertTrue(compose.onNodeWithTag("enroll-offer-sheet").getBoundsInRoot().right <= 320.dp)
    }
}
