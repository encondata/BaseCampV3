package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.SetupOptionScanType
import com.serversherpa.kiosk.core.settings.CheckpointId
import com.serversherpa.kiosk.core.settings.effectiveCheckpoint
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import kotlinx.coroutines.launch

/** The RFID Enroll checkpoint (admin-gated: it decides what every enrollment on this kiosk records). */
@Composable
fun AdminPanel() {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()
    val stored by container.prefs.checkpoint(CheckpointId.ENROLL).collectAsStateWithLifecycle(initialValue = CheckpointId.ENROLL.fallback)
    var scanTypes by remember { mutableStateOf<List<SetupOptionScanType>?>(null) }
    var error by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { try { scanTypes = container.api.setupOptions().scan_types } catch (e: Exception) { error = true } }
    Column {
        if (error) KioskToast("Couldn't load the checkpoint list. The stored choice still applies.", error = true)
        SettingsRow(CheckpointId.ENROLL.label, "The asset status an enrollment scan records. Default pre_stage.") {
            val offered = scanTypes?.map { it.key } ?: emptyList()
            val effective = effectiveCheckpoint(CheckpointId.ENROLL, stored, offered)
            val options = scanTypes?.map { it.key to it.label } ?: listOf(effective to effective)
            Segmented(options, effective) { key -> scope.launch { container.prefs.setCheckpoint(CheckpointId.ENROLL, key) } }
        }
    }
}
