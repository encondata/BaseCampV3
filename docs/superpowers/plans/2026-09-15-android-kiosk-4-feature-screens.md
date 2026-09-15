# Android Kiosk Implementation Plan — Part 4 of 4: Feature Screens and Wrap-up

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Parts 1–3 must be complete first; their Global Constraints apply here verbatim.

**Goal:** The five working screens (Kiosk Setup, Settings, Scanning, RFID Enroll, Timeclock), then the wrap-up: README, spec implementation notes, the full test + build gate, and live verification on the Zebra MC2200 and the phone emulator against the dev API.

**Architecture:** Each screen is a `ViewModel` (plain Kotlin state machine over `StateFlow`, constructed with `kioskViewModel { }` from `AppContainer` pieces so tests build it directly) plus a Compose screen. The three scan screens collect `container.scanBus.events` inside their ViewModel and call the same `onScan(value)` the keyboard path calls.

**Tech Stack:** as Part 3.

**Spec:** `docs/superpowers/specs/2026-09-15-android-kiosk-design.md` sections "Kiosk Setup", "Scanning", "RFID Enroll", "Timeclock", "Settings", "Testing". Reference: `kiosk/src/pages/{KioskSetup,Settings,Scan,Enroll,Timeclock}.tsx`, `kiosk/src/components/{ThisKioskPanel,SoundPanel,LocalDataInspector}.tsx`. Read the referenced `.tsx` before each task — the copy and the edge rules come from there.

## Global Constraints (in addition to Parts 1–3)

- ViewModel constructors take only `AppContainer`-provided objects and a `CoroutineScope` (default `viewModelScope`), never the container itself, so tests can pass fakes.
- A scan screen's ViewModel collects the bus in `init` on its scope; the nav-scoped ViewModel is cleared when the screen leaves the back stack, which ends the collection.
- Subagents running the suite: run it FOREGROUND in one continuous command with a 600000 ms timeout; never background a Gradle test run.

---

### Task 20: Kiosk Setup wizard and summary

**Files:**
- Create: `ui/screens/setup/KioskSetupViewModel.kt`, `ui/screens/setup/KioskSetupScreen.kt`
- Modify: `ui/KioskApp.kt` (SETUP route → `KioskSetupScreen(nav)`)
- Test: `ui/screens/setup/KioskSetupViewModelTest.kt`, `ui/screens/setup/KioskSetupScreenTest.kt`

**Interfaces:**
- Produces: `data class SetupUi(wizardOpen, options: SetupOptions?, loadError, step: Int, initiativeId, siteId, scanStatus, submitting, submitError: String?)`; `class KioskSetupViewModel(api, prefs, identity, sync, scope)` with `state`, `selection: StateFlow<KioskSetupSelection?>`, `setupState: StateFlow<SetupState>`, `fun load()`, `fun openWizard(preselect: Boolean)`, `fun cancelWizard()`, `fun selectMove(id)`, `fun selectSite(id)`, `fun back()`, `fun finish(scanKey)`, `fun resync()`, `fun siteChoices(): List<Pair<SetupOptionSite, String>>`; `fun formatMoveDates(i: SetupOptionInitiative): String?`; `@Composable fun KioskSetupScreen(nav)`.

- [ ] **Step 1: Tests first**

`KioskSetupViewModelTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.setup

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskSetupResult
import com.serversherpa.kiosk.core.model.SetupOptionInitiative
import com.serversherpa.kiosk.core.model.SetupOptionScanType
import com.serversherpa.kiosk.core.model.SetupOptionSite
import com.serversherpa.kiosk.core.model.SetupOptions
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class KioskSetupViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    private val options = SetupOptions(
        initiatives = listOf(SetupOptionInitiative("i1", "Move A", "in_progress", "In progress", "Acme", "2026-09-20T00:00:00Z", "2026-09-22T00:00:00Z", SetupOptionSite("s1", "Origin"), SetupOptionSite("s2", "Dest"))),
        scan_types = listOf(SetupOptionScanType("pre_stage", "Pre-stage", "#abc")),
    )

    @Test fun wizardWalksThreeStepsAndSaves() = runTest {
        val api = FakeKioskApi().apply {
            setupOptionsResult = { options }
            submitSetupResult = { KioskSetupResult("d", it.initiative_id, "Move A", it.site_id, "Dest", "destination", it.scan_status, "Pre-stage") }
        }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "s.preferences_pb") })
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        vm.load(); advanceUntilIdle()
        assertEquals(1, vm.state.value.step)
        vm.selectMove("i1"); assertEquals(2, vm.state.value.step)
        assertEquals(listOf("Origin" to "source", "Dest" to "destination"), vm.siteChoices().map { it.first.name to it.second })
        vm.selectSite("s2"); assertEquals(3, vm.state.value.step)
        vm.finish("pre_stage"); advanceUntilIdle()
        assertEquals(false, vm.state.value.wizardOpen)
        assertEquals("Dest", prefs.setupSelection.first()?.siteName)
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())
        assertEquals(true, "syncAssets" in api.calls)
    }

    @Test fun failureMarksFailedOnlyWhenNotAlreadyComplete() = runTest {
        val api = FakeKioskApi().apply { setupOptionsResult = { options }; submitSetupResult = { throw ApiError(422, "bad_site") } }
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "f.preferences_pb") })
        val sync = Sync(api, KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()), backgroundScope)
        val vm = KioskSetupViewModel(api, prefs, Identity(prefs), sync, backgroundScope)
        vm.load(); advanceUntilIdle(); vm.selectMove("i1"); vm.selectSite("s1"); vm.finish("pre_stage"); advanceUntilIdle()
        assertEquals("bad_site", vm.state.value.submitError)
        assertEquals(SetupState.FAILED, prefs.setupState.first())
        assertNull(prefs.setupSelection.first())
    }

    @Test fun dates() {
        assertEquals("Sep 20 – Sep 22", formatMoveDates(options.initiatives[0]))
        assertEquals("Starts Sep 20", formatMoveDates(options.initiatives[0].copy(scheduled_end = null)))
        assertNull(formatMoveDates(options.initiatives[0].copy(scheduled_start = null, scheduled_end = null)))
    }
}
```

`KioskSetupScreenTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.setup

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class KioskSetupScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun summaryWhenSetUp() {
        val c = testContainer()
        runBlocking {
            c.prefs.setSetupState(SetupState.COMPLETE)
            c.prefs.setSetupSelection(KioskSetupSelection("i", "Move A", "s", "Dock 4", "source", "pre_stage", "Pre-stage"))
        }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { KioskSetupScreen(rememberNavController()) } } }
        compose.onNodeWithText("Move A", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Change setup").assertIsDisplayed()
        compose.onNodeWithText("No move data on this kiosk yet.").assertIsDisplayed()
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`KioskSetupViewModel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.setup

import androidx.lifecycle.ViewModel
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskSetupIn
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.model.SetupOptionInitiative
import com.serversherpa.kiosk.core.model.SetupOptionSite
import com.serversherpa.kiosk.core.model.SetupOptions
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SetupUi(
    val wizardOpen: Boolean = true,
    val options: SetupOptions? = null,
    val loadError: Boolean = false,
    val step: Int = 1,
    val initiativeId: String = "", val siteId: String = "", val scanStatus: String = "",
    val submitting: Boolean = false, val submitError: String? = null,
)

private fun day(iso: String): String = try {
    DateTimeFormatter.ofPattern("MMM d").format(Instant.parse(iso).atZone(ZoneId.of("UTC")))
} catch (e: Exception) { iso.take(10) }

/** "Sep 20 – Sep 22" / "Starts Sep 20" / "Ends Sep 22" / null. */
fun formatMoveDates(i: SetupOptionInitiative): String? {
    val s = i.scheduled_start?.let(::day); val e = i.scheduled_end?.let(::day)
    return when {
        s != null && e != null -> "$s – $e"
        s != null -> "Starts $s"
        e != null -> "Ends $e"
        else -> null
    }
}

/** kiosk/src/pages/KioskSetup.tsx: Move → Site → Scan type, then the summary. */
class KioskSetupViewModel(
    private val api: KioskApi, private val prefs: KioskPrefs, private val identity: Identity,
    private val sync: Sync, private val scope: CoroutineScope,
) : ViewModel() {
    val selection: StateFlow<KioskSetupSelection?> = prefs.setupSelection.stateIn(scope, SharingStarted.Eagerly, null)
    val setupState: StateFlow<SetupState> = prefs.setupState.stateIn(scope, SharingStarted.Eagerly, SetupState.INCOMPLETE)
    private val _state = MutableStateFlow(SetupUi())
    val state: StateFlow<SetupUi> = _state

    init {
        scope.launch {
            val sel = prefs.setupSelection.first(); val st = prefs.setupState.first()
            _state.update { it.copy(wizardOpen = !(sel != null && st.isComplete)) }
            if (_state.value.wizardOpen) load()
        }
    }

    fun load() {
        _state.update { it.copy(loadError = false, options = null) }
        scope.launch {
            try {
                val opts = api.setupOptions()
                _state.update { ui ->
                    // Revalidate cached choices against what the portal offers now.
                    var s = ui.copy(options = opts)
                    if (s.initiativeId.isNotEmpty() && opts.initiatives.none { it.id == s.initiativeId }) s = s.copy(initiativeId = "", siteId = "", scanStatus = "")
                    val init = opts.initiatives.firstOrNull { it.id == s.initiativeId }
                    val sites = listOfNotNull(init?.source_site?.id, init?.destination_site?.id)
                    if (s.siteId.isNotEmpty() && s.siteId !in sites) s = s.copy(siteId = "")
                    if (s.scanStatus.isNotEmpty() && opts.scan_types.none { it.key == s.scanStatus }) s = s.copy(scanStatus = "")
                    s
                }
            } catch (e: Exception) { _state.update { it.copy(loadError = true) } }
        }
    }

    fun openWizard(preselect: Boolean) {
        val sel = selection.value
        _state.update {
            if (preselect && sel != null) it.copy(wizardOpen = true, step = 1, submitError = null, initiativeId = sel.initiativeId, siteId = sel.siteId, scanStatus = sel.scanStatus)
            else it.copy(wizardOpen = true, step = 1, submitError = null, initiativeId = "", siteId = "", scanStatus = "")
        }
        load()
    }

    fun cancelWizard() = _state.update { it.copy(wizardOpen = false) }
    fun selectMove(id: String) = _state.update { it.copy(initiativeId = id, siteId = if (id != it.initiativeId) "" else it.siteId, step = 2) }
    fun selectSite(id: String) = _state.update { it.copy(siteId = id, step = 3) }
    fun back() = _state.update { it.copy(step = (it.step - 1).coerceAtLeast(1)) }

    fun siteChoices(): List<Pair<SetupOptionSite, String>> {
        val init = _state.value.options?.initiatives?.firstOrNull { it.id == _state.value.initiativeId } ?: return emptyList()
        return listOfNotNull(init.source_site?.let { it to "source" }, init.destination_site?.let { it to "destination" })
    }

    fun finish(scanKey: String) {
        val ui = _state.value
        _state.update { it.copy(scanStatus = scanKey, submitting = true, submitError = null) }
        scope.launch {
            try {
                val result = api.submitSetup(KioskSetupIn(identity.get().serial, ui.initiativeId, ui.siteId, scanKey))
                prefs.setSetupSelection(KioskSetupSelection(result.initiative_id, result.initiative_name, result.site_id, result.site_name, result.site_role, result.scan_status, result.scan_status_label))
                prefs.setSetupState(SetupState.COMPLETE)
                _state.update { it.copy(submitting = false, wizardOpen = false) }
                sync.run(result.initiative_id, result.initiative_name)
            } catch (e: Exception) {
                if (prefs.setupState.first() != SetupState.COMPLETE) prefs.setSetupState(SetupState.FAILED)
                _state.update { it.copy(submitting = false, submitError = (e as? ApiError)?.code ?: "unknown_error") }
            }
        }
    }

    fun resync() { selection.value?.let { sync.run(it.initiativeId, it.initiativeName) } }
}
```

`KioskSetupScreen.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

