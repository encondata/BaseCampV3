package com.serversherpa.kiosk.data.auth

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.model.KioskMove
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class MoveSetupGuardTest {
    @get:Rule val tmp = TemporaryFolder()

    private val setupA = KioskSetupSelection("mA", "Move A", "s1", "Dock 4", "source", "pre_stage", "Pre-stage")

    private suspend fun TestScope.prefsWith(selection: KioskSetupSelection?): KioskPrefs {
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "g${System.nanoTime()}.preferences_pb") })
        prefs.setSetupSelection(selection)
        prefs.setSetupState(if (selection == null) SetupState.INCOMPLETE else SetupState.COMPLETE)
        return prefs
    }

    @Test fun aMoveSessionDropsASetupSavedForAnotherMove() = runTest {
        val prefs = prefsWith(setupA)
        val auth = MutableStateFlow<AuthState>(AuthState.Anon)
        MoveSetupGuard(auth, prefs, backgroundScope).start()
        auth.value = AuthState.Authed(fakeSession(kioskMove = KioskMove("mB", "Move B")))
        repeat(5) { runCurrent() }
        assertNull(prefs.setupSelection.first())
        assertEquals(SetupState.INCOMPLETE, prefs.setupState.first())
    }

    @Test fun aMoveSessionKeepsItsOwnMovesSetup() = runTest {
        val prefs = prefsWith(setupA)
        val auth = MutableStateFlow<AuthState>(AuthState.Authed(fakeSession(kioskMove = KioskMove("mA", "Move A"))))
        MoveSetupGuard(auth, prefs, backgroundScope).start()
        repeat(5) { runCurrent() }
        assertEquals(setupA, prefs.setupSelection.first())
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())
    }

    @Test fun anOrdinarySessionLeavesTheSetupAlone() = runTest {
        val prefs = prefsWith(setupA)
        val auth = MutableStateFlow<AuthState>(AuthState.Authed(fakeSession()))
        MoveSetupGuard(auth, prefs, backgroundScope).start()
        repeat(5) { runCurrent() }
        assertEquals(setupA, prefs.setupSelection.first())
    }
}
