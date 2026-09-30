package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.data.identity.KioskIdentity
import com.serversherpa.kiosk.input.camera.CameraScanSheet
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.theme.Geologica

/**
 * The sign-in screen, in the light mockup style of the portal's login page
 * (portal/src/styles/login-light.css). Behavior is the old screen's: this file only
 * wires [LoginViewModel] and [PairViewModel] to [LoginContent], which is stateless
 * and takes the whole UI state, so every state is testable without a container.
 */
@Composable
fun LoginScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val vm = kioskViewModel { LoginViewModel(container.auth, container.api) }
    val pairVm = kioskViewModel { PairViewModel(container.api, container.identity) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val identity by container.identity.identity.collectAsStateWithLifecycle(initialValue = KioskIdentity("", ""))
    val portalUrl by container.config.portalUrl.collectAsStateWithLifecycle(initialValue = "")
    LaunchedEffect(Unit) { vm.loadBanners() }
    val goHome = { nav.navigate(Routes.HOME) { popUpTo(0) } }
    var scanning by rememberSaveable { mutableStateOf(false) }

    LoginContent(
        ui = ui,
        kioskName = identity.name,
        actions = LoginActions(
            setEmail = vm::setEmail, setPassword = vm::setPassword, togglePassword = vm::togglePassword,
            submitPassword = { vm.submitPassword(goHome) },
            setView = vm::setView, setMovePassword = vm::setMovePassword, submitMove = { vm.submitMove(goHome) },
            openSettings = { nav.navigate(Routes.settings("this-kiosk")) },
            scanMove = { scanning = true },
        ),
        canScan = container.hasCamera,
        pairPanel = { PairPanel(pairVm, portalUrl) { session: SessionData -> container.auth.completePair(session); goHome() } },
    )
    // The kiosk's own camera, QR only: the first code read is the move password and is submitted at once.
    // Only over the Move password view: `scanning` is saved across process death but the view isn't, and a
    // scan's error lands in moveError, which no other view shows.
    // It also resets when the view leaves MOVE, so coming back never reopens the camera.
    LaunchedEffect(ui.view) { if (ui.view != LoginView.MOVE) scanning = false }
    if (scanning && ui.view == LoginView.MOVE) CameraScanSheet(
        onScan = { vm.submitScannedMove(it.value, goHome) },
        onDismiss = { scanning = false },
        qrOnly = true,
    )
}

/** Everything the screen can do; one place so the stateless [LoginContent] stays readable. */
internal class LoginActions(
    val setEmail: (String) -> Unit,
    val setPassword: (String) -> Unit,
    val togglePassword: () -> Unit,
    val submitPassword: () -> Unit,
    val setView: (LoginView) -> Unit,
    val setMovePassword: (String) -> Unit,
    val submitMove: () -> Unit,
    val openSettings: () -> Unit,
    val scanMove: () -> Unit,
)

/** The artwork's band takes up to this share of the screen's height (a 480x800 Zebra MC2200 is ~533 dp tall). */
private const val MAX_ART_SHARE = 0.40f

/** On a narrow screen the art may be drawn up to this much taller than its width allows, cropping the misty right side. */
private const val ART_ZOOM = 1.6f

/** The peaks start ~36% down the art; the form only has to clear what is below that. */
private const val ART_CLEAR_SHARE = 0.40f

/** The band's height: [MAX_ART_SHARE] of the screen, unless the screen is too narrow to fill it even zoomed in. */
internal fun loginArtHeight(maxWidth: Dp, maxHeight: Dp): Dp = min(maxWidth / MOUNTAINS_ASPECT * ART_ZOOM, maxHeight * MAX_ART_SHARE)

/** The band's width: the whole screen, or the art's natural width at [loginArtHeight] when the screen is wider (it then sits bottom-right). */
internal fun loginArtWidth(maxWidth: Dp, artHeight: Dp): Dp = min(maxWidth, artHeight * MOUNTAINS_ASPECT)