@Composable
fun KioskSetupScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val vm = kioskViewModel { KioskSetupViewModel(container.api, container.prefs, container.identity, container.sync, container.scope) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val selection by vm.selection.collectAsStateWithLifecycle()
    val setupState by vm.setupState.collectAsStateWithLifecycle()
    val sync by container.sync.status.collectAsStateWithLifecycle()

    Column {
        PageHeader("Kiosk · Setup", "Kiosk setup")
        val sel = selection
        if (!ui.wizardOpen && sel != null) {
            Text(buildString { append("This kiosk is set up for "); append(sel.initiativeName); append(" at "); append(sel.siteName); append(" ("); append(sel.siteRole); append(") · scan type "); append(sel.scanLabel) },
                style = MaterialTheme.typography.bodyLarge)
            Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                when (sync.phase) {
                    SyncPhase.IDLE -> { Text("No move data on this kiosk yet."); MiniButton("Sync now", { vm.resync() }) }
                    SyncPhase.RUNNING -> Text("Downloading move data…")
                    SyncPhase.DONE -> {
                        Text("Local data: ${sync.assets ?: 0} assets · ${sync.people ?: 0} people · ${sync.containers ?: 0} containers · ${sync.trucks ?: 0} trucks" + (sync.syncedAt?.let { " · synced ${Sync.formatSyncedAt(it)}" } ?: ""), modifier = Modifier.weight(1f))
                        MiniButton("Sync again", { vm.resync() })
                    }
                    SyncPhase.ERROR -> { KioskToast("Couldn't download move data (${sync.error ?: "unknown_error"}).", error = true); MiniButton("Try again", { vm.resync() }) }
                }
            }
            Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MiniButton("Change setup", { vm.openWizard(true) })
                SolidButton("Go to home", { nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } } })
            }
            return@Column
        }
        Text(when (ui.step) { 1 -> "STEP 1 OF 3 · MOVE"; 2 -> "STEP 2 OF 3 · SITE"; else -> "STEP 3 OF 3 · SCAN TYPE" }, fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.textMute)
        if (ui.loadError) { KioskToast("Couldn't load setup options.", error = true); MiniButton("Retry", { vm.load() }); return@Column }
        val opts = ui.options
        if (opts == null) { Text("Loading moves…", color = c.textMute); return@Column }
        when (ui.step) {
            1 -> {
                Text("Which move?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
                for (i in opts.initiatives) SetupCard(selected = i.id == ui.initiativeId, onClick = { vm.selectMove(i.id) }, modifier = Modifier.padding(bottom = 10.dp)) {
                    Text(i.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    KioskChip(i.status_label, if (i.status == "in_progress") ChipTone.GREEN else ChipTone.SLATE, dot = false)
                    i.client_name?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute) }
                    formatMoveDates(i)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.textMute) }
                    Text("${i.source_site?.name ?: "—"} → ${i.destination_site?.name ?: "—"}", style = MaterialTheme.typography.bodySmall, color = c.textMute)
                }
                if (opts.initiatives.isEmpty()) Text("No active moves. Ask a coordinator to plan one.", color = c.textMute)
                if (sel != null && setupState.isComplete) MiniButton("Cancel", { vm.cancelWizard() })
            }
            2 -> {
                Text("Which site is this kiosk at?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
                val choices = vm.siteChoices()
                for ((site, role) in choices) SetupCard(selected = site.id == ui.siteId, onClick = { vm.selectSite(site.id) }, modifier = Modifier.padding(bottom = 10.dp)) {
                    Text(role.uppercase(), fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.textMute)
                    Text(site.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                }
                if (choices.isEmpty()) Text("This move has no sites yet. Ask a coordinator to add them.", color = c.textMute)
                MiniButton("Back", { vm.back() })
            }
            else -> {
                Text("Which scan type?", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
                for (s in opts.scan_types) {
                    val saving = ui.submitting && ui.scanStatus == s.key
                    SetupCard(selected = s.key == ui.scanStatus, enabled = !ui.submitting, onClick = { vm.finish(s.key) }, modifier = Modifier.padding(bottom = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            androidx.compose.foundation.layout.Box(Modifier.size(14.dp).background(parseCssColor(s.color), CircleShape))
                            Text(if (saving) "Saving…" else s.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
                ui.submitError?.let { KioskToast("Couldn't save the kiosk setup ($it). Try again.", error = true) }
                MiniButton("Back", { vm.back() }, enabled = !ui.submitting)
            }
        }
    }
}

/** "#abc" / "#aabbcc" → Color; anything else → slate. */
fun parseCssColor(css: String): Color {
    val v = css.trim().removePrefix("#")
    val hex = when (v.length) { 3 -> v.map { "$it$it" }.joinToString(""); 6 -> v; else -> return Color(0xFF8A97AA) }
    return runCatching { Color(0xFF000000L or hex.toLong(16)) }.getOrDefault(Color(0xFF8A97AA))
}
```

In `KioskApp.kt`: `composable(Routes.SETUP) { KioskGuard(nav) { KioskShell(nav) { KioskSetupScreen(nav) } } }`.

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.setup.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): Kiosk Setup wizard (move, site, scan type cards) with summary and sync status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 21: Settings (Appearance, Sound, Devices, This Kiosk, Admin, Developer)

**Files:**
- Create: `ui/screens/settings/SettingsScreen.kt`, `ui/screens/settings/ThisKioskPanel.kt`, `ui/screens/settings/AppearancePanel.kt`, `ui/screens/settings/SoundPanel.kt`, `ui/screens/settings/DevicesPanel.kt`, `ui/screens/settings/AdminPanel.kt`, `ui/screens/settings/DeveloperPanel.kt`
- Modify: `ui/KioskApp.kt` (SETTINGS route → `SettingsScreen(nav, entry.arguments?.getString("tab"))`)
- Test: `ui/screens/settings/SettingsScreenTest.kt`

**Interfaces:**
- Produces: `@Composable fun SettingsScreen(nav, requestedTab: String?)` and one composable per panel, each taking what it needs from `LocalAppContainer`.

- [ ] **Step 1: Test first**

```kotlin
package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertDoesNotExist
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun signedOutShowsOnlyThisKioskAndSavesName() {
        val c = testContainer()
        runBlocking { c.identity.get() }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { SettingsScreen(rememberNavController(), null) } } }
        compose.onAllNodesWithText("This Kiosk").assertCountEquals(2)   // the tab and the panel heading
        compose.onNodeWithText("Appearance").assertDoesNotExist()
        compose.onNodeWithTag("kiosk-name").performTextClearance()
        compose.onNodeWithTag("kiosk-name").performTextInput("Dock 4")
        compose.onNodeWithText("Save name").performClick()
        compose.waitForIdle()
        assertEquals("Dock 4", runBlocking { c.prefs.name.first() })
    }

    @Test fun adminSeesAdminTabDeveloperSeesDeveloper() {
        val c = testContainer()
        c.auth.completePair(fakeSession(roles = listOf("developer"), maxRank = 100))
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { SettingsScreen(rememberNavController(), "developer") } } }
        compose.onNodeWithText("Admin").assertIsDisplayed()
        compose.onNodeWithText("Developer mode").assertIsDisplayed()
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`SettingsScreen.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.settings.DEFAULT_TAB
import com.serversherpa.kiosk.core.settings.SettingsTabId
import com.serversherpa.kiosk.core.settings.visibleTabs
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** kiosk/src/pages/Settings.tsx: a tab strip and one panel. */
@Composable
fun SettingsScreen(nav: NavHostController, requestedTab: String?) {
    val container = LocalAppContainer.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val authed = auth as? AuthState.Authed
    val tabs = visibleTabs(isAdmin = authed?.isAdmin == true, isDeveloper = authed?.isDeveloper == true, signedIn = authed != null)
    var selected by remember(requestedTab, tabs.size) {
        mutableStateOf((SettingsTabId.fromWire(requestedTab)?.takeIf { id -> tabs.any { it.id == id } } ?: tabs.firstOrNull { it.id == DEFAULT_TAB }?.id ?: tabs.first().id))
    }
    val active = tabs.first { it.id == selected }
    Column {
        PageHeader("Kiosk · Settings", "Settings")
        Segmented(tabs.map { it.id.wire to it.label }, selected.wire) { w -> SettingsTabId.fromWire(w)?.let { selected = it } }
        Text(active.label, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 16.dp))
        Text(active.blurb, style = MaterialTheme.typography.bodyMedium, color = LocalKioskColors.current.textMute, modifier = Modifier.padding(bottom = 8.dp))
        when (active.id) {
            SettingsTabId.THIS_KIOSK -> ThisKioskPanel()
            SettingsTabId.APPEARANCE -> AppearancePanel()
            SettingsTabId.SOUND -> SoundPanel()
            SettingsTabId.DEVICES -> DevicesPanel()
            SettingsTabId.ADMIN -> AdminPanel()
            SettingsTabId.DEVELOPER -> DeveloperPanel()
        }
    }
}
```

`ThisKioskPanel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.identity.KioskIdentity
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
import kotlinx.coroutines.launch

/** Name, serial, mode, API/portal URLs, version — usable signed out. */
@Composable
fun ThisKioskPanel() {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()
    val identity by container.identity.identity.collectAsStateWithLifecycle(initialValue = KioskIdentity("", ""))
    val apiUrl by container.config.apiUrl.collectAsStateWithLifecycle(initialValue = "")
    val portalUrl by container.config.portalUrl.collectAsStateWithLifecycle(initialValue = "")
    val auth by container.auth.state.collectAsStateWithLifecycle()
    var name by remember { mutableStateOf("") }
    var api by remember { mutableStateOf("") }
    var portal by remember { mutableStateOf("") }
    var nameError by remember { mutableStateOf<String?>(null) }
    var urlError by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(identity.name) { name = identity.name }
    LaunchedEffect(apiUrl) { api = apiUrl }
    LaunchedEffect(portalUrl) { portal = portalUrl }

    Column {
        SettingsRow("Kiosk name", "What people see on their phone when they link with this kiosk. 1–80 characters.") {
            OutlinedTextField(name, { name = it; nameError = null }, singleLine = true, isError = nameError != null, modifier = Modifier.fillMaxWidth().testTag("kiosk-name"))
            KioskToast(nameError, error = true)
            MiniButton("Save name", onClick = {
                scope.launch {
                    if (container.identity.setName(name)) { saved = "Name saved."; nameError = null; if (auth is AuthState.Authed) container.heartbeat.now() }
                    else nameError = "Enter a name between 1 and 80 characters."
                }
            }, modifier = Modifier.padding(top = 8.dp))
        }
        SettingsRow("Serial", "Generated once for this install; the portal's Kiosk Devices page lists it.") { Text(identity.serial, fontFamily = FragmentMono) }
        SettingsRow("Mode") { Text("Android", fontFamily = FragmentMono) }
        SettingsRow("API URL", "Where this kiosk talks to the portal. Must start with http:// or https://.") {
            OutlinedTextField(api, { api = it; urlError = null }, singleLine = true, isError = urlError != null, modifier = Modifier.fillMaxWidth().testTag("api-url"))
            OutlinedTextField(portal, { portal = it; urlError = null }, singleLine = true, label = { Text("Portal URL") }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            KioskToast(urlError, error = true)
            Row(Modifier.padding(top = 8.dp)) {
                MiniButton("Save URLs", onClick = {
                    val a = KioskConfig.normalizeUrl(api); val p = KioskConfig.normalizeUrl(portal)
                    if (a == null || p == null) { urlError = "Enter full http:// or https:// origins." }
                    else scope.launch { container.prefs.setApiUrl(a); container.prefs.setPortalUrl(p); saved = "URLs saved. Sign in again if the API changed." }
                })
            }
        }
        SettingsRow("Version") { Text(container.config.kioskVersion, fontFamily = FragmentMono) }
        KioskToast(saved)
    }
}
```

`AppearancePanel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.settings.Appearance
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.FLASH_MS_MAX
import com.serversherpa.kiosk.core.settings.FLASH_MS_MIN
import com.serversherpa.kiosk.core.settings.FLASH_MS_STEP
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.ui.components.HslPicker
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
import kotlinx.coroutines.launch

@Composable
fun AppearancePanel() {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()
    val a by container.prefs.appearance.collectAsStateWithLifecycle(initialValue = DEFAULT_APPEARANCE)
    fun save(next: Appearance) { scope.launch { container.prefs.setAppearance(next) } }
    Column {
        SettingsRow("Good scan flash", "The color the whole screen flashes when a scan matches this kiosk's local move data. Stored on this kiosk only.") {
            HslPicker("Good scan flash", a.goodScan, { save(a.copy(goodScan = it)) }) { container.flash.flash(hslToArgb(a.goodScan), a.flashMs) }
        }
        SettingsRow("Not-found scan flash", "The color the whole screen flashes when a scan matches nothing. Stored on this kiosk only.") {
            HslPicker("Not-found scan flash", a.notFoundScan, { save(a.copy(notFoundScan = it)) }) { container.flash.flash(hslToArgb(a.notFoundScan), a.flashMs) }
        }
        SettingsRow("Duplicate scan flash", "Shown when a scan changes nothing — an asset already in this container, or a container already on this truck.") {
            HslPicker("Duplicate scan flash", a.duplicateScan, { save(a.copy(duplicateScan = it)) }) { container.flash.flash(hslToArgb(a.duplicateScan), a.flashMs) }
        }
        SettingsRow("Flash duration", "How long the screen flashes after a scan.") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Slider(a.flashMs.toFloat(), { save(a.copy(flashMs = (Math.round(it / FLASH_MS_STEP) * FLASH_MS_STEP))) }, valueRange = FLASH_MS_MIN.toFloat()..FLASH_MS_MAX.toFloat(), modifier = Modifier.weight(1f))
                Text("${a.flashMs} ms", fontFamily = FragmentMono)
            }
        }
    }
}
```

`SoundPanel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.settings.BuiltinSound
import com.serversherpa.kiosk.core.settings.DEFAULT_SOUND_SETTINGS
import com.serversherpa.kiosk.core.settings.SoundChoice
import com.serversherpa.kiosk.core.settings.SoundSettings
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
import kotlinx.coroutines.launch

private val OPTIONS = listOf("none" to "None") + BuiltinSound.entries.map { it.wire to it.label }
private fun SoundChoice.wire() = when (this) { SoundChoice.None -> "none"; is SoundChoice.Builtin -> id.wire }
private fun choiceOf(wire: String): SoundChoice = BuiltinSound.fromWire(wire)?.let { SoundChoice.Builtin(it) } ?: SoundChoice.None

@Composable
fun SoundPanel() {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()
    val s by container.prefs.sound.collectAsStateWithLifecycle(initialValue = DEFAULT_SOUND_SETTINGS)
    fun save(next: SoundSettings) { scope.launch { container.prefs.setSound(next) } }
    @Composable fun row(label: String, hint: String, value: SoundChoice, set: (SoundChoice) -> Unit) {
        SettingsRow(label, hint) {
            Column {
                Segmented(OPTIONS, value.wire()) { set(choiceOf(it)) }
                MiniButton("Play", { container.sound.preview(value) }, modifier = Modifier.padding(top = 8.dp))
            }
        }
    }
    Column {
        row("Good scan", "Played when a scan matches.", s.good) { save(s.copy(good = it)) }
        row("Not-found scan", "Played when a scan matches nothing.", s.notFound) { save(s.copy(notFound = it)) }
        row("Duplicate scan", "Played when a scan changes nothing.", s.duplicate) { save(s.copy(duplicate = it)) }
        SettingsRow("Volume") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Slider(s.volume.toFloat(), { save(s.copy(volume = it.toDouble())) }, valueRange = 0f..1f, modifier = Modifier.weight(1f))
                Text("${Math.round(s.volume * 100)}%", fontFamily = FragmentMono)
            }
        }
    }
}
```

`DevicesPanel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.settings

import android.content.res.Configuration
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.ui.components.SettingsRow

/** Read-only: which scan inputs this device has. */
@Composable
fun DevicesPanel() {
    val container = LocalAppContainer.current
    val config = LocalConfiguration.current
    val hardKeyboard = config.keyboard != Configuration.KEYBOARD_NOKEYS
    Column {
        SettingsRow("Zebra DataWedge", "Scans from the built-in scan engine arrive through DataWedge as intents.") { Text(if (container.hasDataWedge) "Present — profile ServerSherpaKiosk" else "Not installed on this device") }
        SettingsRow("Camera", "Barcode scanning with the camera, single or multi read.") { Text(if (container.hasCamera) "Available" else "No camera on this device") }
        SettingsRow("Hardware keyboard / HID scanner", "A Bluetooth or USB scanner types into the focused box like a keyboard.") { Text(if (hardKeyboard) "A hardware keyboard is attached" else "None attached right now") }
    }
}
```

`AdminPanel.kt`:

```kotlin
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
```

`DeveloperPanel.kt`:

```kotlin
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
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.PersonEntity
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.Segmented
import com.serversherpa.kiosk.ui.components.SettingsRow
import com.serversherpa.kiosk.ui.theme.FragmentMono
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
```

In `KioskApp.kt`, the SETTINGS route body becomes `KioskShell(nav) { SettingsScreen(nav, entry.arguments?.getString("tab")) }`.

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.settings.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): Settings with Appearance, Sound, Devices, This Kiosk, Admin, and Developer tabs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 22: Scanning screen

