package com.serversherpa.kiosk.ui.screens.troubleshooting

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.data.troubleshooting.TroubleshootingContent
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** kiosk/src/pages/Troubleshooting.tsx: the bundled hardware guides, one card each. */
@Composable
fun TroubleshootingScreen(nav: NavHostController) {
    val ctx = LocalContext.current
    val c = LocalKioskColors.current
    val topics = remember { runCatching { TroubleshootingContent.topics(ctx) }.getOrDefault(emptyList()) }
    Column {
        PageHeader("Kiosk", "Troubleshooting")
        for (t in topics) {
            SetupCard(
                selected = false,
                onClick = { nav.navigate(Routes.troubleshootingTopic(t.id)) },
                modifier = Modifier.padding(top = 12.dp).testTag("topic-${t.id}"),
            ) {
                Text(t.title, style = MaterialTheme.typography.titleLarge, color = c.textDark)
                Text(t.blurb, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}
