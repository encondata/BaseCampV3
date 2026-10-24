package com.serversherpa.kiosk.data.auth

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.BiometricChallengeOut
import com.serversherpa.kiosk.core.model.KioskMove
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.FakeRefresher
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.BiometricEnrollment
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import java.security.MessageDigest
import java.security.Signature
import java.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class BiometricSignInTest {
    @get:Rule val tmp = TemporaryFolder()

    private val ok = BiometricPrompter { it }
    private val cancel = BiometricPrompter { null }

    private class Rig(
        val api: FakeKioskApi,
        val keys: FakeBiometricKeys,
        val prefs: KioskPrefs,
        val auth: KioskAuth,
        val refresher: FakeRefresher,
        val bio: BiometricSignIn,
        var stationKey: Boolean,
    ) {
        suspend fun serial() = prefs.serial.first()!!
    }

    private var stores = 0

    private fun TestScope.rig(scope: CoroutineScope = backgroundScope): Rig {
        val api = FakeKioskApi().apply {
            loginResult = { fakeSession() }
            moveLoginResult = { fakeSession(kioskMove = KioskMove("m1", "Move")) }
        }
        val keys = FakeBiometricKeys()
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "bio-${stores++}.preferences_pb") })
        val identity = Identity(prefs)
        val refresher = FakeRefresher()
        val auth = KioskAuth(api, refresher, identity, scope)
        lateinit var r: Rig
        val bio = BiometricSignIn(api, auth, keys, prefs, identity, stationKeyPresent = { r.stationKey })
        r = Rig(api, keys, prefs, auth, refresher, bio, stationKey = false)
        return r
    }

    private fun card(keyId: String = "key-1", challenge: String = "chal.lenge.1", expired: Boolean = false) =
        BiometricChallengeOut(keyId, challenge, "Tina T", "https://photos/p1.jpg", expired)

    /** A password sign-in and an enrollment, then signed out, as the next launch finds it. */
    private suspend fun Rig.enrolledAndSignedOut() {
        auth.login("tina@example.com", "pw")
        assertEquals(EnrollOutcome.Enrolled, bio.enroll(BiometricPrompter { it }))
        auth.logout()
        api.calls.clear()
    }

    private fun sha256(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))

    // ── enroll ──────────────────────────────────────────────────────

    @Test fun enrollSendsChainAndStoresKeyId() = runTest {
        val r = rig()
        r.auth.login("tina@example.com", "pw")
        assertTrue(r.bio.offerEnroll())
        assertEquals(EnrollOutcome.Enrolled, r.bio.enroll(ok))
        // The attestation challenge is the SHA-256 of the nonce's UTF-8 bytes, not the nonce.
        assertArrayEquals(sha256("nonce-1"), r.keys.challenges.single())
        val (serial, nonce, chain) = r.api.bioEnrolls.single()
        assertEquals(r.serial(), serial)
        assertEquals("nonce-1", nonce)
        assertEquals(r.keys.chain.map { Base64.getEncoder().encodeToString(it) }, chain)
        assertEquals(BiometricEnrollment("key-1", "p1", "tina@example.com"), r.prefs.biometric.first())
        assertEquals(BiometricEnrollment("key-1", "p1", "tina@example.com"), r.bio.enrollment.first())
        assertTrue(r.keys.hasKey)
    }

    @Test fun enrollTakesAFreshNonceAndProvesTheKeyBehindThePrompt() = runTest {
        val r = rig()
        r.auth.login("tina@example.com", "pw")
        var prompted = 0
        assertEquals(EnrollOutcome.Enrolled, r.bio.enroll { s -> prompted++; s })
        assertEquals(1, prompted)
        assertEquals(listOf("login", "bioEnrollChallenge", "bioEnroll"), r.api.calls)
    }

    @Test fun canceledEnrollPromptLeavesNoKey() = runTest {
        val r = rig()
        r.auth.login("tina@example.com", "pw")
        assertEquals(EnrollOutcome.Canceled, r.bio.enroll(cancel))
        assertFalse(r.keys.hasKey)
        assertNull(r.prefs.biometric.first())
        assertTrue(r.api.bioEnrolls.isEmpty())
    }

    @Test fun attestationRefusedIsUnsupportedAndLeavesNoKey() = runTest {
        for (code in listOf("attestation_failed", "not_personal_device")) {
            val r = rig()
            r.auth.login("tina@example.com", "pw")
            r.api.bioEnrollResult = { _, _, _ -> throw ApiError(if (code == "attestation_failed") 422 else 403, code) }
            assertEquals(code, EnrollOutcome.Unsupported, r.bio.enroll(ok))
            assertFalse(code, r.keys.hasKey)
            assertNull(code, r.prefs.biometric.first())
        }
    }

    @Test fun enrollOtherFailuresAreFailedWithAMessage() = runTest {
        val r = rig()
        r.auth.login("tina@example.com", "pw")
        r.api.bioEnrollResult = { _, _, _ -> throw ApiError(403, "enroll_window_closed") }
        val out = r.bio.enroll(ok)
        assertTrue(out is EnrollOutcome.Failed)
        assertTrue((out as EnrollOutcome.Failed).message.isNotBlank())
        assertFalse(r.keys.hasKey)
        assertNull(r.prefs.biometric.first())
    }

    @Test fun enrollWhereTheKeystoreFailsIsUnsupported() = runTest {
        val r = rig()
        r.auth.login("tina@example.com", "pw")
        r.keys.createError = java.security.ProviderException("no keymint")
        assertEquals(EnrollOutcome.Unsupported, r.bio.enroll(ok))
        assertTrue(r.api.bioEnrolls.isEmpty())
        assertNull(r.prefs.biometric.first())
    }

    // ── who is offered ──────────────────────────────────────────────

    @Test fun moveSessionNeverOffersEnroll() = runTest {
        val r = rig()
        r.auth.loginWithMovePassword("orange-kayak-42")
        assertFalse(r.bio.offerEnroll())
        // Even a session that came back move-locked from a password sign-in.
        r.api.loginResult = { fakeSession(kioskMove = KioskMove("m1", "Move")) }
        r.auth.login("tina@example.com", "pw")
        assertFalse(r.bio.offerEnroll())
        assertFalse("bioEnrollChallenge" in r.api.calls)
    }

    @Test fun onlyAFreshPasswordSignInIsOffered() = runTest {
        val r = rig()
        r.auth.completePair(fakeSession())
        assertFalse(r.bio.offerEnroll())
        r.refresher.refreshResult = { fakeSession() }
        r.auth.restore()
        assertFalse(r.bio.offerEnroll())
        r.auth.signInWithBiometric(fakeSession())
        assertFalse(r.bio.offerEnroll())
        r.auth.logout()
        assertFalse(r.bio.offerEnroll())
        assertFalse("bioEnrollChallenge" in r.api.calls)
        r.auth.login("tina@example.com", "pw")
        assertTrue(r.bio.offerEnroll())
    }

    @Test fun timeClockAndStationDevicesNeverOfferOrShowTheCard() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card() }
        for (setup in listOf(KioskSetupSelection(stationType = "timeclock"), KioskSetupSelection(stationType = "label"))) {
            r.prefs.setSetupSelection(setup)
            r.auth.login("tina@example.com", "pw")
            assertFalse(r.bio.offerEnroll())
            r.auth.logout()
            assertNull(r.bio.card())
        }
        r.prefs.setSetupSelection(null)
        r.stationKey = true
        r.auth.login("tina@example.com", "pw")
        assertFalse(r.bio.offerEnroll())
        r.auth.logout()
        assertNull(r.bio.card())
        assertFalse("bioEnrollChallenge" in r.api.calls)
        assertFalse("bioChallenge" in r.api.calls)
        r.stationKey = false
        assertNotNull(r.bio.card())
    }

    @Test fun offerNeedsAStrongBiometricReady() = runTest {
        val r = rig()
        r.auth.login("tina@example.com", "pw")
        for (no in listOf(BiometricReadiness.NO_HARDWARE, BiometricReadiness.NONE_ENROLLED, BiometricReadiness.NO_SECURE_LOCK)) {
            r.keys.readiness = no
            assertFalse(no.name, r.bio.offerEnroll())
        }
        assertFalse("bioEnrollChallenge" in r.api.calls)
        r.keys.readiness = BiometricReadiness.READY
        assertTrue(r.bio.offerEnroll())
    }

    @Test fun offerAsksTheServerWhetherThisPhoneIsPersonal() = runTest {
        val r = rig()
        r.auth.login("tina@example.com", "pw")
        r.api.bioEnrollChallengeResult = { throw ApiError(403, "not_personal_device") }
        assertFalse(r.bio.offerEnroll())
        r.api.bioEnrollChallengeResult = { throw ApiError(0, "network") }
        assertFalse(r.bio.offerEnroll())
        r.api.bioEnrollChallengeResult = { "nonce-2" }
        assertTrue(r.bio.offerEnroll())
    }

    @Test fun aLiveKeyIsNotOfferedAgainButADeadOneIs() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card() }
        r.auth.login("tina@example.com", "pw")
        assertFalse(r.bio.offerEnroll())                // the password sign-in renews it
        assertTrue(r.keys.hasKey)
        r.api.bioChallengeResult = { throw ApiError(404, "no_biometric") }   // revoked (a password reset)
        assertTrue(r.bio.offerEnroll())
        assertFalse(r.keys.hasKey)
        assertNull(r.prefs.biometric.first())
    }

    @Test fun anotherPersonsPasswordSignInLeavesTheOwnersKey() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.loginResult = { fakeSession(personId = "p2") }
        r.api.bioEnrollChallengeResult = { throw ApiError(403, "not_personal_device") }
        r.auth.login("sam@example.com", "pw")
        assertFalse(r.bio.offerEnroll())
        assertTrue(r.keys.hasKey)
        assertEquals("p1", r.prefs.biometric.first()?.personId)
    }

    // ── the card ────────────────────────────────────────────────────

    @Test fun cardNullWithoutLocalKey() = runTest {
        val r = rig()
        r.api.bioChallengeResult = { card() }
        assertNull(r.bio.card())
        assertTrue(r.api.calls.isEmpty())
    }

    @Test fun cardCarriesTheServersNameAndTheLocalEmail() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card(expired = true) }
        assertEquals(
            BiometricCard("key-1", "chal.lenge.1", "Tina T", "https://photos/p1.jpg", true, "tina@example.com"),
            r.bio.card(),
        )
    }

    @Test fun cardGoneOnTheServerForgetsTheLocalKey() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { throw ApiError(404, "no_biometric") }
        assertNull(r.bio.card())
        assertFalse(r.keys.hasKey)
        assertNull(r.prefs.biometric.first())
    }

    @Test fun cardForAnotherKeyForgetsTheLocalKey() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card(keyId = "key-other") }
        assertNull(r.bio.card())
        assertFalse(r.keys.hasKey)
    }

    @Test fun cardOfflineOrThrottledKeepsTheKey() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        for (e in listOf(ApiError(0, "network"), ApiError(429, "biometric_rate_limited"))) {
            r.api.bioChallengeResult = { throw e }
            assertNull(r.bio.card())
            assertTrue(r.keys.hasKey)
            assertNotNull(r.prefs.biometric.first())
        }
    }

    // ── sign in ─────────────────────────────────────────────────────

    @Test fun signInSignsTheChallengeBytes() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card(challenge = "chal.lenge.1") }
        val session = fakeSession(roles = listOf("worker", "x"))
        r.api.bioSignInResult = { _, _, _ -> session }
        assertEquals(BiometricOutcome.SignedIn, r.bio.signIn(ok))
        val (keyId, challenge, sig) = r.api.bioSignIns.single()
        assertEquals("key-1", keyId)
        assertEquals("chal.lenge.1", challenge)
        val verify = Signature.getInstance("SHA256withECDSA").apply {
            initVerify(r.keys.pair!!.public); update("chal.lenge.1".toByteArray(Charsets.UTF_8))
        }
        assertTrue(verify.verify(Base64.getDecoder().decode(sig)))
        assertEquals(session, (r.auth.state.value as AuthState.Authed).session)
        assertEquals(LoginMethod.BIOMETRIC, r.auth.takePendingSignIn())
    }

    @Test fun expiredMapsToExpired() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        var prompted = false
        // Already past the 30 days: straight to the password form, no prompt.
        r.api.bioChallengeResult = { card(expired = true) }
        assertEquals(BiometricOutcome.Expired, r.bio.signIn { prompted = true; it })
        assertFalse(prompted)
        assertTrue(r.api.bioSignIns.isEmpty())
        // Crossed the line while the card was up.
        r.api.bioChallengeResult = { card() }
        r.api.bioSignInResult = { _, _, _ -> throw ApiError(403, "biometric_expired") }
        assertEquals(BiometricOutcome.Expired, r.bio.signIn(ok))
        assertTrue(r.keys.hasKey)                       // the next password sign-in renews it
        assertTrue(r.auth.state.value !is AuthState.Authed)
    }

    @Test fun passwordChangeMapsToPasswordChange() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card() }
        r.api.bioSignInResult = { _, _, _ -> throw ApiError(403, "password_change_required") }
        assertEquals(BiometricOutcome.PasswordChange, r.bio.signIn(ok))
        assertTrue(r.keys.hasKey)
    }

    @Test fun notAllowedMaps() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card() }
        for (code in listOf("kiosk_not_allowed", "account_disabled")) {
            r.api.bioSignInResult = { _, _, _ -> throw ApiError(403, code) }
            val out = r.bio.signIn(ok)
            assertTrue(code, out is BiometricOutcome.NotAllowed)
            assertTrue(code, (out as BiometricOutcome.NotAllowed).message.isNotBlank())
        }
        assertTrue(r.keys.hasKey)                       // access can come back
    }

    @Test fun reassignedOrRevokedForgetsLocallyAndFallsBack() = runTest {
        for (code in listOf("not_personal_device", "no_biometric")) {
            val r = rig()
            r.enrolledAndSignedOut()
            r.api.bioChallengeResult = { card() }
            r.api.bioSignInResult = { _, _, _ -> throw ApiError(if (code == "no_biometric") 404 else 403, code) }
            val out = r.bio.signIn(ok)
            assertTrue(code, out is BiometricOutcome.NotAllowed)
            assertFalse(code, r.keys.hasKey)
            assertNull(code, r.prefs.biometric.first())
            assertNull(code, r.bio.card())
        }
    }

    @Test fun reassignedBeforeThePromptForgetsLocally() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { throw ApiError(404, "no_biometric") }
        var prompted = false
        assertTrue(r.bio.signIn { prompted = true; it } is BiometricOutcome.NotAllowed)
        assertFalse(prompted)
        assertFalse(r.keys.hasKey)
    }

    @Test fun invalidatedKeyIsDeletedLocallyAndFallsBack() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card() }
        r.keys.invalidated = true                       // a new fingerprint was enrolled
        var prompted = false
        assertEquals(BiometricOutcome.Invalidated, r.bio.signIn { prompted = true; it })
        assertFalse(prompted)
        assertTrue(r.api.bioSignIns.isEmpty())
        assertFalse(r.keys.hasKey)
        assertNull(r.prefs.biometric.first())
        // No loop: the card is gone, and a second try says the same without the Keystore again.
        assertNull(r.bio.card())
        assertEquals(BiometricOutcome.Invalidated, r.bio.signIn(ok))
        // The next password sign-in offers enrollment again.
        r.auth.login("tina@example.com", "pw")
        assertTrue(r.bio.offerEnroll())
    }

    @Test fun invalidatedKeyHasNoCard() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card() }
        r.keys.invalidated = true
        assertNull(r.bio.card())
        assertFalse(r.keys.hasKey)
        assertNull(r.prefs.biometric.first())
        assertFalse("bioChallenge" in r.api.calls)
    }

    @Test fun canceledPromptStaysOnCard() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card() }
        assertEquals(BiometricOutcome.Canceled, r.bio.signIn(cancel))
        assertTrue(r.api.bioSignIns.isEmpty())
        assertTrue(r.keys.hasKey)
        assertNotNull(r.prefs.biometric.first())
        assertNotNull(r.bio.card())
        assertEquals(BiometricOutcome.SignedIn, r.bio.signIn(ok))
    }

    @Test fun rateLimitedIsFailedWithAFriendlyMessage() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card() }
        r.api.bioSignInResult = { _, _, _ -> throw ApiError(429, "biometric_rate_limited") }
        val out = r.bio.signIn(ok)
        assertEquals(BiometricOutcome.Failed(BIOMETRIC_RATE_LIMITED_MESSAGE), out)
        r.api.bioChallengeResult = { throw ApiError(429, "biometric_rate_limited") }
        assertEquals(BiometricOutcome.Failed(BIOMETRIC_RATE_LIMITED_MESSAGE), r.bio.signIn(ok))
        assertTrue(r.keys.hasKey)
    }

    @Test fun aSpentChallengeOrBadSignatureIsFailedAndKeepsTheKey() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        r.api.bioChallengeResult = { card() }
        for (code in listOf("bad_challenge", "bad_signature", "unknown_error", "network")) {
            r.api.bioSignInResult = { _, _, _ -> throw ApiError(if (code == "network") 0 else 401, code) }
            val out = r.bio.signIn(ok)
            assertTrue(code, out is BiometricOutcome.Failed)
            assertTrue(code, (out as BiometricOutcome.Failed).message.isNotBlank())
        }
        assertTrue(r.keys.hasKey)
        assertTrue(r.auth.state.value !is AuthState.Authed)
    }

    @Test fun eachSignInFetchesItsOwnChallenge() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        var n = 0
        r.api.bioChallengeResult = { n++; card(challenge = "c$n") }
        r.api.bioSignInResult = { _, _, _ -> throw ApiError(401, "bad_challenge") }
        r.bio.signIn(ok)
        r.api.bioSignInResult = { _, _, _ -> fakeSession() }
        assertEquals(BiometricOutcome.SignedIn, r.bio.signIn(ok))
        assertEquals(listOf("c1", "c2"), r.api.bioSignIns.map { it.second })
    }

    // ── forget ──────────────────────────────────────────────────────

    @Test fun forgetSignedOutDeletesLocallyOnly() = runTest {
        val r = rig()
        r.enrolledAndSignedOut()
        assertTrue(r.bio.forget(signedIn = false))
        assertTrue(r.api.calls.isEmpty())
        assertFalse(r.keys.hasKey)
        assertNull(r.prefs.biometric.first())
    }

    @Test fun forgetSignedInCallsServer() = runTest {
        val r = rig()
        r.auth.login("tina@example.com", "pw")
        r.bio.enroll(ok)
        var keyAtServerCall: Boolean? = null
        r.api.bioForgetResult = { keyAtServerCall = r.keys.hasKey }
        assertTrue(r.bio.forget(signedIn = true))
        assertEquals("bioForget:${r.serial()}", r.api.calls.last())
        assertEquals(true, keyAtServerCall)             // the server first, then the phone
        assertFalse(r.keys.hasKey)
        assertNull(r.prefs.biometric.first())
    }

    @Test fun forgetSignedInOfflineStillForgetsOnThePhone() = runTest {
        val r = rig()
        r.auth.login("tina@example.com", "pw")
        r.bio.enroll(ok)
        r.api.bioForgetResult = { throw ApiError(0, "network") }
        assertFalse(r.bio.forget(signedIn = true))
        assertFalse(r.keys.hasKey)
        assertNull(r.prefs.biometric.first())
    }
}