**Files:**
- Create: `ui/screens/scan/ScanViewModel.kt`, `ui/screens/scan/ScanScreen.kt`, `ui/screens/scan/ScanTools.kt`
- Modify: `ui/KioskApp.kt` (SCAN → `ScanScreen(nav)`)
- Test: `ui/screens/scan/ScanViewModelTest.kt`

**Interfaces:**
- Produces: `class ScanViewModel(db, sync, outbox, prefs, scanBus, flash, sound, scope)` with `state: StateFlow<ScanUi>` (`loadStatus: LoadStatus`, `rosterSize: Int`, `value: String`, `confirmDiscard: Boolean`), `outbox: StateFlow<OutboxSnapshot>`, `fun setValue`, `fun onScan(value: String)`, `fun retryFailed()`, `fun clearSent()`, `fun askDiscard()`, `fun discardFailed()`, `fun cancelDiscard()`; `enum class LoadStatus { LOADING, READY, ERROR }`; `@Composable fun ScanScreen(nav)`; `@Composable fun ScanTools(onCamera, showCamera, showTrigger, onTrigger)` (the camera + DataWedge soft-trigger buttons, reused by Enroll and Timeclock); `fun scanTime(iso): String` ("14:02:07").

- [ ] **Step 1: Test first**

```kotlin
package com.serversherpa.kiosk.ui.screens.scan

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.outbox.MemoryOutboxStore
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.input.ScanBus
import com.serversherpa.kiosk.input.ScanEvent
import com.serversherpa.kiosk.input.ScanSource
import com.serversherpa.kiosk.ui.flash.FlashController
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScanViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun matchedScanQueuesAndFlashesUnmatchedIsNoMatch() = runTest {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(KioskAssetRow("a1", "A-1", "Rack", rfid = "000000000000000000100348", serial_number = "SN1", make_model = "Dell").toEntity()))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "sc.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val api = FakeKioskApi()
        val outbox = Outbox(MemoryOutboxStore(), api, Identity(prefs), backgroundScope, clock = { testScheduler.currentTime })
        val bus = ScanBus(); val flash = FlashController(backgroundScope)
        val vm = ScanViewModel(db, Sync(api, db, backgroundScope), outbox, prefs, bus, flash, sound = null, scope = backgroundScope)
        advanceUntilIdle()
        assertEquals(LoadStatus.READY, vm.state.value.loadStatus); assertEquals(1, vm.state.value.rosterSize)
        vm.onScan("100348"); advanceUntilIdle()
        val row = outbox.snapshot.value.rows[0]
        assertEquals(OutboxStatus.QUEUED, row.status); assertEquals("rfid", row.scanType); assertEquals("a1", row.asset?.id); assertEquals("s1", row.siteId)
        assertNotNull(flash.state.value)
        bus.publish(ScanEvent("zzz", ScanSource.DATAWEDGE)); advanceUntilIdle()
        assertEquals(OutboxStatus.NOMATCH, outbox.snapshot.value.rows[0].status)
        assertEquals(2, outbox.snapshot.value.counts.total)
        db.close()
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`ScanViewModel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.scan

