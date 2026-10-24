package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.AppContainer
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.BiometricChallengeOut
import com.serversherpa.kiosk.core.model.KioskMove
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.auth.BIOMETRIC_EXPIRED_MESSAGE
import com.serversherpa.kiosk.data.auth.BIOMETRIC_PASSWORD_CHANGE_MESSAGE
import com.serversherpa.kiosk.data.auth.BIOMETRIC_REMOVED_MESSAGE
import com.serversherpa.kiosk.data.auth.BiometricPrompter
import com.serversherpa.kiosk.data.auth.BiometricReadiness
import com.serversherpa.kiosk.data.auth.FakeBiometricKeys
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.prefs.BiometricEnrollment
import com.serversherpa.kiosk.data.station.TIMECLOCK_STATION
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.screens.settings.FINGERPRINT_NOT_YOURS_TEXT
import com.serversherpa.kiosk.ui.screens.settings.FINGERPRINT_OFF_TEXT
import com.serversherpa.kiosk.ui.screens.settings.ThisKioskPanel
import com.serversherpa.kiosk.ui.theme.KioskTheme
import com.serversherpa.kiosk.waitUntilIdlingMain
import java.security.Signature
import kotlinx.coroutines.CompletableDeferred
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

/** The "Sign in as …" card, its fallbacks, and Settings › This Kiosk's Forget, on a 320 dp phone. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w320dp-h533dp")
class BiometricLoginTest {
    @get:Rule val compose = createComposeRule()

    /** Counts prompts; answers with [answer] (cancel by default). */
    private class FakePrompter(var answer: suspend (Signature) -> Signature? = { null }) : BiometricPrompter {
        @Volatile var calls = 0
        override suspend fun authenticate(signature: Signature): Signature? { calls++; return answer(signature) }
    }

    private class Phone(val c: AppContainer, val api: FakeKioskApi, val keys: FakeBiometricKeys)

    private fun challenge(expired: Boolean = false, keyId: String = "key-1") =
        BiometricChallengeOut(keyId, "chal.lenge.1", "Tina T", null, expired)

    /** A phone Tina enrolled on, signed out: the next launch's sign-in screen. */
    private fun enrolledPhone(expired: Boolean = false, enrolled: Boolean = true): Phone {
        val api = FakeKioskApi().apply {
            loginResult = { fakeSession() }
            moveLoginResult = { fakeSession(kioskMove = KioskMove("m1", "Dallas Move")) }
            bioChallengeResult = { challenge(expired) }
        }
        val keys = FakeBiometricKeys(BiometricReadiness.READY)
        val c = testContainer(api = api, biometricKeys = keys)
        if (enrolled) runBlocking {
            c.prefs.setBiometric(BiometricEnrollment("key-1", "p1", "tina@example.com"))
            keys.create(ByteArray(32))
        }
        runBlocking { c.identity.get() }
        return Phone(c, api, keys)
    }

    private fun showLogin(p: Phone, prompter: BiometricPrompter) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides p.c, LocalBiometricPrompter provides prompter) {
                KioskTheme {
                    val nav = rememberNavController()
                    NavHost(nav, startDestination = Routes.LOGIN) {
                        composable(Routes.LOGIN) { LoginScreen(nav) }
                        composable(Routes.HOME) { Text("HOME SCREEN") }
                    }
                }
            }
        }
    }

    private fun waitForText(text: String, substring: Boolean = false) =
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty() }

    // ── the card ────────────────────────────────────────────────────

    @Test fun cardShowsNameAndOtherAccount() {
        val p = enrolledPhone()
        val prompter = FakePrompter()
        showLogin(p, prompter)
        waitForText("Sign in as Tina T")
        compose.onNodeWithText("Sign in as Tina T").assertIsDisplayed()
        compose.onNodeWithText("Use password").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Other account").performScrollTo().assertIsDisplayed()
        // The prompt started on its own, once; canceling it leaves the person on the card.
        compose.waitUntilIdlingMain { prompter.calls == 1 }
        compose.onNodeWithText("Sign in as Tina T").assertIsDisplayed()
        compose.onNodeWithTag("login-email").assertDoesNotExist()
    }

    @Test fun aFingerprintSignsInAndGoesHome() {
        val p = enrolledPhone()
        showLogin(p, FakePrompter { it })
        waitForText("HOME SCREEN")
        assertTrue(p.c.auth.state.value is AuthState.Authed)
        assertTrue("bioSignIn" in p.api.calls)
    }

    @Test fun theAutoPromptRunsOnceNotOnEveryRecomposition() {
        val p = enrolledPhone()
        val prompter = FakePrompter()
        showLogin(p, prompter)
        waitForText("Sign in as Tina T")
        compose.waitUntilIdlingMain { prompter.calls == 1 }
        // A retry is the person's own tap: one more prompt, and nothing starts by itself after it.
        compose.onNodeWithText("Sign in as Tina T").performClick()
        compose.waitUntilIdlingMain { prompter.calls == 2 }
        compose.waitForIdle()
        assertEquals(2, prompter.calls)
    }

    @Test fun theAutoPromptDoesNotRunAgainAfterARotation() {
        val p = enrolledPhone()
        val prompter = FakePrompter()
        val restore = StateRestorationTester(compose)
        restore.setContent {
            CompositionLocalProvider(LocalAppContainer provides p.c, LocalBiometricPrompter provides prompter) {
                KioskTheme { LoginScreen(rememberNavController()) }
            }
        }
        waitForText("Sign in as Tina T")
        compose.waitUntilIdlingMain { prompter.calls == 1 }
        restore.emulateSavedInstanceStateRestore()
        waitForText("Sign in as Tina T")
        compose.waitForIdle()
        assertEquals(1, prompter.calls)
    }

    @Test fun lockoutHasItsOwnMessageAndStaysOnTheCard() {
        val p = enrolledPhone()
        showLogin(p, FakePrompter { throw BiometricLockedOut() })
        waitForText(BIOMETRIC_LOCKOUT_MESSAGE)
        compose.onNodeWithText("Sign in as Tina T").assertIsDisplayed()
        assertEquals(listOf("bioChallenge"), p.api.calls.filter { it.startsWith("bio") })   // the card's only
    }

    @Test fun usePasswordShowsThePasswordFormWithTheEmail() {
        val p = enrolledPhone()
        showLogin(p, FakePrompter())
        waitForText("Use password")
        compose.onNodeWithText("Use password").performScrollTo().performClick()
        compose.onNodeWithTag("login-email").assertTextContains("tina@example.com")
        compose.onNodeWithTag("login-password").assertIsDisplayed()
    }

    @Test fun otherAccountOpensChooser() {
        val p = enrolledPhone()
        showLogin(p, FakePrompter())
        waitForText("Other account")
        compose.onNodeWithText("Other account").performScrollTo().performClick()
        // Today's choices: email and password (empty: another person), link with phone, move password.
        compose.onNodeWithTag("login-email").assertIsDisplayed()
        assertFalse(compose.onAllNodesWithText("tina@example.com").fetchSemanticsNodes().isNotEmpty())
        compose.onNodeWithText("Link with phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Move password").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
    }

    // ── the fallbacks to the password form ──────────────────────────

    @Test fun expiredShowsPrefilledEmailAndLine() {
        val p = enrolledPhone(expired = true)
        val prompter = FakePrompter { it }
        showLogin(p, prompter)
        waitForText(BIOMETRIC_EXPIRED_MESSAGE)
        compose.onNodeWithText(BIOMETRIC_EXPIRED_MESSAGE).assertIsDisplayed()
        compose.onNodeWithTag("login-email").assertTextContains("tina@example.com")
        compose.onNodeWithTag("login-password").assertIsDisplayed()
        compose.waitForIdle()
        assertEquals(0, prompter.calls)                      // never prompted
        assertFalse("bioSignIn" in p.api.calls)
    }

    @Test fun passwordChangeShowsPortalMessage() {
        val p = enrolledPhone()
        p.api.bioSignInResult = { _, _, _ -> throw ApiError(403, "password_change_required") }
        showLogin(p, FakePrompter { it })
        waitForText(BIOMETRIC_PASSWORD_CHANGE_MESSAGE)
        compose.onNodeWithTag("login-password").assertIsDisplayed()
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        assertTrue(p.c.auth.state.value !is AuthState.Authed)
    }

    @Test fun reassignedFallsBackToPasswordWithMessage() {
        val p = enrolledPhone()
        // The card was showing; then the portal gave the phone to someone else.
        p.api.bioSignInResult = { _, _, _ -> throw ApiError(403, "not_personal_device") }
        showLogin(p, FakePrompter { it })
        waitForText(BIOMETRIC_REMOVED_MESSAGE)
        compose.onNodeWithTag("login-password").assertIsDisplayed()
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        compose.waitUntilIdlingMain { runBlocking { p.c.prefs.biometric.first() } == null }
        assertFalse(p.keys.hasKey)
    }

    @Test fun aDisabledAccountFallsBackToPasswordWithMessage() {
        val p = enrolledPhone()
        p.api.bioSignInResult = { _, _, _ -> throw ApiError(403, "account_disabled") }
        showLogin(p, FakePrompter { it })
        waitForText("This account is disabled. Contact your coordinator.")
        compose.onNodeWithTag("login-password").assertIsDisplayed()
    }

    @Test fun aNetworkFailureStaysOnTheCardWithItsMessage() {
        val p = enrolledPhone()
        p.api.bioSignInResult = { _, _, _ -> throw ApiError(0, "network") }
        showLogin(p, FakePrompter { it })
        waitForText("Can't reach the server", substring = true)
        compose.onNodeWithText("Sign in as Tina T").assertIsDisplayed()
    }

    @Test fun aCardThatArrivesLateNeverReplacesAStartedForm() {
        val p = enrolledPhone()
        val answer = CompletableDeferred<BiometricChallengeOut>()
        p.api.bioChallengeResult = { answer.await() }
        val prompter = FakePrompter()
        showLogin(p, prompter)
        compose.waitUntilIdlingMain { "bioChallenge" in p.api.calls }
        compose.onNodeWithTag("login-email").performTextInput("sam@example.com")
        answer.complete(challenge())
        compose.waitForIdle()
        Thread.sleep(200)
        compose.waitForIdle()
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        compose.onNodeWithTag("login-email").assertTextContains("sam@example.com")
        assertEquals(0, prompter.calls)
    }

    @Test fun noKeyOnThePhoneIsThePlainPasswordForm() {
        val p = enrolledPhone(enrolled = false)
        val prompter = FakePrompter()
        showLogin(p, prompter)
        compose.onNodeWithTag("login-email").assertIsDisplayed()
        compose.waitForIdle()
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        assertEquals(0, prompter.calls)
    }

    // ── never for shared stations or move sessions ──────────────────

    @Test fun noCardForMoveLockedOrTimeClockStation() {
        // A Time Clock station with a key left on it: the sign-in page never shows the card.
        val station = enrolledPhone()
        runBlocking { station.c.prefs.setSetupSelection(KioskSetupSelection(stationType = TIMECLOCK_STATION)) }
        val prompter = FakePrompter { it }
        showLogin(station, prompter)
        compose.onNodeWithTag("login-email").assertIsDisplayed()
        compose.waitForIdle()
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        assertEquals(0, prompter.calls)
        assertFalse("bioChallenge" in station.api.calls)
    }

    @Test fun noCardWhileAMoveLockedSessionIsSignedIn() {
        val p = enrolledPhone()
        runBlocking { p.c.auth.loginWithMovePassword("orange-kayak-42") }
        val prompter = FakePrompter { it }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides p.c, LocalBiometricPrompter provides prompter) {
                KioskTheme { LoginScreen(rememberNavController()) }
            }
        }
        compose.onNodeWithTag("login-email").assertIsDisplayed()
        compose.waitForIdle()
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        assertEquals(0, prompter.calls)
        assertFalse("bioChallenge" in p.api.calls)
    }

    // ── 320 dp ──────────────────────────────────────────────────────

    @Test fun cardFits320dp() {
        val p = enrolledPhone()
        p.api.bioChallengeResult = { BiometricChallengeOut("key-1", "c", "Maximiliana Featherstonehaugh-Cholmondeley", null, false) }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides p.c, LocalBiometricPrompter provides FakePrompter()) {
                KioskTheme { Box(Modifier.size(320.dp, 533.dp)) { LoginScreen(rememberNavController()) } }
            }
        }
        waitForText("Sign in as Maximiliana", substring = true)
        for (tag in listOf("login-bio-avatar", "login-bio-sign-in", "login-bio-password", "login-bio-other")) {
            val node = compose.onNodeWithTag(tag).performScrollTo().assertIsDisplayed()
            val b = node.getBoundsInRoot()
            assertTrue("$tag starts on screen", b.left >= 0.dp)
            assertTrue("$tag ends inside 320 dp (${b.right})", b.right <= 320.dp)
        }
    }

    // ── Settings › This Kiosk ───────────────────────────────────────

    private fun showThisKiosk(p: Phone) {
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides p.c) {
                KioskTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ThisKioskPanel() } }
            }
        }
    }

    @Test fun thisKioskRowForgets() {
        val p = enrolledPhone()
        runBlocking { p.c.auth.login("tina@example.com", "pw") }
        showThisKiosk(p)
        waitForText("Forget this device")
        compose.onNodeWithText("Fingerprint sign-in: On", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Forget this device").performScrollTo().performClick()
        compose.waitUntilIdlingMain { runBlocking { p.c.prefs.biometric.first() } == null }
        assertFalse(p.keys.hasKey)
        // Signed in: revoked on the server too.
        assertTrue(p.api.calls.any { it.startsWith("bioForget:") })
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Forget this device").fetchSemanticsNodes().isEmpty() }
    }

    @Test fun thisKioskRowSignedOutForgetsOnThePhoneOnly() {
        val p = enrolledPhone()
        showThisKiosk(p)
        waitForText("Forget this device")
        compose.onNodeWithText("Forget this device").performScrollTo().performClick()
        compose.waitUntilIdlingMain { runBlocking { p.c.prefs.biometric.first() } == null }
        assertFalse(p.keys.hasKey)
        assertFalse(p.api.calls.any { it.startsWith("bioForget:") })
    }

    @Test fun thisKioskRowIsInfoForSomeoneElse() {
        val p = enrolledPhone()
        p.api.loginResult = { fakeSession(personId = "p2") }
        runBlocking { p.c.auth.login("sam@example.com", "pw") }
        showThisKiosk(p)
        waitForText(FINGERPRINT_NOT_YOURS_TEXT)
        compose.onNodeWithText("Forget this device").assertDoesNotExist()
        assertTrue(runBlocking { p.c.prefs.biometric.first() } != null)
    }

    @Test fun thisKioskRowIsInfoWhenOff() {
        val p = enrolledPhone(enrolled = false)
        showThisKiosk(p)
        waitForText(FINGERPRINT_OFF_TEXT)
        compose.onNodeWithText("Forget this device").assertDoesNotExist()
        assertNull(runBlocking { p.c.prefs.biometric.first() })
    }
}
