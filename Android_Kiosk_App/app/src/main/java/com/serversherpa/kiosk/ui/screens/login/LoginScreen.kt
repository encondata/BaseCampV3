package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.R
import com.serversherpa.kiosk.data.identity.KioskIdentity
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.LinkButton
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** kiosk/src/pages/Login.tsx, stacked for portrait: brand band over the paper form. */
@Composable
fun LoginScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val vm = kioskViewModel { LoginViewModel(container.auth, container.api) }
    val pairVm = kioskViewModel { PairViewModel(container.api, container.identity) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val identity by container.identity.identity.collectAsStateWithLifecycle(initialValue = KioskIdentity("", ""))
    val portalUrl by container.config.portalUrl.collectAsStateWithLifecycle(initialValue = "")
    LaunchedEffect(Unit) { vm.loadBanners() }
    val goHome = { nav.navigate(Routes.HOME) { popUpTo(0) } }

    Column(Modifier.fillMaxSize().background(c.paper).verticalScroll(rememberScrollState())) {
        // ── brand band ──
        Row(Modifier.fillMaxWidth().background(c.ink).statusBarsPadding().padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
            Image(painterResource(R.mipmap.ic_launcher_foreground), contentDescription = null, modifier = Modifier.size(56.dp))
            Column(Modifier.padding(start = 12.dp).weight(1f)) {
                Row { Text("Server", color = c.snow, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.headlineSmall); Text("Sherpa", color = c.accent, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.headlineSmall) }
                Text("KIOSK · ANDROID", fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.accentSoft)
                Text(identity.name, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.snow)
            }
            IconButton(onClick = { nav.navigate(Routes.settings("this-kiosk")) }) { Text("⚙", color = c.snow) }
        }
        Column(Modifier.padding(20.dp)) {
            if (ui.status.read_only) KioskToast(if (ui.status.read_only_message.isNotBlank()) "Read-only maintenance mode — ${ui.status.read_only_message}" else "Read-only maintenance mode", error = true)
            ui.status.banner?.let { KioskToast(it) }
            Text("Sign in", style = MaterialTheme.typography.displaySmall, modifier = Modifier.padding(bottom = 12.dp))

            if (ui.view == LoginView.PASSWORD || ui.view == LoginView.CHOOSER) {
                OutlinedTextField(ui.email, vm::setEmail, label = { Text("Email") }, placeholder = { Text("you@company.com") }, isError = ui.invalidEmail, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(ui.password, vm::setPassword, label = { Text("Password") }, isError = ui.invalidPassword, singleLine = true,
                    visualTransformation = if (ui.showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = { LinkButton(if (ui.showPassword) "Hide" else "Show") { vm.togglePassword() } },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                KioskToast(ui.error, error = true)
                SolidButton(if (ui.loading) "Signing in…" else "Sign in", onClick = { vm.submitPassword(goHome) }, enabled = !ui.loading, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                Text("Forgot your password? Reset it in the portal.", style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 8.dp))
                Row(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    HorizontalDivider(Modifier.weight(1f)); Text("  or  ", color = c.textMute); HorizontalDivider(Modifier.weight(1f))
                }
                if (ui.view == LoginView.PASSWORD) MiniButton("Other ways to sign in", { vm.setView(LoginView.CHOOSER) }, modifier = Modifier.fillMaxWidth())
                else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MiniButton("Link with phone", { vm.setView(LoginView.LINK) }, modifier = Modifier.fillMaxWidth())
                    MiniButton("Move password", { vm.setView(LoginView.MOVE) }, modifier = Modifier.fillMaxWidth())
                }
            }
            if (ui.view == LoginView.LINK) {
                Text("Link this kiosk with your phone.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 12.dp))
                PairPanel(pairVm, portalUrl) { session -> container.auth.completePair(session); goHome() }
                LinkButton("Back to email & password") { vm.setView(LoginView.PASSWORD) }
            }
            if (ui.view == LoginView.MOVE) {
                Text("Sign in with a move password.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 12.dp))
                OutlinedTextField(ui.movePassword, vm::setMovePassword, label = { Text("Move password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                if (ui.moveNotice) KioskToast("Move passwords aren't available yet. Use email & password or link with your phone.")
                SolidButton("Sign in", { vm.submitMove() }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                LinkButton("Back to email & password") { vm.setView(LoginView.PASSWORD) }
            }
            Spacer(Modifier.size(24.dp))
        }
    }
}