import androidx.lifecycle.ViewModel
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.outbox.EnqueueInput
import com.serversherpa.kiosk.core.scan.ScanIndex
import com.serversherpa.kiosk.core.scan.buildScanIndex
import com.serversherpa.kiosk.core.scan.matchScan
import com.serversherpa.kiosk.core.scan.scanTypeFor
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.outbox.OutboxSnapshot
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.input.ScanBus
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.sound.ScanSoundKind
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class LoadStatus { LOADING, READY, ERROR }

data class ScanUi(val loadStatus: LoadStatus = LoadStatus.LOADING, val rosterSize: Int = 0, val value: String = "", val confirmDiscard: Boolean = false)

fun scanTime(iso: String): String = try {
    DateTimeFormatter.ofPattern("HH:mm:ss").format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
} catch (e: Exception) { iso }

/** kiosk/src/pages/Scan.tsx: match locally, flash + sound, queue in the outbox. */
class ScanViewModel(
    private val db: KioskDatabase, private val sync: Sync, private val outbox: Outbox, private val prefs: KioskPrefs,
    private val bus: ScanBus, private val flash: FlashController, private val sound: SoundPlayer?, private val scope: CoroutineScope,
) : ViewModel() {
    private val _state = MutableStateFlow(ScanUi())
    val state: StateFlow<ScanUi> = _state
    val outboxSnapshot: StateFlow<OutboxSnapshot> = outbox.snapshot
    @Volatile private var index: ScanIndex<AssetEntity>? = null
    @Volatile private var setup: KioskSetupSelection? = null
    @Volatile private var appearance = DEFAULT_APPEARANCE

    init {
        scope.launch { prefs.setupSelection.collect { setup = it } }
        scope.launch { prefs.appearance.collect { appearance = it } }
        scope.launch { outbox.load() }
        scope.launch { load() }
        // Re-read when a sync finishes or local data was cleared (IDLE after DONE).
        scope.launch { sync.status.collect { if (it.phase == SyncPhase.DONE || it.phase == SyncPhase.IDLE) load() } }
        scope.launch { bus.events.collect { onScan(it.value) } }
    }

    private suspend fun load() {
        try {
            val assets = db.assets().all()
            index = buildScanIndex(assets)
            _state.update { it.copy(loadStatus = LoadStatus.READY, rosterSize = assets.size) }
        } catch (e: Exception) { _state.update { it.copy(loadStatus = LoadStatus.ERROR) } }
    }

    fun setValue(v: String) = _state.update { it.copy(value = v) }

    fun onScan(raw: String) {
        val value = raw.trim(); if (value.isEmpty()) return
        _state.update { it.copy(value = "") }
        val idx = index ?: return
        val sel = setup ?: return
        val hit = matchScan(idx, value)
        val a = appearance
        if (hit != null) { flash.flash(hslToArgb(a.goodScan), a.flashMs); sound?.play(ScanSoundKind.GOOD) }
        else { flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND) }
        scope.launch {
            outbox.enqueue(EnqueueInput(
                scannedValue = value, scanType = hit?.let { scanTypeFor(it.kind) } ?: "barcode",
                asset = hit?.asset?.toOutboxAsset(), siteId = sel.siteId, initiativeId = sel.initiativeId, scanStatus = sel.scanStatus,
            ))
        }
    }

    fun retryFailed() { scope.launch { outbox.retryFailed() } }
    fun clearSent() { scope.launch { outbox.clearSent() } }
    fun askDiscard() = _state.update { it.copy(confirmDiscard = true) }
    fun cancelDiscard() = _state.update { it.copy(confirmDiscard = false) }
    fun discardFailed() { _state.update { it.copy(confirmDiscard = false) }; scope.launch { outbox.discardFailed() } }
}
```

`ScanTools.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.components.MiniButton

/** The camera button (devices with a camera) and the DataWedge soft trigger (Zebra). */
@Composable
fun ScanTools(showCamera: Boolean, onCamera: () -> Unit, showTrigger: Boolean, onTrigger: () -> Unit) {
    if (!showCamera && !showTrigger) return
    Row(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (showCamera) MiniButton("Camera", onCamera)
        if (showTrigger) MiniButton("Scan", onTrigger)
    }
}
```

`ScanScreen.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.input.camera.CameraScanSheet
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.ScanInput
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

private fun tone(s: OutboxStatus) = when (s) {
    OutboxStatus.ACCEPTED -> ChipTone.GREEN
    OutboxStatus.QUEUED, OutboxStatus.SENDING, OutboxStatus.RETRYING -> ChipTone.AMBER
    OutboxStatus.FAILED, OutboxStatus.NOMATCH -> ChipTone.RED
}

@Composable
fun ScanScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val vm = kioskViewModel { ScanViewModel(container.db, container.sync, container.outbox, container.prefs, container.scanBus, container.flash, container.sound, container.scope) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val snapshot by vm.outboxSnapshot.collectAsStateWithLifecycle()
    val setup by container.prefs.setupSelection.collectAsStateWithLifecycle(initialValue = null)
    var camera by remember { mutableStateOf(false) }
    val empty = ui.loadStatus == LoadStatus.READY && ui.rosterSize == 0
    val disabled = ui.loadStatus != LoadStatus.READY || empty || setup == null

    if (camera) { CameraScanSheet(onScan = { container.scanBus.publish(it) }, onDismiss = { camera = false }); return }

    Column {
        PageHeader("Kiosk · Scanning", "Scanning", setup?.let { "${it.initiativeName} · ${it.siteName} · ${it.scanLabel}" } ?: "Finish Kiosk Setup first.")
        if (ui.loadStatus == LoadStatus.ERROR) KioskToast("Couldn't read this kiosk's local data.", error = true)
        if (empty) Text("No move data on this kiosk. Sync from Kiosk Setup.", color = c.textMute)
        ScanInput(ui.value, vm::setValue, onSubmit = { vm.onScan(it) }, placeholder = "Scan or type an asset ID, serial, or tag", enabled = !disabled, keepFocus = !camera)
        ScanTools(showCamera = container.hasCamera, onCamera = { camera = true }, showTrigger = container.hasDataWedge, onTrigger = { DataWedge.softScan(context, true) })
        val counts = snapshot.counts
        Text("Queued ${counts.queued} · Sent ${counts.accepted} · Failed ${counts.failed} · No match ${counts.nomatch}", fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute, modifier = Modifier.padding(top = 8.dp))
        Row(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MiniButton("Retry failed", { vm.retryFailed() }, enabled = counts.failed > 0)
            MiniButton("Clear sent", { vm.clearSent() }, enabled = counts.accepted + counts.nomatch > 0)
            MiniButton("Discard failed", { vm.askDiscard() }, enabled = counts.failed > 0)
        }
        if (ui.confirmDiscard) AlertDialog(
            onDismissRequest = { vm.cancelDiscard() },
            title = { Text("Discard failed scans?") },
            text = { Text("These scans never reached the portal. Discarding them throws them away for good.") },
            confirmButton = { TextButton({ vm.discardFailed() }) { Text("Discard") } },
            dismissButton = { TextButton({ vm.cancelDiscard() }) { Text("Keep") } },
        )
        HorizontalDivider(color = c.paperLine)
        for (row in snapshot.rows) ScanRow(row)
    }
}

