package com.serversherpa.kiosk.ui.screens.troubleshooting

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.data.troubleshooting.TroubleshootingContent
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.PlaceholderCard

/**
 * kiosk/src/pages/TroubleshootingTopic.tsx: one guide from its bundled wiki document. The page
 * scrolls itself (the shell doesn't). An unknown [topicId], or a doc that won't load, says so
 * and offers the way back to the list.
 */
@Composable
fun TroubleshootingTopicScreen(nav: NavHostController, topicId: String?) {
    val ctx = LocalContext.current
    val topic = remember(topicId) { runCatching { TroubleshootingContent.topics(ctx).firstOrNull { it.id == topicId } }.getOrNull() }
    val doc = remember(topic) { topic?.let { runCatching { TroubleshootingContent.doc(ctx, it) }.getOrNull() } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        if (topic == null || doc == null) {
            PageHeader("Kiosk", "Troubleshooting")
            PlaceholderCard("This topic isn't available.", "Back to Troubleshooting") {
                // Back to the list if it is underneath, else replace this page with it.
                if (!nav.popBackStack(Routes.TROUBLESHOOTING, inclusive = false)) {
                    nav.navigate(Routes.TROUBLESHOOTING) { popUpTo(Routes.TROUBLESHOOTING_TOPIC) { inclusive = true } }
                }
            }
        } else {
            PageHeader("Kiosk", topic.title)
            WikiDoc(doc)
        }
    }
}
