package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class LoginScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun passwordFormThenOtherWays() {
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides testContainer()) { KioskTheme { LoginScreen(rememberNavController()) } } }
        compose.onNodeWithText("Forgot your password? Reset it in the portal.").assertIsDisplayed()
        compose.onNodeWithText("Other ways to sign in").performScrollTo().performClick()
        compose.onNodeWithText("Link with phone").assertIsDisplayed()
        compose.onNodeWithText("Move password").assertIsDisplayed()
    }
}