@Composable
private fun ScanRow(row: OutboxRow) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(scanTime(row.scannedAt), fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute)
            Text(if (row.scanType == "rfid") displayRfid(row.scannedValue) else row.scannedValue, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
            KioskChip(row.status.wire, tone(row.status), dot = false)
        }
        val a = row.asset
        Text(if (a == null) "No match" else listOfNotNull(a.assetId.takeIf { it.isNotBlank() }, a.name, a.makeModel.takeIf { it.isNotBlank() }).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall, color = if (a == null) ChipTone.RED.text else c.textDark)
        row.lastError?.let { if (row.status == OutboxStatus.FAILED) Text(it, fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = ChipTone.RED.text) }
    }
    HorizontalDivider(color = c.paperLine)
}
```

In `KioskApp.kt`: `gated(nav, Routes.SCAN, FeatureId.SCAN) { ScanScreen(nav) }`.

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.scan.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): Scanning screen — local match, flash/sound, outbox receipt list, camera and DataWedge tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 23: RFID Enroll screen

**Files:**
- Create: `ui/screens/enroll/EnrollViewModel.kt`, `ui/screens/enroll/EnrollScreen.kt`
- Modify: `ui/KioskApp.kt` (ENROLL → `EnrollScreen(nav)`)
- Test: `ui/screens/enroll/EnrollViewModelTest.kt`

**Interfaces:**
- Produces: `data class EnrollmentRow(id, name, serial: String?, rfid, replaced: Boolean, at: String)`; `data class EnrollUi(loadStatus, rosterSize, asset: AssetEntity?, value, tagValue, saving, error: String?, toast: String?, enrollments: List<EnrollmentRow>)`; `class EnrollViewModel(db, sync, api, prefs, identity, scanBus, flash, sound, scope, clock, idGen)` with `state`, `fun setValue`, `fun setTagValue`, `fun submitAsset(raw)`, `fun submitTag(raw)`, `fun cancel()`, `fun onScan(value)` (routes to the current step); `fun saveErrorText(e: Throwable): String`; `@Composable fun EnrollScreen(nav)`.

- [ ] **Step 1: Test first**

```kotlin
package com.serversherpa.kiosk.ui.screens.enroll

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskRfidEnroll
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.input.ScanBus
import com.serversherpa.kiosk.ui.flash.FlashController
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EnrollViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    private suspend fun kotlinx.coroutines.test.TestScope.build(api: FakeKioskApi): Pair<EnrollViewModel, KioskDatabase> {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.assets().insertAll(listOf(
            KioskAssetRow("a1", "A-1", "Rack", rfid = null, serial_number = "SN1", make_model = "Dell").toEntity(),
            KioskAssetRow("a2", "A-2", "Tagged", rfid = "000000000000000000100348", serial_number = "SN2", make_model = "HP").toEntity(),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "en.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val vm = EnrollViewModel(db, Sync(api, db, backgroundScope), api, prefs, Identity(prefs), ScanBus(), FlashController(backgroundScope), null, backgroundScope, clock = { 0L }, idGen = { "c1" })
        advanceUntilIdle()
        return vm to db
    }

    @Test fun stepOneMatchesAssetOrSerialOnlyAndRefusesTags() = runTest {
        val (vm, _) = build(FakeKioskApi())
        vm.onScan("100348")
        assertNull(vm.state.value.asset)
        assertEquals("That's an RFID tag. Scan the asset's serial or ID first.", vm.state.value.error)
        vm.onScan("nope"); assertEquals("No asset found for \"nope\".", vm.state.value.error)
        vm.onScan("sn1"); assertEquals("a1", vm.state.value.asset?.id)
    }

    @Test fun stepTwoPadsSavesAndUpdatesLocalRoster() = runTest {
        val api = FakeKioskApi()
        val (vm, db) = build(api)
        vm.onScan("A-1"); vm.setTagValue("10 03 49")
        vm.submitTag("10 03 49"); advanceUntilIdle()
        assertNull(vm.state.value.asset)                          // back to step one
        assertEquals("Enrolled Rack → 100349", vm.state.value.toast)
        assertEquals("000000000000000000100349", db.assets().all().first { it.id == "a1" }.rfid)
        assertEquals(1, vm.state.value.enrollments.size)
        assertEquals(false, vm.state.value.enrollments[0].replaced)
    }

    @Test fun errorsMapToCopy() = runTest {
        val api = FakeKioskApi().apply { rfidResult = { _, _ -> throw ApiError(409, "rfid_in_use", buildJsonObject { put("code", "rfid_in_use"); put("asset_name", "Other rack") }) } }
        val (vm, _) = build(api)
        vm.onScan("A-1"); vm.submitTag("100349"); advanceUntilIdle()
        assertEquals("That tag is already on Other rack.", vm.state.value.error)
        assertEquals("a1", vm.state.value.asset?.id)   // stays on step two
        vm.submitTag("bad-tag"); assertEquals("That tag has characters we can't store — letters and numbers only.", vm.state.value.error)
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`EnrollViewModel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.enroll

import androidx.lifecycle.ViewModel
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskRfidEnrollIn
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.scan.ScanIndex
import com.serversherpa.kiosk.core.scan.ScanMatchKind
import com.serversherpa.kiosk.core.scan.buildScanIndex
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.core.scan.matchAssetOrSerial
import com.serversherpa.kiosk.core.scan.matchScan
import com.serversherpa.kiosk.core.scan.padRfid
import com.serversherpa.kiosk.core.scan.RfidProblem
import com.serversherpa.kiosk.core.scan.rfidProblemText
import com.serversherpa.kiosk.core.settings.CheckpointId
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.input.ScanBus
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.sound.ScanSoundKind
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

const val MAX_ENROLLMENTS = 25
private const val TOAST_MS = 5_000L
private const val ERROR_MS = 4_000L

data class EnrollmentRow(val id: String, val name: String, val serial: String?, val rfid: String, val replaced: Boolean, val at: String)

data class EnrollUi(
    val loadStatus: LoadStatus = LoadStatus.LOADING, val rosterSize: Int = 0,
    val asset: AssetEntity? = null, val value: String = "", val tagValue: String = "",
    val saving: Boolean = false, val error: String? = null, val toast: String? = null,
    val enrollments: List<EnrollmentRow> = emptyList(),
)

fun saveErrorText(e: Throwable): String {
    val err = e as? ApiError
    return when {
        err?.code == "rfid_in_use" -> "That tag is already on ${err.detailString("asset_name") ?: "another asset"}."
        err?.code == "bad_rfid" -> rfidProblemText(RfidProblem.NOT_ALPHANUMERIC)
        err?.code == "rfid_too_long" -> rfidProblemText(RfidProblem.TOO_LONG)
        err?.code == "read_only_mode" || err?.status == 423 -> "The portal is in read-only mode. Try again shortly."
        err?.code == "network" -> "Can't reach the portal. The tag was not saved."
        else -> "Couldn't save the tag (${err?.code ?: "unknown_error"})."
    }
}

/** kiosk/src/pages/Enroll.tsx: asset (ID/serial only) → tag (padded), online only. */
class EnrollViewModel(
    private val db: KioskDatabase, private val sync: Sync, private val api: KioskApi, private val prefs: KioskPrefs,
    private val identity: Identity, private val bus: ScanBus, private val flash: FlashController, private val sound: SoundPlayer?,
    private val scope: CoroutineScope, private val clock: () -> Long = System::currentTimeMillis,
    private val idGen: () -> String = { UUID.randomUUID().toString() },
) : ViewModel() {
    private val _state = MutableStateFlow(EnrollUi())
    val state: StateFlow<EnrollUi> = _state
    @Volatile private var index: ScanIndex<AssetEntity>? = null
    @Volatile private var setup: KioskSetupSelection? = null
    @Volatile private var appearance = DEFAULT_APPEARANCE
    @Volatile private var checkpoint = CheckpointId.ENROLL.fallback
    private var errorJob: Job? = null
    private var toastJob: Job? = null

    init {
        scope.launch { prefs.setupSelection.collect { setup = it } }
        scope.launch { prefs.appearance.collect { appearance = it } }
        scope.launch { prefs.checkpoint(CheckpointId.ENROLL).collect { checkpoint = it } }
        scope.launch { load() }
        scope.launch { sync.status.collect { if (it.phase == SyncPhase.DONE || it.phase == SyncPhase.IDLE) load() } }
        scope.launch { bus.events.collect { onScan(it.value) } }
    }

    private suspend fun load() {
        try {
            val assets = db.assets().all()
            index = buildScanIndex(assets)
            _state.update { it.copy(loadStatus = LoadStatus.READY, rosterSize = assets.size) }
        } catch (e: Exception) { _state.update { it.copy(loadStatus = LoadStatus.ERROR) } }
    }

    fun setValue(v: String) = _state.update { it.copy(value = v) }
    fun setTagValue(v: String) = _state.update { it.copy(tagValue = v) }

    private fun showError(text: String, ms: Long = ERROR_MS) {
        errorJob?.cancel(); _state.update { it.copy(error = text) }
        errorJob = scope.launch { delay(ms); _state.update { it.copy(error = null) } }
    }

    private fun showToast(text: String) {
        toastJob?.cancel(); _state.update { it.copy(toast = text) }
        toastJob = scope.launch { delay(TOAST_MS); _state.update { it.copy(toast = null) } }
    }

    private fun flashBad() { val a = appearance; flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND) }
    private fun flashGood() { val a = appearance; flash.flash(hslToArgb(a.goodScan), a.flashMs); sound?.play(ScanSoundKind.GOOD) }

    fun onScan(value: String) { if (_state.value.asset == null) submitAsset(value) else submitTag(value) }

    fun submitAsset(raw: String) {
        val value = raw.trim()
        _state.update { it.copy(value = "") }
        val idx = index ?: return
        if (value.isEmpty() || _state.value.loadStatus != LoadStatus.READY || setup == null) return
        val hit = matchAssetOrSerial(idx, value)
        if (hit != null) { errorJob?.cancel(); _state.update { it.copy(asset = hit.asset, tagValue = "", error = null) }; flashGood(); return }
        flashBad()
        val asTag = matchScan(idx, value)
        showError(if (asTag?.kind == ScanMatchKind.RFID) "That's an RFID tag. Scan the asset's serial or ID first." else "No asset found for \"$value\".")
    }

    fun submitTag(raw: String) {
        val target = _state.value.asset ?: return
        if (_state.value.saving) return
        val (tag, problem) = padRfid(raw)
        if (problem != null) { _state.update { it.copy(tagValue = "") }; showError(rfidProblemText(problem)); return }
        _state.update { it.copy(saving = true, error = null) }
        scope.launch {
            try {
                val sel = setup
                val result = api.postRfidEnroll(target.id, KioskRfidEnrollIn(identity.get().serial, tag!!, checkpoint, idGen(), sel?.siteId, sel?.initiativeId))
                flashGood()
                try { db.assets().updateRfid(target.id, result.rfid_tag) } catch (e: Exception) { showError("The tag was saved to the portal, but this kiosk's copy is stale.") }
                load()
                val name = result.asset_name ?: target.name ?: target.assetId
                showToast("Enrolled $name → ${displayRfid(result.rfid_tag)}")
                _state.update {
                    it.copy(asset = null, value = "", tagValue = "", saving = false,
                        enrollments = (listOf(EnrollmentRow(idGen(), name, result.serial_number ?: target.serialNumber, result.rfid_tag, replaced = !target.rfid.isNullOrEmpty() && !result.already_had_tag, at = Instant.ofEpochMilli(clock()).toString())) + it.enrollments).take(MAX_ENROLLMENTS))
                }
            } catch (e: Exception) {
                flashBad()
                _state.update { it.copy(saving = false, tagValue = "") }
                showError(saveErrorText(e))
            }
        }
    }

    fun cancel() { errorJob?.cancel(); _state.update { it.copy(asset = null, value = "", tagValue = "", saving = false, error = null) } }
}
```

`EnrollScreen.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.enroll

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.core.scan.padRfid
import com.serversherpa.kiosk.input.camera.CameraScanSheet
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.ScanInput
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.screens.scan.ScanTools
import com.serversherpa.kiosk.ui.screens.scan.scanTime
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

@Composable
fun EnrollScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val vm = kioskViewModel { EnrollViewModel(container.db, container.sync, container.api, container.prefs, container.identity, container.scanBus, container.flash, container.sound, container.scope) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val setup by container.prefs.setupSelection.collectAsStateWithLifecycle(initialValue = null)
    var camera by remember { mutableStateOf(false) }
    val empty = ui.loadStatus == LoadStatus.READY && ui.rosterSize == 0
    val disabled = ui.loadStatus != LoadStatus.READY || empty || setup == null

    if (camera) { CameraScanSheet(onScan = { container.scanBus.publish(it) }, onDismiss = { camera = false }); return }

    Column {
        PageHeader("Kiosk · RFID Enroll", "RFID Enroll", setup?.let { "${it.initiativeName} · ${it.siteName}" } ?: "Finish Kiosk Setup first.")
        if (ui.loadStatus == LoadStatus.ERROR) KioskToast("Couldn't read this kiosk's local data.", error = true)
        if (empty) Text("No move data on this kiosk. Sync it from Kiosk Setup.", color = c.textMute)
        KioskToast(ui.toast)
        val asset = ui.asset
        if (asset != null) {
            SetupCard(selected = true, onClick = {}) {
                Text(asset.name ?: "Unnamed asset", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Fact("Asset ID", asset.assetId.ifBlank { "—" }); Fact("Serial", asset.serialNumber ?: "—"); Fact("Make / Model", asset.makeModel.ifBlank { "—" })
                asset.rfid?.let { Fact("Current tag", displayRfid(it)); Text("This asset already has a tag — scanning a new one replaces it.", style = MaterialTheme.typography.bodySmall, color = c.textMute) }
            }
            ScanInput(ui.tagValue, vm::setTagValue, onSubmit = { vm.submitTag(it) }, placeholder = "Scan the RFID tag", enabled = !ui.saving, keepFocus = !camera, modifier = Modifier.padding(top = 12.dp))
            val preview = padRfid(ui.tagValue).tag
            if (preview != null) Row { Text("Will be stored as ", style = MaterialTheme.typography.bodySmall, color = c.textMute); Text(preview, fontFamily = FragmentMono, style = MaterialTheme.typography.bodySmall) }
            else Text("24 characters, zero-padded.", style = MaterialTheme.typography.bodySmall, color = c.textMute)
            ScanTools(container.hasCamera, { camera = true }, container.hasDataWedge) { DataWedge.softScan(context, true) }
            KioskToast(ui.error, error = true)
            MiniButton("Cancel", { vm.cancel() })
        } else {
            ScanInput(ui.value, vm::setValue, onSubmit = { vm.submitAsset(it) }, placeholder = "Scan a serial or asset ID", enabled = !disabled, keepFocus = !camera)
            ScanTools(container.hasCamera, { camera = true }, container.hasDataWedge) { DataWedge.softScan(context, true) }
            KioskToast(ui.error, error = true)
        }
        if (ui.enrollments.isNotEmpty()) {
            Text("This session", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp, bottom = 6.dp))
            HorizontalDivider(color = c.paperLine)
            for (e in ui.enrollments) {
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Text(scanTime(e.at), fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute, modifier = Modifier.padding(end = 8.dp))
                    Text("${e.name}${e.serial?.let { " · $it" } ?: ""} → ${displayRfid(e.rfid)}${if (e.replaced) " (replaced)" else ""}", style = MaterialTheme.typography.bodySmall)
                }
                HorizontalDivider(color = c.paperLine)
            }
        }
    }
}

@Composable
private fun Fact(label: String, value: String) {
    Row(Modifier.padding(top = 4.dp)) {
        Text(label.uppercase(), fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = LocalKioskColors.current.textMute, modifier = Modifier.padding(end = 8.dp))
        Text(value, fontFamily = FragmentMono, style = MaterialTheme.typography.bodySmall)
    }
}
```

In `KioskApp.kt`: `gated(nav, Routes.ENROLL, FeatureId.ENROLL) { EnrollScreen(nav) }`.

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.enroll.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): RFID Enroll — asset by ID/serial, padded tag preview, online save with local roster update

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 24: Timeclock screen

**Files:**
- Create: `ui/screens/timeclock/TimeclockViewModel.kt`, `ui/screens/timeclock/TimeclockScreen.kt`
- Modify: `ui/KioskApp.kt` (TIMECLOCK → `TimeclockScreen(nav)`)
- Test: `ui/screens/timeclock/TimeclockViewModelTest.kt`

**Interfaces:**
- Produces: `data class TimeclockUi(loadStatus, rosterSize, value, results: List<PersonEntity>, selected: PersonEntity?, status: KioskTimeclockStatus?, statusPhase: LoadStatus, punching, error: String?, toast: String?, nowMs: Long)`; `class TimeclockViewModel(db, sync, api, prefs, identity, scanBus, flash, sound, scope, clock)` with `state`, `fun onChange(v)`, `fun onEnter(raw)`, `fun select(person)`, `fun punch()`, `fun toEntry()`, `fun bumpIdle()`, `fun onScan(value)`; helpers `formatMinutes(total: Int)`, `minutesSince(iso, nowMs)`, `clockTime(iso)`, `initialsOf(name)`, `punchErrorText(e)`; `const IDLE_MS = 20_000`, `MAX_RESULTS = 8`; `@Composable fun TimeclockScreen(nav)`.

- [ ] **Step 1: Test first**

```kotlin
package com.serversherpa.kiosk.ui.screens.timeclock

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.toEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.input.ScanBus
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TimeclockViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    private suspend fun kotlinx.coroutines.test.TestScope.build(api: FakeKioskApi): TimeclockViewModel {
        val db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        db.people().insertAll(listOf(
            KioskPersonRow("p1", "Jimmy Henderson", "James", "Henderson", "Jimmy", "000000000000000000100348", true, true).toEntity(),
            KioskPersonRow("p2", "Tina Timeclock", "Tina", "Timeclock", null, "1003", true, false).toEntity(),
        ))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(tmp.root, "tc.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        val vm = TimeclockViewModel(db, Sync(api, db, backgroundScope), api, prefs, Identity(prefs), ScanBus(), FlashController(backgroundScope), null, backgroundScope, clock = { testScheduler.currentTime })
        advanceUntilIdle()
        return vm
    }

    @Test fun badgeAutoSelectsButAmbiguousPrefixWaits() = runTest {
        val vm = build(FakeKioskApi())
        assertEquals(LoadStatus.READY, vm.state.value.loadStatus)
        vm.onChange("1003")
        assertNull(vm.state.value.selected)          // 1003 is also a prefix of 100348
        vm.onChange("100348"); advanceUntilIdle()
        assertEquals("p1", vm.state.value.selected?.id)
        assertEquals(LoadStatus.READY, vm.state.value.statusPhase)
    }

    @Test fun typedNameSearchesAndEnterSelectsSingleResult() = runTest {
        val vm = build(FakeKioskApi())
        vm.onChange("hen jim")
        assertEquals(listOf("p1"), vm.state.value.results.map { it.id })
        vm.onEnter("hen jim"); advanceUntilIdle()
        assertEquals("p1", vm.state.value.selected?.id)
        vm.toEntry(); vm.onEnter("nobody")
        assertEquals("No worker found for \"nobody\".", vm.state.value.error)
    }

    @Test fun punchClocksInWithSetupThenReturnsToEntryAndIdleResets() = runTest {
        val api = FakeKioskApi()
        val vm = build(api)
        vm.onChange("100348"); advanceUntilIdle()
        vm.punch(); advanceUntilIdle()
        assertEquals("clockIn", api.calls.last())
        assertEquals("Clocked in — Tina T", vm.state.value.toast)
        assertNull(vm.state.value.selected)
        vm.onChange("100348"); advanceUntilIdle()
        advanceTimeBy(IDLE_MS + 1); advanceUntilIdle()
        assertNull(vm.state.value.selected)
    }

    @Test fun punchErrorsMapAndRefreshStatus() = runTest {
        val api = FakeKioskApi().apply { clockInResult = { throw ApiError(409, "already_clocked_in") } }
        val vm = build(api)
        vm.onChange("100348"); advanceUntilIdle()
        vm.punch(); advanceUntilIdle()
        assertEquals("They are already clocked in. Refreshing…", vm.state.value.error)
        assertEquals(2, api.calls.count { it == "timeclockStatus" })
        assertEquals("3h 12m", formatMinutes(192)); assertEquals("45m", formatMinutes(45)); assertEquals("JH", initialsOf("Jimmy Henderson"))
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`TimeclockViewModel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.timeclock

import androidx.lifecycle.ViewModel
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.ClockInIn
import com.serversherpa.kiosk.core.model.ClockOutIn
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.model.KioskTimeclockStatus
import com.serversherpa.kiosk.core.people.PeopleIndex
import com.serversherpa.kiosk.core.people.buildPeopleIndex
import com.serversherpa.kiosk.core.people.isAmbiguousPrefix
import com.serversherpa.kiosk.core.people.matchPersonExact
import com.serversherpa.kiosk.core.people.searchPeople
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.hslToArgb
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.PersonEntity
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.input.ScanBus
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.sound.ScanSoundKind
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

const val MAX_RESULTS = 8
const val IDLE_MS = 20_000L
private const val TICK_MS = 30_000L
private const val TOAST_MS = 5_000L
private const val ERROR_MS = 3_000L

data class TimeclockUi(
    val loadStatus: LoadStatus = LoadStatus.LOADING, val rosterSize: Int = 0,
    val value: String = "", val results: List<PersonEntity> = emptyList(),
    val selected: PersonEntity? = null, val status: KioskTimeclockStatus? = null, val statusPhase: LoadStatus = LoadStatus.LOADING,
    val punching: Boolean = false, val error: String? = null, val toast: String? = null, val nowMs: Long = 0,
)

/** "3h 12m", or "45m" under the hour. */
fun formatMinutes(total: Int): String { val m = maxOf(0, total); val h = m / 60; return if (h > 0) "${h}h ${m % 60}m" else "${m}m" }
fun minutesSince(iso: String, nowMs: Long): Int = try { maxOf(0, ((nowMs - Instant.parse(iso).toEpochMilli()) / 60_000.0).roundToInt()) } catch (e: Exception) { 0 }
fun clockTime(iso: String): String = try { DateTimeFormatter.ofPattern("h:mm a").format(Instant.parse(iso).atZone(ZoneId.systemDefault())) } catch (e: Exception) { iso }
fun initialsOf(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return "?"
    return (words.first().take(1) + (if (words.size > 1) words.last().take(1) else "")).uppercase()
}

fun punchErrorText(e: Throwable): String {
    val err = e as? ApiError
    return when {
        err?.code == "already_clocked_in" -> "They are already clocked in. Refreshing…"
        err?.code == "not_clocked_in" -> "They are not clocked in. Refreshing…"
        err?.code == "read_only_mode" || err?.status == 423 -> "The portal is in read-only mode. Try again shortly."
        err?.code == "network" -> "Can't reach the portal. The punch was not recorded."
        else -> "Couldn't record the punch (${err?.code ?: "unknown_error"})."
    }
}

/** kiosk/src/pages/Timeclock.tsx: entry (badge/id/name) and selected (one button). No local history. */
class TimeclockViewModel(
    private val db: KioskDatabase, private val sync: Sync, private val api: KioskApi, private val prefs: KioskPrefs,
    private val identity: Identity, private val bus: ScanBus, private val flash: FlashController, private val sound: SoundPlayer?,
    private val scope: CoroutineScope, private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val _state = MutableStateFlow(TimeclockUi(nowMs = clock()))
    val state: StateFlow<TimeclockUi> = _state
    @Volatile private var index: PeopleIndex<PersonEntity>? = null
    @Volatile private var setup: KioskSetupSelection? = null
    @Volatile private var appearance = DEFAULT_APPEARANCE
    private var statusId = 0
    private var idleJob: Job? = null
    private var tickJob: Job? = null
    private var errorJob: Job? = null
    private var toastJob: Job? = null

    init {
        scope.launch { prefs.setupSelection.collect { setup = it } }
        scope.launch { prefs.appearance.collect { appearance = it } }
        scope.launch { load() }
        scope.launch { sync.status.collect { if (it.phase == SyncPhase.DONE || it.phase == SyncPhase.IDLE) load() } }
        scope.launch { bus.events.collect { onScan(it.value) } }
    }

    private suspend fun load() {
        try {
            val people = db.people().all()
            index = buildPeopleIndex(people)
            _state.update { it.copy(loadStatus = LoadStatus.READY, rosterSize = people.size) }
        } catch (e: Exception) { _state.update { it.copy(loadStatus = LoadStatus.ERROR) } }
    }

    private fun showError(text: String, ms: Long? = null) {
        errorJob?.cancel(); _state.update { it.copy(error = text) }
        if (ms != null) errorJob = scope.launch { delay(ms); _state.update { it.copy(error = null) } }
    }
    private fun showToast(text: String) {
        toastJob?.cancel(); _state.update { it.copy(toast = text) }
        toastJob = scope.launch { delay(TOAST_MS); _state.update { it.copy(toast = null) } }
    }
    private fun flashBad() { val a = appearance; flash.flash(hslToArgb(a.notFoundScan), a.flashMs); sound?.play(ScanSoundKind.NOT_FOUND) }
    private fun flashGood() { val a = appearance; flash.flash(hslToArgb(a.goodScan), a.flashMs); sound?.play(ScanSoundKind.GOOD) }

    fun toEntry() {
        statusId++; errorJob?.cancel(); idleJob?.cancel(); tickJob?.cancel()
        _state.update { it.copy(selected = null, status = null, statusPhase = LoadStatus.LOADING, punching = false, value = "", results = emptyList(), error = null) }
    }

    fun bumpIdle() {
        if (_state.value.selected == null) return
        idleJob?.cancel()
        idleJob = scope.launch { delay(IDLE_MS); toEntry() }
    }

    fun select(person: PersonEntity) {
        errorJob?.cancel()
        _state.update { it.copy(error = null, value = "", results = emptyList(), selected = person, status = null, statusPhase = LoadStatus.LOADING) }
        bumpIdle()
        tickJob?.cancel(); tickJob = scope.launch { while (true) { delay(TICK_MS); _state.update { it.copy(nowMs = clock()) } } }
        loadStatus(person.id)
    }

    private fun loadStatus(personId: String) {
        val mine = ++statusId
        _state.update { it.copy(statusPhase = LoadStatus.LOADING) }
        scope.launch {
            try {
                val next = api.timeclockStatus(personId)
                if (mine != statusId) return@launch
                _state.update { it.copy(status = next, statusPhase = LoadStatus.READY, nowMs = clock()) }
            } catch (e: Exception) {
                if (mine != statusId) return@launch
                _state.update { it.copy(statusPhase = LoadStatus.ERROR) }
                showError(if ((e as? ApiError)?.code == "network") "Can't reach the portal. Try again in a moment." else "Couldn't read their status (${(e as? ApiError)?.code ?: "unknown_error"}).")
            }
        }
    }

    /** Every keystroke: a complete badge selects at once unless it is also a prefix of a longer tag. */
    fun onChange(next: String) {
        val idx = index
        if (idx != null && isAmbiguousPrefix(idx, next)) { _state.update { it.copy(value = next, results = searchPeople(idx, next, MAX_RESULTS)) }; return }
        val hit = idx?.let { matchPersonExact(it, next) }
        if (hit != null) { select(hit); return }
        _state.update { it.copy(value = next, results = if (idx != null && next.isNotBlank()) searchPeople(idx, next, MAX_RESULTS) else emptyList()) }
    }

    fun onEnter(raw: String) {
        val value = raw.trim(); val idx = index ?: return
        if (value.isEmpty()) return
        matchPersonExact(idx, value)?.let { select(it); return }
        val rows = searchPeople(idx, value, MAX_RESULTS)
        if (rows.size == 1) { select(rows[0]); return }
        if (rows.size > 1) return
        flashBad(); _state.update { it.copy(value = "") }
        showError("No worker found for \"$value\".", ERROR_MS)
    }

    fun onScan(value: String) { if (_state.value.selected == null) { onChange(value); if (_state.value.selected == null) onEnter(value) } }

    fun punch() {
        val ui = _state.value
        val person = ui.selected ?: return
        val status = ui.status ?: return
        if (ui.punching) return
        val clockingOut = status.clocked_in
        errorJob?.cancel(); _state.update { it.copy(punching = true, error = null) }
        scope.launch {
            try {
                val serial = identity.get().serial
                val sel = setup
                val next = if (clockingOut) api.clockOut(ClockOutIn(serial, person.id)) else api.clockIn(ClockInIn(serial, person.id, sel?.siteId, sel?.initiativeId))
                flashGood()
                val name = next.person.display_name
                val minutes = next.last_entry?.minutes
                showToast(if (clockingOut) "Clocked out — $name" + (minutes?.let { " · ${formatMinutes(it)}" } ?: "") else "Clocked in — $name")
                toEntry()
            } catch (e: Exception) {
                flashBad()
                _state.update { it.copy(punching = false) }
                showError(punchErrorText(e), ERROR_MS)
                bumpIdle()
                val code = (e as? ApiError)?.code
                if (code == "already_clocked_in" || code == "not_clocked_in") loadStatus(person.id)
            }
        }
    }
}
```

`TimeclockScreen.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.timeclock

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.input.camera.CameraScanSheet
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.ScanInput
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.screens.scan.LoadStatus
import com.serversherpa.kiosk.ui.screens.scan.ScanTools
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

@Composable
fun TimeclockScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val context = LocalContext.current
    val vm = kioskViewModel { TimeclockViewModel(container.db, container.sync, container.api, container.prefs, container.identity, container.scanBus, container.flash, container.sound, container.scope) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val setup by container.prefs.setupSelection.collectAsStateWithLifecycle(initialValue = null)
    var camera by remember { mutableStateOf(false) }
    val empty = ui.loadStatus == LoadStatus.READY && ui.rosterSize == 0
    val disabled = ui.loadStatus != LoadStatus.READY || empty

    if (camera) { CameraScanSheet(onScan = { container.scanBus.publish(it) }, onDismiss = { camera = false }); return }

    Column(Modifier.pointerInput(Unit) { awaitPointerEventScope { while (true) { awaitPointerEvent(); vm.bumpIdle() } } }) {
        PageHeader("Kiosk · Timeclock", "Timeclock", setup?.let { "${it.initiativeName} · ${it.siteName}" } ?: "Finish Kiosk Setup first.")
        if (ui.loadStatus == LoadStatus.ERROR) KioskToast("Couldn't read this kiosk's local data.", error = true)
        if (empty) Text("No people on this kiosk. Sync from Kiosk Setup.", color = c.textMute)
        KioskToast(ui.toast)
        val selected = ui.selected
        if (selected != null) {
            val status = ui.status
            val name = status?.person?.display_name ?: selected.displayName
            SetupCard(selected = true, onClick = {}) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Avatar(status?.person?.avatar_url, name, container)
                    Column {
                        Text(name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        when {
                            ui.statusPhase == LoadStatus.LOADING -> Text("Checking the portal…", color = c.textMute)
                            ui.statusPhase == LoadStatus.ERROR -> Text("Status unavailable", color = ChipTone.RED.text)
                            status != null && status.clocked_in && status.entry != null -> {
                                Text("Clocked in for ${formatMinutes(minutesSince(status.entry.started_at, ui.nowMs))}", color = ChipTone.GREEN.text)
                                Text(listOfNotNull("since ${clockTime(status.entry.started_at)}", status.entry.initiative_name, status.entry.site_name).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = c.textMute)
                            }
                            status != null -> {
                                Text("Not clocked in", color = c.textMute)
                                status.last_entry?.let { Text("Last clock-out ${clockTime(it.ended_at)}", style = MaterialTheme.typography.bodySmall, color = c.textMute) }
                            }
                        }
                    }
                }
            }
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SolidButton(if (ui.punching) "Working…" else if (status?.clocked_in == true) "Clock out" else "Clock in", onClick = { vm.punch() }, enabled = ui.statusPhase == LoadStatus.READY && !ui.punching, modifier = Modifier.weight(1f))
                MiniButton("Cancel", { vm.toEntry() })
            }
            KioskToast(ui.error, error = true)
        } else {
            ScanInput(ui.value, vm::onChange, onSubmit = { vm.onEnter(it) }, placeholder = "Scan a badge or type a name", enabled = !disabled, keepFocus = !camera)
            ScanTools(container.hasCamera, { camera = true }, container.hasDataWedge) { DataWedge.softScan(context, true) }
            KioskToast(ui.error, error = true)
            for (p in ui.results) {
                Row(Modifier.fillMaxWidth().clickable { vm.select(p) }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(p.displayName, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    if (p.isWorker) KioskChip("worker", ChipTone.SLATE, dot = false)
                    if (p.hasAccount) KioskChip("account", ChipTone.SLATE, dot = false)
                    p.rfidTag?.let { Text(displayRfid(it), fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute) }
                }
            }
        }
    }
}

/** The presigned avatar fetched with OkHttp (no image library); initials until it lands or if it fails. */
@Composable
private fun Avatar(url: String?, name: String, container: com.serversherpa.kiosk.AppContainer) {
    val c = LocalKioskColors.current
    var bitmap by remember(url) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(url) {
        if (url == null) return@LaunchedEffect
        bitmap = withContext(Dispatchers.IO) {
            runCatching {
                container.httpClient.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    r.body?.bytes()?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }
                }
            }.getOrNull()
        }
    }
    val bmp = bitmap
    if (bmp != null) androidx.compose.foundation.Image(bmp, contentDescription = null, modifier = Modifier.size(64.dp).background(c.paper2, CircleShape))
    else Box(Modifier.size(64.dp).background(c.paper2, CircleShape), contentAlignment = Alignment.Center) { Text(initialsOf(name), style = MaterialTheme.typography.titleLarge, color = c.textMute) }
}
```

In `KioskApp.kt`: `gated(nav, Routes.TIMECLOCK, FeatureId.TIMECLOCK) { TimeclockScreen(nav) }`.

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.timeclock.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): Timeclock — badge/id/name entry, worker card with live elapsed time, one-button punch, 20 s idle reset

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 25: Wrap-up — README, spec notes, full gate, live verification

**Files:**
- Create: `Android_Kiosk_App/README.md`
- Modify: `docs/superpowers/specs/2026-09-15-android-kiosk-design.md` (append "Implementation notes (2026-09-15)")

- [ ] **Step 1: README**

`Android_Kiosk_App/README.md`:

```markdown
# ServerSherpa Kiosk (Android)

