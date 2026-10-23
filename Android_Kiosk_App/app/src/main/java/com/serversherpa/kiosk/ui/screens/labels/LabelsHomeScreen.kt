package com.serversherpa.kiosk.ui.screens.labels

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** "ZD421 at 10.0.0.5 · 203 dpi" / "ZD421 · Bluetooth D8J224508535 · 300 dpi" ("Zebra" when the
 *  printer didn't name its model). */
internal fun printerSummary(p: SavedPrinter): String {
    val model = p.model.ifBlank { "Zebra" }
    return when (val c = p.connection) {
        is PrinterConnection.Network -> "$model at ${c.host} · ${p.dpi} dpi"
        is PrinterConnection.Bluetooth -> "$model · Bluetooth ${c.serial} · ${p.dpi} dpi"
    }
}

/** The Label Printing tile: Print Labels and Printer Setup. */
@Composable
fun LabelsHomeScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val settings by container.labelSettings.settings.collectAsStateWithLifecycle(initialValue = null)
    Column {
        PageHeader("Kiosk · Label Printing", "Label Printing", "Print asset labels.")
        SetupCard(selected = false, onClick = { nav.navigate(Routes.LABELS_PRINT) }, modifier = Modifier.padding(bottom = 10.dp)) {
            Text("Print Labels", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text("Scan an asset and its label prints.", style = MaterialTheme.typography.bodySmall, color = c.textMute)
        }
        SetupCard(selected = false, onClick = { nav.navigate(Routes.LABELS_PRINTER) }, modifier = Modifier.padding(bottom = 10.dp)) {
            Text("Printer Setup", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            val printer = settings?.printer
            Text(
                if (printer != null) printerSummary(printer) else if (settings != null) "No printer set up yet." else "",
                style = MaterialTheme.typography.bodySmall, color = c.textMute,
            )
        }
    }
}
