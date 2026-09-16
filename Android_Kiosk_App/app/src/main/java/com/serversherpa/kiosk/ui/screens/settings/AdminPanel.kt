package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
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
import com.serversherpa.kiosk.core.rfid.RegionChoice
import com.serversherpa.kiosk.core.rfid.RfidConnection
import com.serversherpa.kiosk.core.rfid.RfidRegions
import com.serversherpa.kiosk.core.rfid.regionChoice
import com.serversherpa.kiosk.core.rfid.regionLine
import com.serversherpa.kiosk.core.settings.CheckpointId
import com.serversherpa.kiosk.core.settings.effectiveCheckpoint
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** The RFID Enroll checkpoint, and the RFID region — both admin-gated: one
 *  decides what every enrollment on this kiosk records, the other decides
 *  what country the reader is legally allowed to transmit in. Region lives
 *  here, not on the RFID tab anyone signed in can reach, because it is a
 *  compliance setting, not a preference — see
 *  `docs/superpowers/specs/2026-09-16-android-rfd40-region-design.md`. */
@Composable
fun AdminPanel() {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val scope = rememberCoroutineScope()
    val stored by container.prefs.checkpoint(CheckpointId.ENROLL).collectAsStateWithLifecycle(initialValue = CheckpointId.ENROLL.fallback)
    var scanTypes by remember { mutableStateOf<List<SetupOptionScanType>?>(null) }
    var error by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { try { scanTypes = container.api.setupOptions().scan_types } catch (e: Exception) { error = true } }

    val connection by container.rfid.connection.collectAsStateWithLifecycle()
    var regions by remember { mutableStateOf(RfidRegions(emptyList(), null)) }
    // Keyed on whether the reader is connected, not on the connection value
    // itself, so the list loads when a reader connects and clears when it goes
    // away — without re-querying on every battery level change. The Connected
    // state carries a battery percentage that updates periodically, so keying
    // on the whole value would trigger needless Bluetooth round trips.
    val isConnected = connection is RfidConnection.Connected
    LaunchedEffect(isConnected) {
        regions = if (isConnected) {
            container.rfid.loadRegions().getOrNull() ?: RfidRegions(emptyList(), null)
        } else {
            RfidRegions(emptyList(), null)
        }
    }

    Column {
        if (error) KioskToast("Couldn't load the checkpoint list. The stored choice still applies.", error = true)
        SettingsRow(CheckpointId.ENROLL.label, "The asset status an enrollment scan records. Default pre_stage.") {
            val offered = scanTypes?.map { it.key } ?: emptyList()
            val effective = effectiveCheckpoint(CheckpointId.ENROLL, stored, offered)
            val options = scanTypes?.map { it.key to it.label } ?: listOf(effective to effective)
            Segmented(options, effective) { key -> scope.launch { container.prefs.setCheckpoint(CheckpointId.ENROLL, key) } }
        }
        SettingsRow(
            "RFID region",
            "The regulatory domain the reader transmits in. It must match the country this kiosk is operating in.",
        ) {
            val choice = regionChoice(regions)
            Column {
                Text(regionLine(choice), color = c.textMute)
                if (choice is RegionChoice.Choosable) {
                    var selectedCode by remember(choice.active?.code) { mutableStateOf(choice.active?.code ?: "") }
                    // Deliberately NOT keyed on choice.active?.code, unlike selectedCode
                    // above: a successful pick() reloads `regions`, which moves
                    // choice.active on to the code just picked — keying this the same
                    // way would silently reset an operator's own hopping choice back to
                    // the default right after every successful pick.
                    var hoppingOn by remember { mutableStateOf(true) }
                    var regionError by remember { mutableStateOf<String?>(null) }

                    fun pick(code: String, hopping: Boolean?) {
                        val previousCode = selectedCode
                        selectedCode = code
                        scope.launch {
                            val result = container.rfid.setRegion(code, hopping)
                            result.onSuccess {
                                regionError = null
                                regions = container.rfid.loadRegions().getOrNull() ?: regions
                                // The last known code, so this row (and the RFID tab's
                                // read-only line) can say something useful while
                                // disconnected. Excluded from RfidController's ordinary
                                // settings-push comparison — see the class doc there —
                                // so writing it here never triggers a full radio push.
                                val current = container.prefs.rfid.first()
                                container.prefs.setRfid(current.copy(region = code))
                            }.onFailure { e ->
                                regionError = e.message ?: "The reader refused the region."
                                selectedCode = previousCode
                            }
                        }
                    }

                    Segmented(choice.regions.map { it.code to it.name }, selectedCode) { code ->
                        val region = choice.regions.firstOrNull { it.code == code }
                        pick(code, if (region?.hoppingConfigurable == true) hoppingOn else null)
                    }
                    val chosen = choice.regions.firstOrNull { it.code == selectedCode }
                    if (chosen?.hoppingConfigurable == true) {
                        Row {
                            Text("Frequency hopping", color = c.textMute)
                            Switch(checked = hoppingOn, onCheckedChange = { on ->
                                hoppingOn = on
                                pick(selectedCode, on)
                            })
                        }
                    }
                    regionError?.let { KioskToast(it, error = true) }
                }
            }
        }
    }
}