The native Android port of the web kiosk (`../kiosk/`) for phones and Zebra handhelds. Spec: `../docs/superpowers/specs/2026-09-15-android-kiosk-design.md`.

## Build and test

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

`local.properties` (ignored) must point `sdk.dir` at the Android SDK. Or open this folder in Android Studio.

## Install

```bash
adb devices
adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
```

Debug builds default to `https://api.dev.serversherpa.com`; change it under Settings › This Kiosk (reachable signed out via the gear on the login screen). Release builds default to `https://api.serversherpa.com`.

## Scanning inputs

- **Zebra (DataWedge):** on first launch the app creates the DataWedge profile `ServerSherpaKiosk` (barcode in, intent out to `com.serversherpa.kiosk.SCAN`, keystrokes off). The hardware trigger and the on-screen Scan button both fire it.
- **Bluetooth / USB HID scanners:** type into the focused box; Enter submits.
- **Camera:** the Camera button on Scanning, RFID Enroll, and Timeclock; Single closes on the first read, Multi reads each distinct code once until Done.

## Layout

`core/` is Android-free Kotlin (matching, RFID, people search, outbox machine, settings) — the layer the iOS app will transliterate. `data/` is HTTP, session, Room, DataStore, sync, outbox. `input/` is the scan sources. `ui/` is Compose.

