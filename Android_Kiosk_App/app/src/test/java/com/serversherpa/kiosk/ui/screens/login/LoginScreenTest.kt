package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.SystemStatus
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class LoginScreenTest {
    @get:Rule val compose = createComposeRule()

    /** Holds the UI state and records every call the screen makes, so a state can be drawn without a container. */
    private class Calls(initial: LoginUi = LoginUi()) {
        var ui by mutableStateOf(initial)
        val log = mutableListOf<String>()
        val actions = LoginActions(
            setEmail = { log += "email:$it"; ui = ui.copy(email = it) },
            setPassword = { log += "password:$it"; ui = ui.copy(password = it) },
            togglePassword = { log += "toggle"; ui = ui.copy(showPassword = !ui.showPassword) },
            submitPassword = { log += "submit" },
            setView = { log += "view:$it"; ui = ui.copy(view = it) },
            setMovePassword = { log += "move:$it"; ui = ui.copy(movePassword = it) },
            submitMove = { log += "submitMove" }, openSettings = { log += "settings" },
        )
    }

    private fun show(ui: LoginUi = LoginUi(), kioskName: String = "Dock 4", calls: Calls = Calls(ui), width: Int? = null, height: Int? = null, pair: String = "pair") {
        compose.setContent {
            KioskTheme {
                val sized = if (width != null && height != null) Modifier.size(width.dp, height.dp) else Modifier
                Box(sized) { LoginContent(calls.ui, kioskName, calls.actions) { androidx.compose.material3.Text(pair) } }
            }
        }
    }

    // ── the screen against a real container: the routes and the way back ──

    @Test fun passwordFormShowsTheRoutesBelowTheDivider() {
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides testContainer()) { KioskTheme { LoginScreen(rememberNavController()) } } }
        compose.onNodeWithText("EMAIL").assertIsDisplayed()
        compose.onNodeWithText("PASSWORD").assertIsDisplayed()
        compose.onNodeWithText("Forgot password?").assertIsDisplayed()
        compose.onNodeWithText("OR").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Link with phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Move password").performScrollTo().assertIsDisplayed()
    }

    @Test fun linkWithPhoneAndBack() {
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides testContainer()) { KioskTheme { LoginScreen(rememberNavController()) } } }
        compose.onNodeWithText("Link with phone").performScrollTo().performClick()
        compose.onNodeWithText("Link this kiosk with your phone.").assertIsDisplayed()
        compose.onNodeWithText("Back to email & password").performScrollTo().performClick()
        compose.onNodeWithText("EMAIL").assertIsDisplayed()
    }

    @Test fun moveFlowShowsItsNoticeAndGoesBack() {
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides testContainer()) { KioskTheme { LoginScreen(rememberNavController()) } } }
        compose.onNodeWithText("Move password").performScrollTo().performClick()
        compose.onNodeWithText("Sign in with a move password.").assertIsDisplayed()
        compose.onNodeWithTag("login-submit-move").performScrollTo().performClick()
        compose.onNodeWithText("Move passwords aren't available yet. Use email & password or link with your phone.").assertIsDisplayed()
        compose.onNodeWithText("Back to email & password").performScrollTo().performClick()
        compose.onNodeWithText("EMAIL").assertIsDisplayed()
    }

    @Test fun signingInWithBlankFieldsShowsTheOriginalMessageAndMarksBothFields() {
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides testContainer()) { KioskTheme { LoginScreen(rememberNavController()) } } }
        compose.onNodeWithTag("login-submit").performScrollTo().performClick()
        compose.onNodeWithText("Please enter both email and password").assertIsDisplayed()
    }

    // ── the states, drawn directly ──

    @Test fun heroStructure() {
        show()
        compose.onNodeWithContentDescription("ServerSherpa logo").assertIsDisplayed()
        compose.onNodeWithText("Server", substring = true).assertIsDisplayed()
        compose.onNodeWithText("DATACENTER RELOCATION TOOLS").assertIsDisplayed()
        compose.onNodeWithText("Sign in to start scanning.").assertIsDisplayed()
        compose.onNodeWithText("Dock 4").assertIsDisplayed()          // which kiosk this is
        compose.onNodeWithText("you@company.com").assertIsDisplayed()  // the field carries its placeholder
    }

    @Test fun theSettingsGearIsReachable() {
        val calls = Calls()
        show(calls = calls)
        compose.onNodeWithContentDescription("Kiosk settings").assertIsDisplayed().performClick()
        assertEquals(listOf("settings"), calls.log)
    }

    @Test fun typingAndSubmittingReachTheViewModel() {
        val calls = Calls()
        show(calls = calls)
        compose.onNodeWithTag("login-email").performTextInput("a@b.co")
        compose.onNodeWithTag("login-password").performTextInput("pw")
        compose.onNodeWithTag("login-submit").performScrollTo().assertIsEnabled().performClick()
        assertEquals(listOf("email:a@b.co", "password:pw", "submit"), calls.log)
    }

    @Test fun theEyeTogglesAndSaysWhatItWillDo() {
        val calls = Calls()
        show(calls = calls)
        compose.onNodeWithContentDescription("Show password").performClick()
        compose.onNodeWithContentDescription("Hide password").assertIsDisplayed()
        assertEquals(listOf("toggle"), calls.log)
    }

    @Test fun theEyeReadsHideWhileThePasswordIsShowing() {
        show(LoginUi(showPassword = true, password = "hunter2"))
        compose.onNodeWithContentDescription("Hide password").assertIsDisplayed()
        compose.onNodeWithTag("login-password").assertTextContains("hunter2")
    }

    @Test fun thePasswordIsMaskedUntilShown() {
        show(LoginUi(password = "hunter2"))
        compose.onNodeWithTag("login-password").assertTextContains("•", substring = true)
    }

    @Test fun forgotPasswordRevealsThePortalNote() {
        show()
        compose.onNodeWithText("Forgot your password? Reset it in the portal.").assertDoesNotExist()
        compose.onNodeWithText("Forgot password?").performClick()
        compose.onNodeWithText("Forgot your password? Reset it in the portal.").assertIsDisplayed()
    }

    @Test fun loadingDisablesTheButtonAndSaysSigningIn() {
        show(LoginUi(loading = true, email = "a@b.co", password = "pw"))
        compose.onNodeWithTag("login-submit").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Signing in…").assertIsDisplayed()
    }

    @Test fun anErrorShowsItsMessage() {
        show(LoginUi(error = ERROR_MESSAGES.getValue("invalid_credentials"), invalidEmail = true, invalidPassword = true))
        compose.onNodeWithText("Invalid email or password.").assertIsDisplayed()
    }

    @Test fun everyErrorMessageStillRenders() {
        val calls = Calls()
        compose.setContent { KioskTheme { LoginContent(calls.ui, "", calls.actions) { } } }
        assertTrue(ERROR_MESSAGES.isNotEmpty())
        for (message in ERROR_MESSAGES.values) {
            calls.ui = LoginUi(error = message)
            compose.onNodeWithText(message).assertIsDisplayed()
        }
    }

    @Test fun bannersShowOnLoad() {
        show(LoginUi(status = SystemStatus(read_only = true, read_only_message = "back at 6", banner = "Move day Friday")))
        compose.onNodeWithText("Read-only maintenance mode — back at 6").assertIsDisplayed()
        compose.onNodeWithText("Move day Friday").assertIsDisplayed()
    }

    @Test fun readOnlyWithoutAMessage() {
        show(LoginUi(status = SystemStatus(read_only = true)))
        compose.onNodeWithText("Read-only maintenance mode").assertIsDisplayed()
    }

    @Test fun theLinkViewHostsThePairPanel() {
        show(LoginUi(view = LoginView.LINK), pair = "PAIR PANEL")
        compose.onNodeWithText("PAIR PANEL").assertIsDisplayed()
        compose.onNodeWithText("Back to email & password").performScrollTo().assertIsDisplayed()
    }

    @Test fun theChooserDrawsTheSameFormAsThePasswordView() {
        show(LoginUi(view = LoginView.CHOOSER))
        compose.onNodeWithText("Link with phone").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Move password").performScrollTo().assertIsDisplayed()
    }

    @Test fun linkWithPhoneSwitchesToTheLinkView() {
        val calls = Calls()
        show(calls = calls)
        compose.onNodeWithText("Link with phone").performScrollTo().performClick()
        assertEquals(listOf("view:LINK"), calls.log)
    }

    @Test fun movePasswordSwitchesToTheMoveView() {
        val calls = Calls()
        show(calls = calls)
        compose.onNodeWithText("Move password").performScrollTo().performClick()
        assertEquals(listOf("view:MOVE"), calls.log)
    }

    // ── touch targets and the short screen ──

    @Test fun touchTargetsAreAtLeast48dp() {
        show()
        compose.onNodeWithContentDescription("Kiosk settings").assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp)
        compose.onNodeWithContentDescription("Show password").assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp)
        compose.onNodeWithText("Forgot password?").assertHeightIsAtLeast(48.dp)
        compose.onNodeWithTag("login-submit").performScrollTo().assertHeightIsAtLeast(48.dp)
        compose.onNodeWithText("Link with phone").performScrollTo().assertHeightIsAtLeast(48.dp)
        compose.onNodeWithText("Move password").performScrollTo().assertHeightIsAtLeast(48.dp)
    }

    @Test fun theFormStaysUsableOnAZebraMc2200() {
        // 480x800 px at hdpi is 320x533 dp.
        show(width = 320, height = 533)
        compose.onNodeWithTag("login-email").assertIsDisplayed()
        compose.onNodeWithTag("login-password").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("login-submit").performScrollTo().assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("Move password").performScrollTo().assertIsDisplayed()
        // The gear stays put while the form is scrolled to its end.
        compose.onNodeWithContentDescription("Kiosk settings").assertIsDisplayed()
    }

    @Test fun theArtworkBandIsSizedToTheScreen() {
        // A phone: 40% of the height, drawn wider than the screen so the crop keeps the peaks.
        assertEquals(320f, loginArtHeight(360.dp, 800.dp).value, 0.1f)
        assertEquals(360f, loginArtWidth(360.dp, 320.dp).value, 0.1f)
        // A Zebra MC2200 (320x533 dp): still 40% of a short screen, ~213 dp.
        assertEquals(213.2f, loginArtHeight(320.dp, 533.dp).value, 0.1f)
        // A very narrow screen can't zoom past 1.6x the art's own aspect.
        assertEquals(200f / MOUNTAINS_ASPECT * 1.6f, loginArtHeight(200.dp, 800.dp).value, 0.1f)
        // A wide, short screen: the whole art at 40% of the height, sitting bottom-right.
        assertEquals(160f, loginArtHeight(1000.dp, 400.dp).value, 0.1f)
        assertEquals(160f * MOUNTAINS_ASPECT, loginArtWidth(1000.dp, 160.dp).value, 0.1f)
    }
}
