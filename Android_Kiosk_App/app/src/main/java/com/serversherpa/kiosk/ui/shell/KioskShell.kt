package com.serversherpa.kiosk.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.currentBackStackEntryAsState
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.R
import com.serversherpa.kiosk.core.devices.RegistrationState
import com.serversherpa.kiosk.core.features.featureForRoute
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.identity.KioskIdentity
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.launch

private val REG_TONE = mapOf(RegistrationState.OK to ChipTone.GREEN, RegistrationState.SOON to ChipTone.AMBER, RegistrationState.EXPIRED to ChipTone.RED, RegistrationState.NONE to ChipTone.SLATE)

/** kiosk/src/layout/KioskShell.tsx: dark top bar, the page, one-line mono footer. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun KioskShell(nav: NavHostController, content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val identity by container.identity.identity.collectAsStateWithLifecycle(initialValue = KioskIdentity("", ""))
    val registration by container.heartbeat.registration.collectAsStateWithLifecycle()
    val setup by container.prefs.setupSelection.collectAsStateWithLifecycle(initialValue = null)
    val devMode by container.prefs.devMode.collectAsStateWithLifecycle(initialValue = false)
    val sync by container.sync.status.collectAsStateWithLifecycle()
    val backStack by nav.currentBackStackEntryAsState()
    val feature = featureForRoute(backStack?.destination?.route)
    val scope = rememberCoroutineScope()
    val authed = auth as? AuthState.Authed

    Column(Modifier.fillMaxSize().background(c.paper2)) {
        // ── top bar ──
        Column(Modifier.fillMaxWidth().background(c.ink).statusBarsPadding().padding(horizontal = 14.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                androidx.compose.foundation.Image(painterResource(R.mipmap.ic_launcher_foreground), contentDescription = null, modifier = Modifier.size(30.dp))
                Text(buildString { append("Server") }, color = c.snow, fontWeight = FontWeight.SemiBold)
                Text("Sherpa", color = c.accent, fontWeight = FontWeight.SemiBold, modifier = Modifier.offset(x = (-8).dp))
                Text("KIOSK · ANDROID", fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.accentSoft)
                if (feature != null) Text(feature.title, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.snow)
            }
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(identity.name, fontFamily = FragmentMono, color = c.snow, modifier = Modifier.clickable { nav.navigate(Routes.settings("this-kiosk")) }.padding(6.dp))
                androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
                if (authed != null) {
                    registration?.let { KioskChip(it.label, REG_TONE.getValue(it)) }
                    Text(authed.person.display_name, color = c.snow, style = MaterialTheme.typography.bodySmall)
                    MiniButton("Sign out", onClick = { scope.launch { container.logout(); nav.navigate(Routes.LOGIN) { popUpTo(0) } } })
                }
            }
        }
        // ── page ──
        Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp)) { content() }
        // ── footer ──
        FlowRow(Modifier.fillMaxWidth().background(c.paper).navigationBarsPadding().padding(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FootItem("Mode", "Android")
            FootItem("Version", container.config.kioskVersion)
            setup?.let { FootItem("Move", it.initiativeName); FootItem("Site", it.siteName); FootItem("Scan", it.scanLabel) }
            val good = sync.phase == SyncPhase.DONE
            Text("Data Sync", fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = if (good) ChipTone.GREEN.text else ChipTone.RED.text)
            if (devMode) FootItem("Dev mode", "On", valueColor = c.accent)
        }
    }
}

@Composable
private fun FootItem(label: String, value: String, valueColor: androidx.compose.ui.graphics.Color = LocalKioskColors.current.textDark) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label.uppercase(), fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = LocalKioskColors.current.textMute)
        Text(value, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = valueColor)
    }
}