## Icons and fonts

`python3 tools/make_icons.py` regenerates the launcher icons from `../portal/public/images/serversherpa-logo.png`. Fonts are bundled (see `FONTS-LICENSE.md`).
```

- [ ] **Step 2: Spec implementation notes**

Append to the spec:

```markdown
## Implementation notes (2026-09-15)

- The 401 → refresh → retry rule lives in `OkHttpKioskApi.authed()` rather than an OkHttp interceptor (`AuthInterceptor.kt` in the file list was not created); same behavior as `apiFetch` in the web kiosk, simpler to test with MockWebServer.
- `DataWedgeReceiver` is registered dynamically in `MainActivity.onStart/onStop` only — DataWedge's broadcast is implicit, so a manifest receiver would not receive it on Android 8+.
- The scaffold's generated library versions (core 1.19.0, lifecycle 2.11.0, activity-compose 1.13.0) required compileSdk 37 / AGP 9.1 and were pinned down (1.16.0 / 2.9.2 / 1.10.1) to keep compileSdk 36 on the installed SDK.
- Fonts are the Google Fonts variable TTFs (Geologica variable, Fragment Mono regular + italic); `Font(variationSettings=…)` needs `@OptIn(ExperimentalTextApi::class)` on this Compose version.
- Sound uploads, the container/truck checkpoint rows, and the label vocabulary endpoint are not wired (out of scope).
```

- [ ] **Step 3: Full gate**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
cd Android_Kiosk_App && ./gradlew clean testDebugUnitTest assembleDebug
```

