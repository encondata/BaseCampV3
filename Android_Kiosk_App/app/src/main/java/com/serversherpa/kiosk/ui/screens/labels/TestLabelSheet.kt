package com.serversherpa.kiosk.ui.screens.labels

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/**
 * Printer Setup's test labels (the web kiosk's TestLabelModal): an alignment label (boxes that
 * fill the picked template's size) or a sample label (the picked template with sample values),
 * sent with the offsets in the fields and the saved peel/tear mode. The offsets are here too, so
 * a label can be adjusted and printed again until it lines up.
 */
@Composable
fun TestLabelSheet(
    vm: PrinterSetupViewModel,
    ui: PrinterSetupUi,
    size: AlignmentSize?,
    templateName: String?,
    onDismiss: () -> Unit,
) {
    val c = LocalKioskColors.current
    var choice by remember { mutableStateOf(TestLabel.ALIGNMENT) }
    Dialog(onDismissRequest = { if (!ui.testing) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.fillMaxWidth().padding(16.dp).background(c.paper, RoundedCornerShape(16.dp))
                .verticalScroll(rememberScrollState()).padding(16.dp),
        ) {
            Text("PRINTER SETUP", style = MaterialTheme.typography.labelSmall, color = c.textMute)
            Text("Test labels", style = MaterialTheme.typography.headlineSmall, color = c.textDark, modifier = Modifier.padding(top = 4.dp))
            Text(
                "Print a test label, then adjust the offsets and print again until it lines up. The offsets save as you type.",
                style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp),
            )
            SetupCard(choice == TestLabel.ALIGNMENT, onClick = { choice = TestLabel.ALIGNMENT }, modifier = Modifier.padding(bottom = 8.dp)) {
                CardText(
                    "Alignment label",
                    if (size != null) "Boxes that fill the ${size.label} label: ${size.widthDots} × ${size.heightDots} dots at ${size.dpi} DPI."
                    else "Boxes that fill the whole label.",
                )
            }
            SetupCard(choice == TestLabel.SAMPLE, onClick = { choice = TestLabel.SAMPLE }, modifier = Modifier.padding(bottom = 8.dp)) {
                CardText("Sample label", "${templateName ?: "The move's template"} filled with sample values.")
            }
            if (size != null) OffsetFields(vm, ui, size.dpi)
            KioskToast(ui.testMessage, error = ui.testError)
            // Bluetooth off or not allowed, or a printer that forgot this device: the button that fixes it.
            if (ui.testError) bluetoothFixFor(ui.testMessage)?.let { BluetoothFixButton(it) }
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SolidButton(if (ui.testing) "Sending…" else "Print test label", { vm.printTest(choice) }, enabled = !ui.busy)
                MiniButton("Done", onDismiss, enabled = !ui.testing)
            }
        }
    }
}
