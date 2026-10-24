package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import android.os.Looper
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
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
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.data.auth.BIOMETRIC_EXPIRED_MESSAGE
import com.serversherpa.kiosk.data.auth.BIOMETRIC_KIOSK_NOT_ALLOWED_MESSAGE
import com.serversherpa.kiosk.data.auth.BIOMETRIC_RATE_LIMITED_MESSAGE
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
import java.time.Duration
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.rules.RuleChain
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The "Sign in as …" card, its fallbacks, and Settings › This Kiosk's Forget, on a 320 dp phone. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w320dp-h533dp")
class BiometricLoginTest {
    private val compose = createComposeRule()
    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

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

    private fun emailField(): String =
        compose.onNodeWithTag("login-email").fetchSemanticsNode().config[SemanticsProperties.EditableText].text

    private fun waitForTag(tag: String) =
        compose.waitUntil(5_000) { compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }

    /** A fake answer held open until the test completes it; [returned] completes once the app has it. */
    private class Held<T> {
        val answer = CompletableDeferred<T>()
        val returned = CompletableDeferred<Unit>()
        suspend fun await(): T = answer.await().also { returned.complete(Unit) }
    }

    /** Lets the main thread run what the held answer resumed (the ViewModel's update follows it at once). */
    private fun settle(held: Held<*>) {
        compose.waitUntilIdlingMain { held.returned.isCompleted }
        shadowOf(Looper.getMainLooper()).idle()
        compose.waitForIdle()
    }

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
        waitForText("Sign in as Tina T")                                   // the validated card, not "Checking…"
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
        // The phone is no longer Tina's: none of her email is left on the form.
        assertEquals("", emailField())
        compose.waitUntilIdlingMain { runBlocking { p.c.prefs.biometric.first() } == null }
        assertFalse(p.keys.hasKey)
    }

    @Test fun kioskAccessRemovedFallsBackToPasswordWithItsMessageAndTheEmail() {
        val p = enrolledPhone()
        p.api.bioSignInResult = { _, _, _ -> throw ApiError(403, "kiosk_not_allowed") }
        showLogin(p, FakePrompter { it })
        waitForText(BIOMETRIC_KIOSK_NOT_ALLOWED_MESSAGE)
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        compose.onNodeWithTag("login-email").assertTextContains("tina@example.com")
        assertTrue(runBlocking { p.c.prefs.biometric.first() } != null)     // still her phone
    }

    @Test fun rateLimitedStaysOnTheCardWithItsMessage() {
        val p = enrolledPhone()
        p.api.bioSignInResult = { _, _, _ -> throw ApiError(429, "biometric_rate_limited") }
        showLogin(p, FakePrompter { it })
        waitForText(BIOMETRIC_RATE_LIMITED_MESSAGE)
        compose.onNodeWithText("Sign in as Tina T").assertIsDisplayed()
        compose.onNodeWithTag("login-email").assertDoesNotExist()
    }

    @Test fun aKeyAndroidDroppedAfterTheCardShowedIsThePlainForm() {
        val p = enrolledPhone()
        val prompter = FakePrompter()
        showLogin(p, prompter)
        waitForText("Sign in as Tina T")
        compose.waitUntilIdlingMain { prompter.calls == 1 }
        // A new fingerprint enrolled in Android while the card was up: the key is gone.
        p.keys.invalidated = true
        prompter.answer = { it }
        compose.onNodeWithText("Sign in as Tina T").performClick()
        waitForTag("login-email")
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        assertEquals("", emailField())
        compose.onNodeWithText(BIOMETRIC_REMOVED_MESSAGE).assertDoesNotExist()
        compose.waitUntilIdlingMain { runBlocking { p.c.prefs.biometric.first() } == null }
        assertEquals(1, prompter.calls)      // never prompted for a key that can't sign
        assertFalse("bioSignIn" in p.api.calls)
    }

    @Test fun anUnavailableSensorSaysSoAndStaysOnTheCard() {
        val p = enrolledPhone()
        showLogin(p, FakePrompter { throw BiometricUnavailable() })
        waitForText(BIOMETRIC_UNAVAILABLE_MESSAGE)
        compose.onNodeWithText("Sign in as Tina T").assertIsDisplayed()
    }

    @Test fun aDisabledAccountFallsBackToPasswordWithMessage() {
        val p = enrolledPhone()
        p.api.bioSignInResult = { _, _, _ -> throw ApiError(403, "account_disabled") }
        showLogin(p, FakePrompter { it })
        waitForText("This account is disabled. Contact your coordinator.")
        compose.onNodeWithTag("login-password").assertIsDisplayed()
        // the phone forgets the key, so the card doesn't come back next time
        compose.waitUntilIdlingMain { runBlocking { p.c.prefs.biometric.first() } == null }
    }

    @Test fun aNetworkFailureStaysOnTheCardWithItsMessage() {
        val p = enrolledPhone()
        p.api.bioSignInResult = { _, _, _ -> throw ApiError(0, "network") }
        showLogin(p, FakePrompter { it })
        waitForText("Can't reach the server", substring = true)
        compose.onNodeWithText("Sign in as Tina T").assertIsDisplayed()
    }

    // ── while the card is on its way ────────────────────────────────

    @Test fun checkingShowsWhileTheCardIsOnItsWayThenTheCard() {
        val p = enrolledPhone()
        val held = Held<BiometricChallengeOut>()
        p.api.bioChallengeResult = { held.await() }
        showLogin(p, FakePrompter())
        waitForText("Checking…")
        compose.onNodeWithTag("login-bio-pending").assertIsDisplayed()
        compose.onNodeWithText("Use password").assertIsDisplayed()
        compose.onNodeWithTag("login-email").assertDoesNotExist()            // no form to flash away
        held.answer.complete(challenge())
        waitForText("Sign in as Tina T")
        compose.onNodeWithText("Checking…").assertDoesNotExist()
    }

    @Test fun offlineEndsOnTheForm() {
        val p = enrolledPhone()
        p.api.bioChallengeResult = { throw ApiError(0, "network") }
        showLogin(p, FakePrompter())
        waitForTag("login-email")
        compose.onNodeWithText("Checking…").assertDoesNotExist()
        compose.onNodeWithTag("login-password").assertIsDisplayed()
        assertEquals("", emailField())                                     // no card, no email
    }

    @Test fun aKeyGoneBeforeTheCardNeverPrefills() {
        val p = enrolledPhone()
        p.keys.invalidated = true                                          // card() finds the key unusable: null
        showLogin(p, FakePrompter())
        waitForTag("login-email")
        assertEquals("", emailField())
        assertFalse("bioChallenge" in p.api.calls)
    }

    @Test fun checkingGivesUpAfterThreeSecondsAndALateCardNeverReplacesAStartedForm() {
        val p = enrolledPhone()
        val held = Held<BiometricChallengeOut>()
        p.api.bioChallengeResult = { held.await() }
        val prompter = FakePrompter()
        showLogin(p, prompter)
        waitForText("Checking…")
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(CARD_PENDING_MAX_MS))
        waitForTag("login-email")
        compose.onNodeWithText("Checking…").assertDoesNotExist()
        compose.onNodeWithTag("login-email").performTextInput("sam@example.com")
        held.answer.complete(challenge())
        settle(held)
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        compose.onNodeWithTag("login-email").assertTextContains("sam@example.com")
        assertEquals(0, prompter.calls)
    }

    @Test fun usePasswordWhileCheckingOpensAnEmptyFormThatALateCardNeverReplaces() {
        val p = enrolledPhone()
        val held = Held<BiometricChallengeOut>()
        p.api.bioChallengeResult = { held.await() }
        val prompter = FakePrompter()
        showLogin(p, prompter)
        waitForText("Checking…")
        compose.onNodeWithText("tina@example.com", substring = true).assertDoesNotExist()   // "Checking…" shows no email
        compose.onNodeWithText("Use password").performClick()
        // Nothing is validated yet, so the saved email stays off the form.
        assertEquals("", emailField())
        held.answer.complete(challenge())
        settle(held)
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        compose.onNodeWithTag("login-password").assertIsDisplayed()
        assertEquals(0, prompter.calls)
    }

    @Test fun noKeyOnThePhoneIsThePlainPasswordForm() {
        val p = enrolledPhone(enrolled = false)
        val prompter = FakePrompter()
        showLogin(p, prompter)
        compose.onNodeWithTag("login-email").assertIsDisplayed()           // no enrollment: never "Checking…"
        compose.onNodeWithText("Checking…").assertDoesNotExist()
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
        waitForTag("login-email")                                          // the card's lookup has ended
        compose.waitForIdle()
        compose.onNodeWithText("Sign in as Tina T").assertDoesNotExist()
        assertEquals("", emailField())                                     // the leftover enrollment's email never shows
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

    /** Real fonts (native graphics) on the 320 dp MC2200: only a real text layout measures the name. */
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w320dp-h533dp-hdpi")
    fun cardFits320dp() {
        val p = enrolledPhone()
        p.api.bioChallengeResult = { BiometricChallengeOut("key-1", "c", "Jimmy Henderson", null, false) }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides p.c, LocalBiometricPrompter provides FakePrompter()) {
                KioskTheme { LoginScreen(rememberNavController()) }
            }
        }
        val label = "Sign in as Jimmy Henderson"
        compose.waitUntil(5_000) { compose.onAllNodesWithText(label, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        for (tag in listOf("login-bio-avatar", "login-bio-sign-in", "login-bio-password", "login-bio-other")) {
            val b = compose.onNodeWithTag(tag).performScrollTo().assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            assertTrue("$tag starts on screen", b.left >= root.left)
            assertTrue("$tag ends inside the screen (${b.right} > ${root.right})", b.right <= root.right)
        }
        // The words are all there: not ellipsized, not cut off, every character laid out.
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(label, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        val layout = layouts.single()
        val last = layout.lineCount - 1
        assertFalse("$label is ellipsized", layout.isLineEllipsized(last))
        assertFalse("$label is cut off below", layout.didOverflowHeight)
        for (i in 0 until layout.lineCount) assertTrue("$label line $i runs past its box", layout.getLineRight(i) <= layout.size.width + 0.5f)
        // Its box sits inside the button.
        val words = compose.onNodeWithText(label, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertEquals("$label lost characters", label.length, layout.getLineEnd(last, visibleEnd = true))
        // And the orange arrow keeps its full 22 dp inside the button.
        val button = compose.onNodeWithTag("login-bio-sign-in").fetchSemanticsNode().boundsInRoot
        val arrow = compose.onNodeWithTag("login-button-arrow", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val density = compose.onRoot().fetchSemanticsNode().layoutInfo.density.density
        assertTrue("the arrow is squeezed to ${arrow.width / density} dp", arrow.width / density >= 21.5f)
        assertTrue("the arrow sits inside the button", arrow.right <= button.right && arrow.left >= button.left)
        assertTrue("the words sit inside the button", words.left >= button.left && words.right <= arrow.left)
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