@Composable
internal fun LoginContent(ui: LoginUi, kioskName: String, actions: LoginActions, canScan: Boolean = false, pairPanel: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().background(LoginPalette.Canvas)) {
        // Anchored at the bottom right; on a phone it spans the screen and crops to the peaks.
        val artHeight = loginArtHeight(maxWidth, maxHeight)
        val artWidth = loginArtWidth(maxWidth, artHeight)
        LoginTopo(Modifier.matchParentSize())
        LoginMountains(Modifier.align(Alignment.BottomEnd).width(artWidth).height(artHeight), fadeLeft = artWidth < maxWidth)

        // The form scrolls over the art. The trailing spacer covers the art below its faded
        // sky, so at the end of the scroll (or on a tall screen) the last button sits above the peaks.
        Column(Modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
            Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().padding(horizontal = 20.dp).padding(top = 16.dp)) {
                LoginBrand(kioskName)

                if (ui.status.read_only) LoginNotice(
                    if (ui.status.read_only_message.isNotBlank()) "Read-only maintenance mode — ${ui.status.read_only_message}" else "Read-only maintenance mode",
                    error = true, modifier = Modifier.padding(top = 16.dp),
                )
                ui.status.banner?.let { LoginNotice(it, modifier = Modifier.padding(top = 8.dp)) }

                Text(
                    "Sign in", color = LoginPalette.Ink, fontFamily = Geologica, fontWeight = FontWeight.ExtraBold,
                    fontSize = 34.sp, letterSpacing = (-0.85).sp, lineHeight = 38.sp,
                    modifier = Modifier.padding(top = 24.dp).semantics { heading() },
                )
                Text(
                    if (ui.view == LoginView.LINK) "Link this kiosk with your phone."
                    else if (ui.view == LoginView.MOVE) "Sign in with a move password."
                    else "Sign in to start scanning.",
                    color = LoginPalette.Slate, fontFamily = Geologica, fontWeight = FontWeight.Light, fontSize = 15.sp, lineHeight = 21.sp,
                    modifier = Modifier.padding(top = 8.dp, bottom = 20.dp),
                )

                when (ui.view) {
                    // The chooser is the password view with its routes showing; the routes are always
                    // shown now, so both views draw the same form.
                    LoginView.PASSWORD, LoginView.CHOOSER -> PasswordForm(ui, actions)
                    LoginView.LINK -> {
                        pairPanel()
                        LoginLink("Back to email & password", Modifier.align(Alignment.Start)) { actions.setView(LoginView.PASSWORD) }
                    }
                    LoginView.MOVE -> {
                        LoginField(
                            "Move password", ui.movePassword, actions.setMovePassword, tag = "login-move", masked = true, password = true,
                            invalid = ui.moveError != null, onDone = actions.submitMove,
                            trailing = if (canScan) ({ MoveScanButton(enabled = !ui.moveLoading, onClick = actions.scanMove) }) else null,
                        )
                        ui.moveError?.let { Text(it, color = LoginPalette.ErrorText, fontFamily = Geologica, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }
                        LoginPrimaryButton(
                            if (ui.moveLoading) "Signing in…" else "Sign in", actions.submitMove,
                            Modifier.padding(top = 16.dp).testTag("login-submit-move"), loading = ui.moveLoading, enabled = !ui.moveLoading,
                        )
                        LoginLink("Back to email & password", Modifier.align(Alignment.Start)) { actions.setView(LoginView.PASSWORD) }
                    }
                }
                Spacer(Modifier.height(24.dp + artHeight * (1f - ART_CLEAR_SHARE)))
            }
        }
        LoginGear(actions.openSettings, Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = 8.dp, end = 8.dp))
    }
}

@Composable
private fun ColumnScope.PasswordForm(ui: LoginUi, actions: LoginActions) {
    var forgotOpen by rememberSaveable { mutableStateOf(false) }
    LoginField("Email", ui.email, actions.setEmail, tag = "login-email", placeholder = "you@company.com", invalid = ui.invalidEmail,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false, imeAction = ImeAction.Next),
    )
    LoginField(
        "Password", ui.password, actions.setPassword, tag = "login-password", invalid = ui.invalidPassword,
        masked = !ui.showPassword, password = true, onDone = actions.submitPassword, modifier = Modifier.padding(top = 16.dp),
        trailing = { PasswordEye(ui.showPassword, actions.togglePassword) },
    )
    LoginLink("Forgot password?", Modifier.align(Alignment.End).testTag("login-forgot")) { forgotOpen = !forgotOpen }
    if (forgotOpen) Text(
        "Forgot your password? Reset it in the portal.", color = LoginPalette.Slate, fontFamily = Geologica, fontSize = 13.sp,
        modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
    )
    ui.error?.let { Text(it, color = LoginPalette.ErrorText, fontFamily = Geologica, fontSize = 13.sp, modifier = Modifier.padding(bottom = 8.dp)) }
    LoginPrimaryButton(
        if (ui.loading) "Signing in…" else "Sign in", actions.submitPassword,
        Modifier.padding(top = 4.dp).testTag("login-submit"), loading = ui.loading, enabled = !ui.loading,
    )
    LoginOrDivider()
    LoginSecondaryButton("Link with phone", RouteLinkIcon, { actions.setView(LoginView.LINK) })
    LoginSecondaryButton("Move password", LockIcon, { actions.setView(LoginView.MOVE) }, Modifier.padding(top = 10.dp))
}
