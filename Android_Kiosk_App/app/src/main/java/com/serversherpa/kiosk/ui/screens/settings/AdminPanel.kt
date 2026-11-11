package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import com.serversherpa.kiosk.core.rfid.SledNotConnected
import com.serversherpa.kiosk.core.rfid.SledWords
import com.serversherpa.kiosk.core.rfid.regionChoice
import com.serversherpa.kiosk.core.rfid.regionLine
import com.serversherpa.kiosk.core.settings.CheckpointId
import com.serversherpa.kiosk.core.settings.effectiveCheckpoint
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
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
    var regionsFailed by remember { mutableStateOf(false) }
    var reloads by remember { mutableIntStateOf(0) }
    // Kept here, not inside the region list below: a region set on a sled with none takes
    // the link down and up again, which empties the list while the write is still running.
    var regionError by remember { mutableStateOf<String?>(null) }
    var settingInNeedsRegion by remember { mutableStateOf(false) }
    // Keyed on whether the link is up (Connected or NeedsRegion: a sled with no region
    // still answers for its region list, which is what fixes it), not on the connection
    // value itself, so the list loads when a reader connects and clears when it goes
    // away — without re-querying on every battery level change. The Connected state
    // carries a battery percentage that updates periodically, so keying on the whole
    // value would trigger needless Bluetooth round trips. [reloads] is Retry.
    val linkUp = connection is RfidConnection.Connected || connection is RfidConnection.NeedsRegion
    LaunchedEffect(linkUp, reloads) {
        // A refusal belongs to the link it came from. A set refused in NeedsRegion returns
        // before the link moves, so its sentence still shows; one left from before a drop goes.
        if (!linkUp) regionError = null
        regionsFailed = false
        regions = if (linkUp) {
            val result = container.rfid.loadRegions()
            // A link that went away meanwhile says nothing; any other failure offers Retry.
            regionsFailed = result.exceptionOrNull()?.let { it !is SledNotConnected } ?: false
            result.getOrNull() ?: RfidRegions(emptyList(), null)
        } else {
            RfidRegions(emptyList(), null)
        }
    }

    fun pick(code: String, hopping: Boolean?, onRefused: () -> Unit) {
        settingInNeedsRegion = connection is RfidConnection.NeedsRegion
        scope.launch {
            try {
                val result = container.rfid.setRegion(code, hopping)
                result.onSuccess {
                    regionError = null
                    regions = container.rfid.loadRegions().getOrNull() ?: regions
                    // The last known code, so this row (and the RFID tab's read-only line)
                    // can say something useful while disconnected. Excluded from
                    // RfidController's ordinary settings-push comparison — see the class
                    // doc there — so writing it here never triggers a full radio push.
                    container.prefs.updateRfid { it.copy(region = code) }
                }.onFailure { e ->
                    regionError = e.message?.takeIf { it.isNotBlank() } ?: SledWords.REGION_NOT_SET
                    onRefused()
                }
            } finally {
                settingInNeedsRegion = false
            }
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
                // Set on a sled that had no region: the write was taken once the link left
                // NeedsRegion, and the sled is being set up again until setRegion returns.
                val reconnectingAfterSet = settingInNeedsRegion && connection !is RfidConnection.NeedsRegion
                when {
                    reconnectingAfterSet -> Text(SledWords.REGION_SET_RECONNECTING, color = c.textMute)
                    regionsFailed -> {
                        Text(SledWords.REGIONS_FAILED, color = ChipTone.RED.text)
                        MiniButton(SledWords.RETRY, { reloads++ })
                    }
                    else -> Text(regionLine(choice), color = c.textMute)
                }
                if (choice is RegionChoice.Choosable && !reconnectingAfterSet) {
                    var selectedCode by remember(choice.active?.code) { mutableStateOf(choice.active?.code ?: "") }
                    // Deliberately NOT keyed on choice.active?.code, unlike selectedCode
                    // above: a successful pick() reloads `regions`, which moves
                    // choice.active on to the code just picked — keying this the same
                    // way would silently reset an operator's own hopping choice back to
                    // the default right after every successful pick.
                    var hoppingOn by remember { mutableStateOf(true) }

                    fun choose(code: String, hopping: Boolean?) {
                        val previousCode = selectedCode
                        selectedCode = code
                        pick(code, hopping) { selectedCode = previousCode }
                    }

                    Segmented(choice.regions.map { it.code to it.name }, selectedCode) { code ->
                        val region = choice.regions.firstOrNull { it.code == code }
                        choose(code, if (region?.hoppingConfigurable == true) hoppingOn else null)
                    }
                    // Only a region the sled says has configurable hopping offers the switch.
                    val chosen = choice.regions.firstOrNull { it.code == selectedCode }
                    if (chosen?.hoppingConfigurable == true) {
                        Row {
                            Text("Frequency hopping", color = c.textMute)
                            Switch(checked = hoppingOn, onCheckedChange = { on ->
                                hoppingOn = on
                                choose(selectedCode, on)
                            })
                        }
                    }
                }
                regionError?.let { KioskToast(it, error = true) }
            }
        }
    }
}