Expected: `BUILD SUCCESSFUL`, 0 failures. Record the test count.

- [ ] **Step 4: Live verification on the MC2200 and the phone emulator**

The dev API runs at `https://api.dev.serversherpa.com` (Nginx Proxy Manager → the dev box). Dev login: `claude-dev@test.example.com` / `wt-verify-2026` (from `/Users/jrh1812/.claude/projects/-Users-jrh1812-Developer-BaseCampV3/memory/basecampv3-dev-workflow.md`; if it fails, say so — never reset a password from this plan). Seeded move: "NAP11 Hall Migration (demo)" (15-asset roster).

```bash
ADB=~/Library/Android/sdk/platform-tools/adb
$ADB -s 23287523020891 install -r app/build/outputs/apk/debug/app-debug.apk
$ADB -s 23287523020891 shell am start -n com.serversherpa.kiosk/.MainActivity
$ADB -s 23287523020891 logcat -c
```

Drive the device with `adb shell input` and screenshots (`$ADB -s 23287523020891 exec-out screencap -p > /tmp/step.png`, then Read the PNG):

1. Login: tap the Email field, `input text 'claude-dev@test.example.com'`, tap Password, `input text 'wt-verify-2026'`, tap Sign in. Expect Home with the setup banner and a `Registered` chip within a few seconds (the heartbeat's first beat).
2. Kiosk Setup: tap the tile, pick the seeded move, a site, a scan type. Expect the summary with "Local data: 15 assets · …".
3. Scanning: open it; press the MC2200 trigger on any printed barcode (or `input text 'A-1'` + Enter with a real asset ID from the roster shown in Settings › Developer's inspector); expect the green flash, a queued row turning `accepted`.
4. RFID Enroll: enter a roster asset's serial, then a tag like `100999`; expect "Enrolled … → 100999" and the asset's tag updated in the inspector.
5. Timeclock: type the seeded worker's name, Clock in, then Clock out; expect the two toasts.
6. In the portal (`https://portal.dev.serversherpa.com/hardware/kiosks`) confirm the device row: sub-type Android, Registered, signed in as claude-dev.
7. `adb logcat -s AndroidRuntime` shows no crash.

Emulator:

```bash
~/Library/Android/sdk/emulator/emulator -avd Medium_Phone_API_36.0 -no-snapshot-load &
$ADB wait-for-device
$ADB -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
$ADB -s emulator-5554 shell am start -n com.serversherpa.kiosk/.MainActivity
```

Repeat step 1 and step 3 (typed value + the Camera button opening the camera sheet, permission prompt accepted) on the emulator. Screenshot each state and keep the PNGs in the scratchpad for the final report.

- [ ] **Step 5: Commit**

```bash
git add -A Android_Kiosk_App docs/superpowers/specs/2026-09-15-android-kiosk-design.md
git commit -m "docs(android): README and spec implementation notes after live verification on MC2200 and emulator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Done

All four parts complete: the Android kiosk builds, its unit and Compose tests pass, and it was exercised end to end on a Zebra MC2200 and a phone emulator against the dev API.
