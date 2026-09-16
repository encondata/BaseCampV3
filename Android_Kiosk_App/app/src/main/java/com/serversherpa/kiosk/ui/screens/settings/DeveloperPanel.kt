package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.rfid.TriggerEvent
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.PersonEntity
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.input.rfid.FakeRfidReader
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val INSPECT_CAP = 200

@Composable
fun DeveloperPanel() {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()
    val devMode by container.prefs.devMode.collectAsStateWithLifecycle(initialValue = false)
    val setupState by container.prefs.setupState.collectAsStateWithLifecycle(initialValue = SetupState.INCOMPLETE)
    val sync by container.sync.status.collectAsStateWithLifecycle()
    var clearError by remember { mutableStateOf(false) }
    Column {
        SettingsRow("Developer mode", "Shows diagnostics and developer tools on this kiosk. Stored on this kiosk only.") {
            Switch(checked = devMode, onCheckedChange = { on -> scope.launch { container.prefs.setDevMode(on) } })
        }
        if (!devMode) return@Column
        SettingsRow("Kiosk setup state", "Testing aid until real setup logic sets this. Stored on this kiosk only.") {
            Segmented(SetupState.entries.map { it.wire to it.label }, setupState.wire) { w -> scope.launch { container.prefs.setSetupState(SetupState.fromWire(w)) } }
        }
        SettingsRow("Local data", if (sync.phase == SyncPhase.DONE) "${sync.assets ?: 0} assets · ${sync.people ?: 0} people · ${sync.containers ?: 0} containers · ${sync.trucks ?: 0} trucks" + (sync.syncedAt?.let { " · synced ${Sync.formatSyncedAt(it)}" } ?: "") else "Nothing downloaded yet.") {
            if (clearError) KioskToast("Couldn't clear local data.", error = true)
            MiniButton("Clear local data", { scope.launch { try { container.sync.clearLocalData() } catch (e: Exception) { clearError = true } } })
        }
        val fakeReader = container.rfidReader as? FakeRfidReader
        if (fakeReader != null) {
            // A real device never has a FakeRfidReader (AppContainer only installs
            // one when a test overrides it), so this row simply does not render
            // there — nothing to gate or explain on hardware.
            SettingsRow(
                "Simulate an RFID connection",
                "Connects a synthetic reader and drives it through a full trigger-and-tag burst, proving the RFID adapter and its settings push work with no sled attached. RFID reading itself only ever happens on the Scanning screen, once a reader — fake or real — is armed there, so this control does not reach that screen's live panel and queues nothing to the outbox.",
            ) {
                MiniButton("Simulate an RFID sweep", {
                    scope.launch {
                        fakeReader.connect()
                        fakeReader.emitTrigger(TriggerEvent.PRESSED)
                        for (tag in listOf("100348", "100349", "100350", "100348")) {
                            fakeReader.emitTag(tag)
                            delay(120)
                        }
                        fakeReader.emitTrigger(TriggerEvent.RELEASED)
                    }
                })
            }
        }
        LocalDataInspector()
    }
}

/** Assets and people, filterable, capped at 200 rows each. */
@Composable
private fun LocalDataInspector() {
    val container = LocalAppContainer.current
    val sync by container.sync.status.collectAsStateWithLifecycle()
    var filter by remember { mutableStateOf("") }
    var assets by remember { mutableStateOf<List<AssetEntity>>(emptyList()) }
    var people by remember { mutableStateOf<List<PersonEntity>>(emptyList()) }
    LaunchedEffect(sync.phase, sync.syncedAt) { assets = container.db.assets().all(); people = container.db.people().all() }
    val q = filter.trim().lowercase()
    val shownAssets = assets.filter { q.isEmpty() || listOfNotNull(it.assetId, it.name, it.serialNumber, it.rfid).any { v -> v.lowercase().contains(q) } }.take(INSPECT_CAP)
    val shownPeople = people.filter { q.isEmpty() || listOfNotNull(it.displayName, it.rfidTag).any { v -> v.lowercase().contains(q) } }.take(INSPECT_CAP)
    Column(Modifier.padding(top = 12.dp)) {
        OutlinedTextField(filter, { filter = it }, label = { Text("Filter local data") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Text("Assets (${shownAssets.size} of ${assets.size})", fontFamily = FragmentMono, modifier = Modifier.padding(top = 12.dp))
        for (a in shownAssets) Text("${a.assetId} · ${a.name ?: "—"} · ${a.serialNumber ?: "—"} · ${displayRfid(a.rfid)}", fontFamily = FragmentMono, modifier = Modifier.padding(vertical = 2.dp))
        Text("People (${shownPeople.size} of ${people.size})", fontFamily = FragmentMono, modifier = Modifier.padding(top = 12.dp))
        for (p in shownPeople) Text("${p.displayName} · ${displayRfid(p.rfidTag)}", fontFamily = FragmentMono, modifier = Modifier.padding(vertical = 2.dp))
    }
}
