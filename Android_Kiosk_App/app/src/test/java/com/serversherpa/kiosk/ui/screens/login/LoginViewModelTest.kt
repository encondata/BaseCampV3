package com.serversherpa.kiosk.ui.screens.login

import com.serversherpa.kiosk.core.ApiError
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
        return LoginViewModel(auth, api, backgroundScope)
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

    @Test fun movePasswordIsAPlaceholder() = runTest {
        val vm = vm(FakeKioskApi())
        vm.setView(LoginView.MOVE); vm.setMovePassword("x"); vm.submitMove()
        assertTrue(vm.state.value.moveNotice)
    }
}
