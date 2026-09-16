package com.serversherpa.kiosk.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextOverflow
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
import com.serversherpa.kiosk.ui.Routes
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
    val backStack by nav.currentBackStackEntryAsState()
    val feature = featureForRoute(backStack?.destination?.route)
    val scope = rememberCoroutineScope()
    val authed = auth as? AuthState.Authed
    val outbox by container.outbox.snapshot.collectAsStateWithLifecycle()
    // Signing out ends the shift's session from a button anyone can brush past, so
    // it asks first — and says so when scans are still waiting to be sent.
    var confirmSignOut by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().background(c.paper2)) {
        // ── top bar ──
        // Two stacked lines on the left — the brand, then which kiosk this is and who
        // is on it — with Sign out on the right drawn as tall as the pair. The mode
        // chip and the section title are deliberately absent: every page prints its
        // own title below.
        Row(
            Modifier.fillMaxWidth().background(c.ink).statusBarsPadding()
                .padding(start = 14.dp, end = 10.dp, top = 6.dp, bottom = 6.dp)
                .height(IntrinsicSize.Min),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    androidx.compose.foundation.Image(
                        painterResource(R.mipmap.ic_launcher_foreground), contentDescription = null,
                        modifier = Modifier.size(24.dp),
                    )
                    // One string, not two Texts nudged together: the nudged pair
                    // overlapped and read "ServeSherpa" on a real device.
                    Text(
                        buildAnnotatedString {
                            append("Server")
                            withStyle(SpanStyle(color = c.accent)) { append("Sherpa") }
                        },
                        color = c.snow, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                // The kiosk's own name, then who is on it. The person gives way first,
                // so the kiosk's name is never the thing that gets clipped.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        identity.name, fontFamily = FragmentMono, color = c.snow,
                        style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clickable { nav.navigate(Routes.settings("this-kiosk")) },
                    )
                    authed?.let {
                        Text(" · ", color = c.textMute, style = MaterialTheme.typography.labelMedium)
                        Text(
                            it.person.display_name, color = c.textMute, style = MaterialTheme.typography.bodySmall,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                }
            }
            if (authed != null) {
                // The way out doubles as the status light: its outline is the kiosk's
                // registration state (green registered, amber expiring, red expired,
                // slate unregistered), so the bar needs no separate chip for it.
                MiniButton(
                    "Sign out",
                    onClick = { confirmSignOut = true },
                    borderColor = registration?.let { REG_TONE.getValue(it).text },
                    modifier = Modifier.padding(start = 8.dp).fillMaxHeight().semantics {
                        contentDescription = registration?.let { "Sign out. Kiosk ${it.label.lowercase()}" } ?: "Sign out"
                    },
                )
            }
        }
        // ── page ──
        Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp)) { content() }
        // ── footer ──
        FlowRow(Modifier.fillMaxWidth().background(c.paper).navigationBarsPadding().padding(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            // What move this kiosk is set to, and nothing else. Mode, version and the
            // sync light said nothing an operator acts on; the version lives in
            // Settings and Kiosk Setup owns the sync state.
            setup?.let { FootItem("Move", it.initiativeName); FootItem("Site", it.siteName); FootItem("Scan", it.scanLabel) }
            if (devMode) FootItem("Dev mode", "On", valueColor = c.accent)
        }
    }

    if (confirmSignOut) {
        val waiting = outbox.counts.queued + outbox.counts.failed
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out of this kiosk?") },
            text = {
                Text(
                    buildString {
                        append("Whoever uses this kiosk next has to sign in again.")
                        when {
                            waiting == 1 -> append(" One scan here hasn't reached the portal yet; it waits on this kiosk until someone signs in.")
                            waiting > 1 -> append(" $waiting scans here haven't reached the portal yet; they wait on this kiosk until someone signs in.")
                        }
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmSignOut = false
                    scope.launch { container.logout(); nav.navigate(Routes.LOGIN) { popUpTo(0) } }
                }) { Text("Sign out") }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun FootItem(label: String, value: String, valueColor: androidx.compose.ui.graphics.Color = LocalKioskColors.current.textDark) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label.uppercase(), fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = LocalKioskColors.current.textMute)
        Text(value, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = valueColor)
    }
}
