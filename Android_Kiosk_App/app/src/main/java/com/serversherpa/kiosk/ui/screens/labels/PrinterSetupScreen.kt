package com.serversherpa.kiosk.ui.screens.labels

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.ui.components.MiniButton

/** Printer Setup's place in the nav graph until the screen itself lands. */
@Composable
fun PrinterSetupScreen(nav: NavHostController) {
    Column {
        Text("Printer Setup")
        MiniButton("Back", { nav.popBackStack() })
    }
}
