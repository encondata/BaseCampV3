package com.serversherpa.kiosk.ui.screens.placeholder

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.core.features.KioskFeature
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.PlaceholderCard

@Composable
fun FeaturePlaceholderScreen(feature: KioskFeature, nav: NavHostController) {
    Column {
        PageHeader("Kiosk · ${feature.title}", feature.title, "Coming soon. ${feature.blurb}")
        PlaceholderCard("This feature is not available yet.", "Back to home") { nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } } }
    }
}
