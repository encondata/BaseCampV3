package com.serversherpa.kiosk.ui.screens.login

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskMove
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.FakeRefresher
import com.serversherpa.kiosk.data.auth.KioskAuth
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.testIdentity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun kotlinx.coroutines.test.TestScope.vm(api: FakeKioskApi): LoginViewModel {
        val auth = KioskAuth(api, FakeRefresher(), testIdentity(tmp.root, backgroundScope), backgroundScope)
        return LoginViewModel(auth, api, scopeOverride = backgroundScope)
    }

    @Test fun emptyFieldsAreRejectedLocally() = runTest {
        val vm = vm(FakeKioskApi())
        var done = false
        vm.submitPassword { done = true }
        assertEquals("Please enter both email and password", vm.state.value.error)
        assertTrue(vm.state.value.invalidEmail && vm.state.value.invalidPassword)
        assertEquals(false, done)
    }

    @Test fun errorCodesMapToCopy() = runTest {
        val api = FakeKioskApi().apply { loginResult = { throw ApiError(403, "kiosk_not_allowed") } }
        val vm = vm(api)
        vm.setEmail("a@b.c"); vm.setPassword("pw")
        vm.submitPassword {}; runCurrent()
        assertEquals("This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access.", vm.state.value.error)
        assertEquals("", vm.state.value.password)   // cleared after a failure
        api.loginResult = { throw ApiError(0, "network") }
        vm.setPassword("pw"); vm.submitPassword {}; runCurrent()
        assertEquals("Can't reach the server. Check the kiosk's network connection.", vm.state.value.error)
    }

    @Test fun successCallsOnDone() = runTest {
        val api = FakeKioskApi().apply { loginResult = { fakeSession() } }
        val vm = vm(api)
        vm.setEmail("a@b.c"); vm.setPassword("pw")
        var done = false
        vm.submitPassword { done = true }; runCurrent()
        assertTrue(done)
    }

    @Test fun aBlankMovePasswordIsRejectedLocally() = runTest {
        val api = FakeKioskApi()
        val vm = vm(api)
        vm.setView(LoginView.MOVE); vm.setMovePassword("   ")
        var done = false
        vm.submitMove { done = true }; runCurrent()
        assertEquals("Enter the move password.", vm.state.value.moveError)
        assertTrue(api.moveLoginPasswords.isEmpty())
        assertEquals(false, done)
    }

    @Test fun aMovePasswordSignsIn() = runTest {
        val api = FakeKioskApi().apply { moveLoginResult = { fakeSession(kioskMove = KioskMove("m1", "Dallas Move")) } }
        val vm = vm(api)
        vm.setView(LoginView.MOVE); vm.setMovePassword("orange-kayak-42")
        var done = false
        vm.submitMove { done = true }
        assertTrue(vm.state.value.moveLoading)
        runCurrent()
        assertEquals(listOf("orange-kayak-42"), api.moveLoginPasswords)
        assertTrue(done)
        assertEquals("", vm.state.value.movePassword)
        assertEquals(false, vm.state.value.moveLoading)
        assertEquals(null, vm.state.value.moveError)
    }

    @Test fun moveErrorCodesMapToTheMoveFormsCopy() = runTest {
        val api = FakeKioskApi()
        val vm = vm(api)
        vm.setView(LoginView.MOVE)
        val cases = listOf(
            ApiError(401, "invalid_move_password") to "That move password isn't right.",
            ApiError(401, "move_not_active") to "That move password isn't active.",
            ApiError(429, "move_login_rate_limited") to "Too many tries. Wait a few minutes.",
            ApiError(403, "kiosk_not_allowed") to "That move can't sign in to kiosks right now. Ask a coordinator.",
            ApiError(0, "network") to "Can't reach the server. Check the kiosk's network connection.",
            ApiError(500, "unknown_error") to "Login failed. Please try again.",
        )
        for ((err, copy) in cases) {
            api.moveLoginResult = { throw err }
            vm.setMovePassword("pw-123456"); vm.submitMove {}; runCurrent()
            assertEquals(copy, vm.state.value.moveError)
            assertEquals("", vm.state.value.movePassword)   // cleared after a failure, as on the web
            assertEquals(false, vm.state.value.moveLoading)
        }
    }

    @Test fun aScannedCodeIsSubmittedAsTheMovePassword() = runTest {
        val api = FakeKioskApi().apply { moveLoginResult = { fakeSession() } }
        val vm = vm(api)
        vm.setView(LoginView.MOVE)
        var done = false
        vm.submitScannedMove("QR-VALUE-9") { done = true }; runCurrent()
        assertEquals(listOf("QR-VALUE-9"), api.moveLoginPasswords)
        assertTrue(done)
    }

    @Test fun typingClearsTheMoveError() = runTest {
        val vm = vm(FakeKioskApi())
        vm.setView(LoginView.MOVE); vm.submitMove {}; runCurrent()
        assertEquals("Enter the move password.", vm.state.value.moveError)
        vm.setMovePassword("a")
        assertEquals(null, vm.state.value.moveError)
    }

    @Test fun aSecondSubmitWhileSigningInIsIgnored() = runTest {
        val api = FakeKioskApi().apply { moveLoginResult = { fakeSession() } }
        val vm = vm(api)
        vm.setView(LoginView.MOVE); vm.setMovePassword("pw-123456")
        vm.submitMove {}; vm.submitScannedMove("other") {}
        assertEquals("pw-123456", vm.state.value.movePassword)   // the scanned value didn't overwrite the in-flight field
        runCurrent()
        assertEquals(listOf("pw-123456"), api.moveLoginPasswords)
    }

    @Test fun aSecondPasswordSubmitWhileSigningInIsIgnored() = runTest {
        val api = FakeKioskApi().apply { loginResult = { fakeSession() } }
        val vm = vm(api)
        vm.setEmail("a@b.c"); vm.setPassword("pw")
        vm.submitPassword {}; vm.submitPassword {}   // Enter on the field while the request is in flight
        runCurrent()
        assertEquals(1, api.calls.count { it == "login" })
    }

    @Test fun aNetworkFailureThatIsNotAnApiErrorShowsTheNetworkCopy() = runTest {
        val api = FakeKioskApi().apply { moveLoginResult = { throw java.io.IOException("offline") } }
        val vm = vm(api)
        vm.setView(LoginView.MOVE); vm.setMovePassword("pw-123456")
        vm.submitMove {}; runCurrent()
        assertEquals("Can't reach the server. Check the kiosk's network connection.", vm.state.value.moveError)
        assertEquals(false, vm.state.value.moveLoading)
    }

    @Test fun leavingTheMoveViewClearsAHalfTypedPassword() = runTest {
        val vm = vm(FakeKioskApi())
        vm.setView(LoginView.MOVE); vm.setMovePassword("half-typed")
        vm.setView(LoginView.PASSWORD)
        assertEquals("", vm.state.value.movePassword)
    }
}
