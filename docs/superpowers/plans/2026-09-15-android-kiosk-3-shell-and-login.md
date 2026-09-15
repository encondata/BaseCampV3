# Android Kiosk Implementation Plan — Part 3 of 4: Shell, Components, Login, Home

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Parts 1 and 2 must be complete first; their Global Constraints apply here verbatim.

**Goal:** The app boots into a real shell: the flash overlay and tone player, the shared Compose components, the `AppContainer` wiring, navigation with the two guards, the top bar + footer shell, the placeholder page, the Login screen with Link-with-phone pairing, and the Home launcher.

**Architecture:** `AppContainer` (one instance on the `Application`) owns every long-lived object from Parts 1–2 plus the flash controller, sound player, scan bus and DataWedge receiver; screens reach it through `LocalAppContainer`. Screens keep transient state in a small `ViewModel` created with `kioskViewModel { }`. Navigation Compose routes are the web kiosk's paths.

**Tech Stack:** Jetpack Compose Material 3, Navigation Compose 2.8.9, lifecycle-process, AudioTrack for tones, zxing-core for the pairing QR, Robolectric + compose-ui-test for tests.

**Spec:** `docs/superpowers/specs/2026-09-15-android-kiosk-design.md` sections "Flash and sound", "Navigation and guards", "Shell", "Login", "Home", "Placeholder". Reference: `kiosk/src/layout/KioskShell.tsx`, `kiosk/src/components/{KioskGuard,SetupGate,PairPanel,KioskBanners,ScanFlash,HslPicker}.tsx`, `kiosk/src/pages/{Login,Home,FeaturePage}.tsx`, `kiosk/src/lib/{flash,sound}.ts`.

## Global Constraints (in addition to Parts 1–2)

- Compose tests: `@RunWith(RobolectricTestRunner::class)`, `@Config(sdk = [34])`, `@get:Rule val compose = createComposeRule()`. Wrap content in `KioskTheme { }`. Where a screen needs the container, build a `TestContainer` (Task 17) — never `AndroidSecretStore` under Robolectric (no Keystore).
- Touch targets ≥ 48 dp. Portrait-first; nothing may assume a width above 360 dp.
- Text copy verbatim from the web kiosk (see the spec's per-screen sections).

---

### Task 16: Flash overlay, tone player, and shared components

**Files:**
- Create: `ui/flash/FlashController.kt`, `ui/flash/ScanFlash.kt`
- Create: `ui/sound/SoundPlayer.kt`
- Create: `ui/components/Buttons.kt`, `ui/components/PageHeader.kt`, `ui/components/KioskChip.kt`, `ui/components/Segmented.kt`, `ui/components/SettingsRow.kt`, `ui/components/SetupCard.kt`, `ui/components/KioskToast.kt`, `ui/components/HslPicker.kt`, `ui/components/ScanInput.kt`, `ui/components/PlaceholderCard.kt`, `ui/components/KioskViewModel.kt`
- Test: `ui/flash/FlashControllerTest.kt`, `ui/sound/TonesTest.kt`, `ui/components/ComponentsTest.kt`

**Interfaces:**
- Produces:
  - `data class FlashState(val id: Int, val argb: Int, val ms: Int)`; `class FlashController(scope: CoroutineScope)` with `val state: StateFlow<FlashState?>`, `fun flash(argb: Int, ms: Int)`, `fun clear()`; `@Composable fun ScanFlash(controller: FlashController)`
  - `enum class ScanSoundKind { GOOD, NOT_FOUND, DUPLICATE }`; `object Tones { fun pcm(id: BuiltinSound, volume: Double, sampleRate: Int = 44_100): ShortArray }`; `class SoundPlayer(prefs: KioskPrefs, scope: CoroutineScope)` with `fun play(kind: ScanSoundKind)`, `fun preview(choice: SoundChoice)`
  - Components: `SolidButton(text, onClick, enabled, modifier)`, `MiniButton(text, onClick, enabled, modifier)`, `LinkButton(text, onClick)`, `PageHeader(eyebrow, title, hint: String? = null)`, `KioskChip(text, tone: ChipTone, dot: Boolean = true)`, `Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit)`, `SettingsRow(label, hint: String? = null, control: @Composable () -> Unit)`, `SetupCard(selected: Boolean, onClick, enabled: Boolean = true, content: @Composable ColumnScope.() -> Unit)`, `KioskToast(text: String?)`, `HslPicker(name, value: Hsl, onChange: (Hsl) -> Unit, onPreview: () -> Unit)`, `ScanInput(value, onValueChange, onSubmit: (String) -> Unit, placeholder, enabled: Boolean = true, keepFocus: Boolean = true, modifier)`, `PlaceholderCard(text, actionText, onAction)`, `inline fun <reified VM : ViewModel> kioskViewModel(crossinline create: () -> VM): VM`

- [ ] **Step 1: Tests first**

`ui/flash/FlashControllerTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.flash

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FlashControllerTest {
    @Test fun aNewerFlashOwnsTheScreen() = runTest {
        val c = FlashController(backgroundScope)
        c.flash(0xFF00FF00.toInt(), 350)
        val first = c.state.value!!
        advanceTimeBy(200)
        c.flash(0xFFFF0000.toInt(), 350)
        assertEquals(first.id + 1, c.state.value!!.id)
        advanceTimeBy(200); advanceUntilIdle()
        assertEquals(0xFFFF0000.toInt(), c.state.value!!.argb)   // the first flash's timer did not clear the second
        advanceTimeBy(200); advanceUntilIdle()
        assertNull(c.state.value)
    }
}
```

`ui/sound/TonesTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.sound

import com.serversherpa.kiosk.core.settings.BuiltinSound
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TonesTest {
    @Test fun lengthsFollowTheWebDefinitions() {
        assertEquals(44_100 * 180 / 1000, Tones.pcm(BuiltinSound.CHIME, 1.0).size)      // 90 + 90 ms
        assertEquals(44_100 * 120 / 1000, Tones.pcm(BuiltinSound.BEEP, 1.0).size)
        assertEquals(44_100 * 200 / 1000, Tones.pcm(BuiltinSound.DOUBLE_BEEP, 1.0).size) // 130 + 70 ms
        assertEquals(44_100 * 300 / 1000, Tones.pcm(BuiltinSound.BUZZ, 1.0).size)
        assertEquals(44_100 * 220 / 1000, Tones.pcm(BuiltinSound.BONK, 1.0).size)
    }

    @Test fun volumeScalesAndSilenceIsSilent() {
        val loud = Tones.pcm(BuiltinSound.BEEP, 1.0).maxOf { kotlin.math.abs(it.toInt()) }
        val quiet = Tones.pcm(BuiltinSound.BEEP, 0.25).maxOf { kotlin.math.abs(it.toInt()) }
        assertTrue(loud > quiet * 3)
        assertTrue(Tones.pcm(BuiltinSound.BEEP, 0.0).all { it.toInt() == 0 })
    }
}
```

`ui/components/ComponentsTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import com.serversherpa.kiosk.core.settings.Hsl
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ComponentsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun scanInputSubmitsTrimmedValueOnImeActionAndClears() {
        var submitted = ""
        compose.setContent {
            KioskTheme {
                var v by mutableStateOf("")
                ScanInput(value = v, onValueChange = { v = it }, onSubmit = { submitted = it; v = "" }, placeholder = "Scan")
            }
        }
        compose.onNodeWithTag("scan-input").performTextInput("  A-100 ")
        compose.onNodeWithTag("scan-input").performImeAction()
        assertEquals("A-100", submitted)
    }

    @Test fun segmentedSelects() {
        var selected = "a"
        compose.setContent { KioskTheme { Segmented(listOf("a" to "Alpha", "b" to "Beta"), selected) { selected = it } } }
        compose.onNodeWithText("Beta").performClick()
        assertEquals("b", selected)
    }

    @Test fun hslPickerShowsReadoutAndPreviewFires() {
        var previews = 0
        compose.setContent { KioskTheme { HslPicker("Good scan flash", Hsl(150.0, 60.0, 45.0), onChange = {}, onPreview = { previews++ }) } }
        compose.onNodeWithText("hsl(150 60% 45%)").assertIsDisplayed()
        compose.onNodeWithText("Preview flash").performClick()
        assertEquals(1, previews)
    }

    @Test fun placeholderCard() {
        compose.setContent { KioskTheme { PlaceholderCard("This feature is not available yet.", "Back to home") {} } }
        compose.onNodeWithText("This feature is not available yet.").assertIsDisplayed()
    }
}
```

Run: `./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.*'` → FAIL.

- [ ] **Step 2: Flash**

`ui/flash/FlashController.kt`:

```kotlin
package com.serversherpa.kiosk.ui.flash

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class FlashState(val id: Int, val argb: Int, val ms: Int)

/** kiosk/src/lib/flash.ts: one overlay for the whole kiosk; a newer flash owns the screen. */
class FlashController(private val scope: CoroutineScope) {
    private val _state = MutableStateFlow<FlashState?>(null)
    val state: StateFlow<FlashState?> = _state
    private var nextId = 0
    private var timer: Job? = null

    fun flash(argb: Int, ms: Int) {
        timer?.cancel()
        val mine = FlashState(++nextId, argb, ms)
        _state.value = mine
        timer = scope.launch {
            delay(ms.toLong())
            if (_state.value?.id == mine.id) _state.value = null
        }
    }

    fun clear() { timer?.cancel(); _state.value = null }
}
```

`ui/flash/ScanFlash.kt`:

```kotlin
package com.serversherpa.kiosk.ui.flash

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** Paints the whole window in the flash color, 85% opaque, fading out over the flash's duration. */
@Composable
fun ScanFlash(controller: FlashController) {
    val state by controller.state.collectAsStateWithLifecycle()
    val current = state ?: return
    val alpha = remember(current.id) { Animatable(0.85f) }
    LaunchedEffect(current.id) { alpha.animateTo(0f, tween(current.ms)) }
    Box(
        Modifier.fillMaxSize().zIndex(10f).testTag("scan-flash")
            .background(Color(current.argb).copy(alpha = alpha.value)),
    )
}
```

- [ ] **Step 3: Sound**

`ui/sound/SoundPlayer.kt`:

```kotlin
package com.serversherpa.kiosk.ui.sound

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.serversherpa.kiosk.core.settings.BuiltinSound
import com.serversherpa.kiosk.core.settings.DEFAULT_SOUND_SETTINGS
import com.serversherpa.kiosk.core.settings.SoundChoice
import com.serversherpa.kiosk.core.settings.SoundSettings
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.pow
import kotlin.math.sin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

enum class ScanSoundKind { GOOD, NOT_FOUND, DUPLICATE }

private enum class Wave { SINE, SQUARE, SAWTOOTH }
private data class Tone(val wave: Wave, val freq: Double, val atMs: Int, val ms: Int, val endFreq: Double? = null)

/** The five built-ins, synthesized exactly as kiosk/src/lib/sound.ts describes them. */
object Tones {
    private val DEFS: Map<BuiltinSound, List<Tone>> = mapOf(
        BuiltinSound.CHIME to listOf(Tone(Wave.SINE, 880.0, 0, 90), Tone(Wave.SINE, 1318.0, 90, 90)),
        BuiltinSound.BEEP to listOf(Tone(Wave.SQUARE, 880.0, 0, 120)),
        BuiltinSound.DOUBLE_BEEP to listOf(Tone(Wave.SQUARE, 880.0, 0, 70), Tone(Wave.SQUARE, 880.0, 130, 70)),
        BuiltinSound.BUZZ to listOf(Tone(Wave.SAWTOOTH, 150.0, 0, 300)),
        BuiltinSound.BONK to listOf(Tone(Wave.SINE, 440.0, 0, 220, endFreq = 160.0)),
    )

    fun pcm(id: BuiltinSound, volume: Double, sampleRate: Int = 44_100): ShortArray {
        val tones = DEFS.getValue(id)
        val totalMs = tones.maxOf { it.atMs + it.ms }
        val out = DoubleArray(sampleRate * totalMs / 1000)
        val gain = volume.coerceIn(0.0, 1.0) * 0.6
        for (t in tones) {
            val start = sampleRate * t.atMs / 1000
            val n = sampleRate * t.ms / 1000
            var phase = 0.0
            for (i in 0 until n) {
                val frac = i.toDouble() / n
                val f = if (t.endFreq != null) t.freq * (t.endFreq / t.freq).pow(frac) else t.freq
                phase += 2 * PI * f / sampleRate
                val raw = when (t.wave) {
                    Wave.SINE -> sin(phase)
                    Wave.SQUARE -> if (sin(phase) >= 0) 1.0 else -1.0
                    Wave.SAWTOOTH -> 2 * ((phase / (2 * PI)) % 1.0) - 1
                }
                // 12 ms attack, then an exponential decay to the end of the note.
                val attackN = sampleRate * 12 / 1000
                val env = if (i < attackN) i.toDouble() / attackN else exp(-4.0 * (i - attackN) / (n - attackN).coerceAtLeast(1))
                out[start + i] += raw * env * gain
            }
        }
        return ShortArray(out.size) { (out[it].coerceIn(-1.0, 1.0) * Short.MAX_VALUE).toInt().toShort() }
    }
}

/** Plays the configured sound for a scan outcome. Never throws. */
class SoundPlayer(prefs: KioskPrefs, private val scope: CoroutineScope) {
    @Volatile private var settings: SoundSettings = DEFAULT_SOUND_SETTINGS

    init { scope.launch { prefs.sound.collect { settings = it } } }

    fun play(kind: ScanSoundKind) {
        val s = settings
        val choice = when (kind) { ScanSoundKind.GOOD -> s.good; ScanSoundKind.NOT_FOUND -> s.notFound; ScanSoundKind.DUPLICATE -> s.duplicate }
        playChoice(choice, s.volume)
    }

    fun preview(choice: SoundChoice) = playChoice(choice, settings.volume)

    private fun playChoice(choice: SoundChoice, volume: Double) {
        val id = (choice as? SoundChoice.Builtin)?.id ?: return
        scope.launch(Dispatchers.IO) {
            try {
                val pcm = Tones.pcm(id, volume)
                val track = AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(44_100).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(pcm.size * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build()
                track.write(pcm, 0, pcm.size)
                track.play()
                Thread.sleep((pcm.size * 1000L / 44_100) + 50)
                track.release()
            } catch (e: Exception) { /* a scan is recorded whether or not the device made a noise */ }
        }
    }
}
```

- [ ] **Step 4: Components**

`ui/components/KioskViewModel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.runtime.Composable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory

/** A ViewModel built from a lambda, scoped to the current nav destination. */
@Composable
inline fun <reified VM : ViewModel> kioskViewModel(crossinline create: () -> VM): VM =
    viewModel(factory = viewModelFactory { initializer { create() } })
```

`ui/components/Buttons.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.btn-solid` — the one primary action on a screen. */
@Composable
fun SolidButton(text: String, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier) {
    val c = LocalKioskColors.current
    Button(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 48.dp),
        colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.ink)) { Text(text) }
}

/** `.mini-btn` — a secondary, outlined action. */
@Composable
fun MiniButton(text: String, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 48.dp)) { Text(text) }
}

/** `.link` — an inline text action. */
@Composable
fun LinkButton(text: String, onClick: () -> Unit) {
    TextButton(onClick = onClick) { Text(text, color = LocalKioskColors.current.accent) }
}
```

`ui/components/PageHeader.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.eyebrow` + `.page-title` + `.page-hint`. */
@Composable
fun PageHeader(eyebrow: String, title: String, hint: String? = null) {
    val c = LocalKioskColors.current
    Column(Modifier.padding(bottom = 12.dp)) {
        Text(eyebrow.uppercase(), style = MaterialTheme.typography.labelSmall, color = c.textMute)
        Text(title, style = MaterialTheme.typography.displaySmall, color = c.textDark, modifier = Modifier.padding(top = 4.dp))
        if (hint != null) Text(hint, style = MaterialTheme.typography.bodyMedium, color = c.textMute, modifier = Modifier.padding(top = 6.dp))
    }
}
```

`ui/components/KioskChip.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.ChipTone

/** The portal's `.chip.c-*`. */
@Composable
fun KioskChip(text: String, tone: ChipTone, dot: Boolean = true) {
    Row(
        Modifier.background(tone.bg, RoundedCornerShape(999.dp)).border(1.dp, tone.border, RoundedCornerShape(999.dp)).padding(horizontal = 9.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (dot) { androidx.compose.foundation.layout.Box(Modifier.size(6.dp).background(tone.text, CircleShape)); Spacer(Modifier.width(6.dp)) }
        Text(text, style = MaterialTheme.typography.labelMedium, color = tone.text)
    }
}
```

`ui/components/Segmented.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.segmented`: a row of tabs/radios; `options` are (value, label). Scrolls when narrow. */
@Composable
fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    val c = LocalKioskColors.current
    Row(
        Modifier.horizontalScroll(rememberScrollState()).background(c.paper2, RoundedCornerShape(10.dp)).border(1.dp, c.paperLine, RoundedCornerShape(10.dp)).padding(3.dp),
    ) {
        for ((value, label) in options) {
            val on = value == selected
            Text(
                label,
                style = MaterialTheme.typography.labelLarge,
                color = if (on) c.ink else c.textDark,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(if (on) c.accent else c.paper2)
                    .clickable { onSelect(value) }.heightIn(min = 42.dp).padding(horizontal = 14.dp, vertical = 10.dp)
                    .wrapContentHeight(Alignment.CenterVertically),
            )
        }
    }
}
```

(add `import androidx.compose.foundation.layout.wrapContentHeight`.)

`ui/components/SettingsRow.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.settings-row`: label, hint, then the control below (stacked for portrait). */
@Composable
fun SettingsRow(label: String, hint: String? = null, control: @Composable () -> Unit) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
        Text(label, style = MaterialTheme.typography.titleMedium, color = c.textDark)
        if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 2.dp, bottom = 8.dp))
        control()
    }
    HorizontalDivider(color = c.paperLine)
}
```

`ui/components/SetupCard.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.setup-card` / `.kiosk-tile`: paper card, accent border when selected, big tap target. */
@Composable
fun SetupCard(selected: Boolean, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = LocalKioskColors.current
    Column(
        modifier.fillMaxWidth().heightIn(min = 96.dp).clip(RoundedCornerShape(14.dp)).background(c.paper)
            .border(if (selected) 2.dp else 1.dp, if (selected) c.accent else c.paperLine, RoundedCornerShape(14.dp))
            .clickable(enabled = enabled, onClick = onClick).alpha(if (enabled) 1f else 0.45f).padding(16.dp),
        content = content,
    )
}
```

`ui/components/KioskToast.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.tc-toast` (status) and `.form-error` (alert) lines. */
@Composable
fun KioskToast(text: String?, error: Boolean = false) {
    if (text == null) return
    val c = LocalKioskColors.current
    val tone = if (error) ChipTone.RED else ChipTone.GREEN
    Text(text, style = MaterialTheme.typography.bodyMedium, color = if (error) tone.text else c.textDark,
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp).background(tone.bg, RoundedCornerShape(10.dp)).padding(12.dp))
}
```

`ui/components/HslPicker.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.core.settings.Hsl
import com.serversherpa.kiosk.core.settings.hslCss
import com.serversherpa.kiosk.core.settings.hslToArgb

/** One color: swatch, three channel sliders, the hsl() readout, Preview flash. */
@Composable
fun HslPicker(name: String, value: Hsl, onChange: (Hsl) -> Unit, onPreview: () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            androidx.compose.foundation.layout.Box(Modifier.size(40.dp).background(Color(hslToArgb(value)), RoundedCornerShape(8.dp)))
            Text(hslCss(value), style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 12.dp))
        }
        Channel("Hue", value.h, 360f) { onChange(value.copy(h = it)) }
        Channel("Saturation", value.s, 100f) { onChange(value.copy(s = it)) }
        Channel("Lightness", value.l, 100f) { onChange(value.copy(l = it)) }
        MiniButton("Preview flash", onClick = onPreview)
    }
}

@Composable
private fun Channel(label: String, v: Double, max: Float, onChange: (Double) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.width(84.dp))
        Slider(value = v.toFloat(), onValueChange = { onChange(Math.round(it).toDouble()) }, valueRange = 0f..max, modifier = Modifier.weight(1f))
        Text("${Math.round(v)}", style = MaterialTheme.typography.labelMedium, modifier = Modifier.width(40.dp))
    }
}
```

`ui/components/ScanInput.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.delay

/**
 * The always-focused box: a barcode scanner is a keyboard, so whatever
 * it types lands here and its Enter submits. `keepFocus` reclaims focus
 * when it drifts (a tap on empty space, the app coming back).
 */
@Composable
fun ScanInput(
    value: String,
    onValueChange: (String) -> Unit,
    onSubmit: (String) -> Unit,
    placeholder: String,
    enabled: Boolean = true,
    keepFocus: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val requester = remember { FocusRequester() }
    LaunchedEffect(enabled, keepFocus) { if (enabled && keepFocus) { delay(50); runCatching { requester.requestFocus() } } }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = true,
        placeholder = { Text(placeholder) },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done, autoCorrect = false),
        keyboardActions = KeyboardActions(onDone = { val v = value.trim(); if (v.isNotEmpty()) onSubmit(v) }),
        modifier = modifier.fillMaxWidth().testTag("scan-input").focusRequester(requester)
            .onFocusChanged { if (!it.isFocused && enabled && keepFocus) runCatching { requester.requestFocus() } },
    )
}
```

`ui/components/PlaceholderCard.kt`:

```kotlin
package com.serversherpa.kiosk.ui.components

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** `.kiosk-placeholder`: a dashed card with one line and one action. */
@Composable
fun PlaceholderCard(text: String, actionText: String, onAction: () -> Unit) {
    val c = LocalKioskColors.current
    Column(Modifier.fillMaxWidth().border(1.dp, c.paperLine, RoundedCornerShape(14.dp)).padding(20.dp)) {
        Text(text, style = MaterialTheme.typography.bodyLarge, color = c.textMute)
        LinkButton(actionText, onAction)
    }
}
```

- [ ] **Step 5: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): flash overlay, synthesized scan tones, and the shared kiosk components

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: App wiring, navigation, guards, shell, placeholder page

**Files:**
- Create: `AppContainer.kt`, `KioskApplication.kt`
- Replace: `MainActivity.kt`
- Create: `ui/KioskApp.kt`, `ui/Routes.kt`, `ui/guards/KioskGuard.kt`, `ui/guards/SetupGate.kt`, `ui/shell/KioskShell.kt`, `ui/screens/placeholder/FeaturePlaceholderScreen.kt`
- Modify: `app/src/main/AndroidManifest.xml` (`android:name=".KioskApplication"` on `<application>`)
- Test: `TestContainer.kt` (test source set), `ui/shell/KioskShellTest.kt`, `ui/guards/GuardsTest.kt`

**Interfaces:**
- Produces:
  - `class AppContainer(app: Application, secrets: SecretStore = AndroidSecretStore(app), db: KioskDatabase = KioskDatabase.build(app))` exposing `prefs, config, identity, session, cookieJar, api, auth, db, sync, outbox, heartbeat, foreground: MutableStateFlow<Boolean>, scanBus, dataWedgeReceiver, flash, sound, scope, hasDataWedge: Boolean, hasCamera: Boolean`, `fun start()`, `suspend fun logout()`
  - `val LocalAppContainer: ProvidableCompositionLocal<AppContainer>`
  - `object Routes { LOGIN, HOME, SETUP, SETTINGS ("settings?tab={tab}"), SCAN, ENROLL, TIMECLOCK, CONTAINERS, TRUCKS, LABELS; fun settings(tab: String?) }`
  - `@Composable fun KioskApp(container)`, `@Composable fun KioskGuard(nav, content)`, `@Composable fun SetupGate(feature, nav, content)`, `@Composable fun KioskShell(nav, content)`, `@Composable fun FeaturePlaceholderScreen(feature, nav)`; `@Composable fun MustChangePasswordNotice(portalUrl, onSignOut)`
  - Screens registered in `KioskApp` for later tasks call composables named `LoginScreen(nav)`, `HomeScreen(nav)`, `KioskSetupScreen(nav)`, `SettingsScreen(nav, tab)`, `ScanScreen(nav)`, `EnrollScreen(nav)`, `TimeclockScreen(nav)`. Until those tasks land, `KioskApp` routes them to `FeaturePlaceholderScreen` (Tasks 18–24 replace one line each).

- [ ] **Step 1: Test container**

`app/src/test/java/com/serversherpa/kiosk/TestContainer.kt`:

```kotlin
package com.serversherpa.kiosk

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.data.api.MemorySecretStore
import com.serversherpa.kiosk.data.db.KioskDatabase
import kotlinx.coroutines.runBlocking

/** An AppContainer safe under Robolectric: memory secrets, in-memory Room, an API URL that fails fast. */
fun testContainer(): AppContainer {
    val app = ApplicationProvider.getApplicationContext<Application>()
    val c = AppContainer(app, secrets = MemorySecretStore(), db = KioskDatabase.inMemory(app))
    runBlocking { c.prefs.setApiUrl("http://127.0.0.1:1") }
    return c
}
```

- [ ] **Step 2: Tests first**

`ui/shell/KioskShellTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.shell

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskSetupSelection
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
class KioskShellTest {
    @get:Rule val compose = createComposeRule()

    @Test fun barAndFooterShowContextSignedOut() {
        val c = testContainer()
        runBlocking { c.prefs.setSetupSelection(KioskSetupSelection("i", "Move A", "s", "Dock 4", "source", "pre_stage", "Pre-stage")) }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) {
                KioskTheme { KioskShell(rememberNavController()) { Text("page body") } }
            }
        }
        compose.onNodeWithText("page body").assertIsDisplayed()
        compose.onNodeWithText("KIOSK · ANDROID").assertIsDisplayed()
        compose.onNodeWithText("Android", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Move A", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Data Sync").assertIsDisplayed()
    }
}
```

`ui/guards/GuardsTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.guards

import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.features.FeatureId
import com.serversherpa.kiosk.core.features.feature
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.data.fakeSession
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
class GuardsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun mustChangePasswordShowsTheNotice() {
        val c = testContainer()
        c.auth.completePair(fakeSession(mustChange = true))
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { KioskGuard(rememberNavController()) { Text("secret") } } }
        }
        compose.onNodeWithText("Your password needs to be changed before you can use a kiosk.", substring = true).assertIsDisplayed()
    }

    @Test fun setupGateShowsContentWhenCompleteOrDevMode() {
        val c = testContainer()
        c.auth.completePair(fakeSession())
        runBlocking { c.prefs.setSetupState(SetupState.COMPLETE) }
        compose.setContent {
            CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { SetupGate(feature(FeatureId.SCAN), rememberNavController()) { Text("scanning") } } }
        }
        compose.onNodeWithText("scanning").assertIsDisplayed()
    }
}
```

Run → FAIL.

- [ ] **Step 3: AppContainer, Application, Activity**

`AppContainer.kt`:

```kotlin
package com.serversherpa.kiosk

import android.app.Application
import android.content.Context
import android.os.Build
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.datastore.preferences.preferencesDataStore
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.serversherpa.kiosk.data.api.AndroidSecretStore
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.OkHttpKioskApi
import com.serversherpa.kiosk.data.api.RefreshCookieJar
import com.serversherpa.kiosk.data.api.SecretStore
import com.serversherpa.kiosk.data.api.SessionStore
import com.serversherpa.kiosk.data.auth.KioskAuth
import com.serversherpa.kiosk.data.auth.SessionCoordinator
import com.serversherpa.kiosk.data.config.KioskConfig
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.heartbeat.Heartbeat
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.data.outbox.Outbox
import com.serversherpa.kiosk.data.outbox.RoomOutboxStore
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.input.ScanBus
import com.serversherpa.kiosk.input.camera.hasCamera
import com.serversherpa.kiosk.input.datawedge.DataWedge
import com.serversherpa.kiosk.input.datawedge.DataWedgeReceiver
import com.serversherpa.kiosk.ui.flash.FlashController
import com.serversherpa.kiosk.ui.sound.SoundPlayer
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

private val Context.kioskDataStore by preferencesDataStore("kiosk_prefs")

/** Manual dependency wiring: one instance, built by KioskApplication. */
class AppContainer(
    private val app: Application,
    secrets: SecretStore = AndroidSecretStore(app),
    val db: KioskDatabase = KioskDatabase.build(app),
) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val prefs = KioskPrefs(app.kioskDataStore)
    val config = KioskConfig(prefs, BuildConfig.DEFAULT_API_URL, BuildConfig.DEFAULT_PORTAL_URL, BuildConfig.KIOSK_VERSION)
    val identity = Identity(prefs)
    val cookieJar = RefreshCookieJar(secrets)
    val httpClient: OkHttpClient = OkHttpClient.Builder().cookieJar(cookieJar)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    val session = SessionStore(httpClient, config, scope)
    val api: KioskApi = OkHttpKioskApi(httpClient, config, session)
    val auth = KioskAuth(api, session, identity, scope)
    val sync = Sync(api, db, scope)
    val outbox = Outbox(RoomOutboxStore(db.outbox()), api, identity, scope)
    val hasDataWedge: Boolean = DataWedge.isPresent(app)
    val hasCamera: Boolean = hasCamera(app)
    val heartbeat = Heartbeat(api, identity, config, deviceInfo = {
        mapOf(
            "manufacturer" to Build.MANUFACTURER, "model" to Build.MODEL,
            "android_version" to Build.VERSION.RELEASE, "sdk_int" to Build.VERSION.SDK_INT.toString(),
            "datawedge" to hasDataWedge.toString(),
        )
    })
    val foreground = MutableStateFlow(false)
    val scanBus = ScanBus()
    val dataWedgeReceiver = DataWedgeReceiver(scanBus)
    val flash = FlashController(scope)
    val sound = SoundPlayer(prefs, scope)

    fun start() {
        scope.launch { identity.get(); auth.restore(); sync.hydrate() }
        scope.launch { session.sessionEnded.collect { cookieJar.clearRefreshCookie() } }
        SessionCoordinator(auth, heartbeat, foreground, scope).start()
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { foreground.value = true; outbox.start() }
            override fun onStop(owner: LifecycleOwner) { foreground.value = false; outbox.stop() }
        })
        DataWedge.configure(app)
    }

    suspend fun logout() {
        auth.logout()
        cookieJar.clearRefreshCookie()
    }
}

val LocalAppContainer = staticCompositionLocalOf<AppContainer> { error("No AppContainer provided") }
```

`KioskApplication.kt`:

```kotlin
package com.serversherpa.kiosk

import android.app.Application

class KioskApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.start()
    }
}
```

`MainActivity.kt` (replace whole file):

```kotlin
package com.serversherpa.kiosk

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import com.serversherpa.kiosk.ui.KioskApp

class MainActivity : ComponentActivity() {
    private val container get() = (application as KioskApplication).container

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            CompositionLocalProvider(LocalAppContainer provides container) { KioskApp() }
        }
    }

    override fun onStart() { super.onStart(); if (container.hasDataWedge) container.dataWedgeReceiver.register(this) }
    override fun onStop() { container.dataWedgeReceiver.unregister(this); super.onStop() }
}
```

Manifest: add `android:name=".KioskApplication"` to `<application>`.

- [ ] **Step 4: Routes, guards, app**

`ui/Routes.kt`:

```kotlin
package com.serversherpa.kiosk.ui

object Routes {
    const val LOGIN = "login"
    const val HOME = "home"
    const val SETUP = "setup"
    const val SETTINGS = "settings?tab={tab}"
    const val SCAN = "scan"
    const val ENROLL = "enroll"
    const val TIMECLOCK = "timeclock"
    const val CONTAINERS = "containers"
    const val TRUCKS = "trucks"
    const val LABELS = "labels"

    fun settings(tab: String? = null): String = if (tab == null) "settings" else "settings?tab=$tab"
}
```

`ui/guards/KioskGuard.kt`:

```kotlin
package com.serversherpa.kiosk.ui.guards

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.PageHeader
import kotlinx.coroutines.launch

/** The kiosk's ProtectedRoute: Loading → spinner, Anon → login, must-change-password → notice. */
@Composable
fun KioskGuard(nav: NavHostController, content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val state by container.auth.state.collectAsStateWithLifecycle()
    val portalUrl by container.config.portalUrl.collectAsStateWithLifecycle(initialValue = "")
    val scope = rememberCoroutineScope()
    when (val s = state) {
        AuthState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        AuthState.Anon -> LaunchedEffect(Unit) { nav.navigate(Routes.LOGIN) { popUpTo(0) } }
        is AuthState.Authed -> if (s.mustChangePassword) {
            MustChangePasswordNotice(portalUrl) { scope.launch { container.logout(); nav.navigate(Routes.LOGIN) { popUpTo(0) } } }
        } else content()
    }
}

@Composable
fun MustChangePasswordNotice(portalUrl: String, onSignOut: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(20.dp)) {
        PageHeader("Kiosk", "Password change required")
        Text("Your password needs to be changed before you can use a kiosk. Sign in to the portal at $portalUrl to change it.",
            style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(bottom = 16.dp))
        MiniButton("Sign out", onSignOut)
    }
}
```

`ui/guards/SetupGate.kt`:

```kotlin
package com.serversherpa.kiosk.ui.guards

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.features.KioskFeature
import com.serversherpa.kiosk.core.features.featureAvailable
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.ui.Routes

/** Redirects to Home unless the feature is usable in the kiosk's setup state (dev mode overrides). */
@Composable
fun SetupGate(feature: KioskFeature, nav: NavHostController, content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val setupState by container.prefs.setupState.collectAsStateWithLifecycle(initialValue = null)
    val devMode by container.prefs.devMode.collectAsStateWithLifecycle(initialValue = false)
    val state = setupState ?: return   // still reading
    if (featureAvailable(feature, state as SetupState, devMode)) content()
    else LaunchedEffect(Unit) { nav.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } } }
}
```

`ui/KioskApp.kt`:

```kotlin
package com.serversherpa.kiosk.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.features.FeatureId
import com.serversherpa.kiosk.core.features.feature
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.ui.flash.ScanFlash
import com.serversherpa.kiosk.ui.guards.KioskGuard
import com.serversherpa.kiosk.ui.guards.SetupGate
import com.serversherpa.kiosk.ui.screens.placeholder.FeaturePlaceholderScreen
import com.serversherpa.kiosk.ui.shell.KioskShell
import com.serversherpa.kiosk.ui.theme.KioskTheme

@Composable
fun KioskApp() {
    val container = LocalAppContainer.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val prefs = (auth as? AuthState.Authed)?.preferences
    KioskTheme(theme = prefs?.theme ?: "light", accent = prefs?.accent ?: "amber") {
        val nav = rememberNavController()
        Box(androidx.compose.ui.Modifier.fillMaxSize()) {
            NavHost(nav, startDestination = Routes.HOME) {
                composable(Routes.LOGIN) { FeaturePlaceholderScreen(feature(FeatureId.SETTINGS), nav) }          // Task 18: LoginScreen(nav)
                composable(Routes.HOME) { KioskGuard(nav) { KioskShell(nav) { FeaturePlaceholderScreen(feature(FeatureId.SETUP), nav) } } } // Task 19: HomeScreen(nav)
                composable(Routes.SETUP) { KioskGuard(nav) { KioskShell(nav) { FeaturePlaceholderScreen(feature(FeatureId.SETUP), nav) } } } // Task 20: KioskSetupScreen(nav)
                composable(Routes.SETTINGS, arguments = listOf(navArgument("tab") { type = NavType.StringType; nullable = true })) { entry ->
                    KioskShell(nav) { FeaturePlaceholderScreen(feature(FeatureId.SETTINGS), nav) }                     // Task 21: SettingsScreen(nav, entry.arguments?.getString("tab"))
                }
                gated(nav, Routes.SCAN, FeatureId.SCAN) { FeaturePlaceholderScreen(feature(FeatureId.SCAN), nav) }         // Task 22: ScanScreen(nav)
                gated(nav, Routes.ENROLL, FeatureId.ENROLL) { FeaturePlaceholderScreen(feature(FeatureId.ENROLL), nav) }   // Task 23: EnrollScreen(nav)
                gated(nav, Routes.TIMECLOCK, FeatureId.TIMECLOCK) { FeaturePlaceholderScreen(feature(FeatureId.TIMECLOCK), nav) } // Task 24: TimeclockScreen(nav)
                gated(nav, Routes.CONTAINERS, FeatureId.CONTAINERS) { FeaturePlaceholderScreen(feature(FeatureId.CONTAINERS), nav) }
                gated(nav, Routes.TRUCKS, FeatureId.TRUCKS) { FeaturePlaceholderScreen(feature(FeatureId.TRUCKS), nav) }
                gated(nav, Routes.LABELS, FeatureId.LABELS) { FeaturePlaceholderScreen(feature(FeatureId.LABELS), nav) }
            }
            ScanFlash(container.flash)
        }
    }
}

/** KioskGuard + SetupGate + KioskShell around a feature screen. */
private fun androidx.navigation.NavGraphBuilder.gated(nav: NavHostController, route: String, id: FeatureId, content: @Composable () -> Unit) {
    composable(route) { KioskGuard(nav) { SetupGate(feature(id), nav) { KioskShell(nav) { content() } } } }
}
```

- [ ] **Step 5: Shell and placeholder**

`ui/shell/KioskShell.kt`:

```kotlin
package com.serversherpa.kiosk.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.currentBackStackEntryAsState
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.R
import com.serversherpa.kiosk.core.devices.RegistrationState
import com.serversherpa.kiosk.core.features.featureForRoute
import com.serversherpa.kiosk.data.auth.AuthState
import com.serversherpa.kiosk.data.identity.KioskIdentity
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.KioskChip
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.launch

private val REG_TONE = mapOf(RegistrationState.OK to ChipTone.GREEN, RegistrationState.SOON to ChipTone.AMBER, RegistrationState.EXPIRED to ChipTone.RED, RegistrationState.NONE to ChipTone.SLATE)

/** kiosk/src/layout/KioskShell.tsx: dark top bar, the page, one-line mono footer. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun KioskShell(nav: NavHostController, content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val auth by container.auth.state.collectAsStateWithLifecycle()
    val identity by container.identity.identity.collectAsStateWithLifecycle(initialValue = KioskIdentity("", ""))
    val registration by container.heartbeat.registration.collectAsStateWithLifecycle()
    val setup by container.prefs.setupSelection.collectAsStateWithLifecycle(initialValue = null)
    val devMode by container.prefs.devMode.collectAsStateWithLifecycle(initialValue = false)
    val sync by container.sync.status.collectAsStateWithLifecycle()
    val backStack by nav.currentBackStackEntryAsState()
    val feature = featureForRoute(backStack?.destination?.route)
    val scope = rememberCoroutineScope()
    val authed = auth as? AuthState.Authed

    Column(Modifier.fillMaxSize().background(c.paper2)) {
        // ── top bar ──
        Column(Modifier.fillMaxWidth().background(c.ink).statusBarsPadding().padding(horizontal = 14.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                androidx.compose.foundation.Image(painterResource(R.mipmap.ic_launcher_foreground), contentDescription = null, modifier = Modifier.size(30.dp))
                Text(buildString { append("Server") }, color = c.snow, fontWeight = FontWeight.SemiBold)
                Text("Sherpa", color = c.accent, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = (-8).dp))
                Text("KIOSK · ANDROID", fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.accentSoft)
                if (feature != null) Text(feature.title, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.snow)
            }
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(identity.name, fontFamily = FragmentMono, color = c.snow, modifier = Modifier.clickable { nav.navigate(Routes.settings("this-kiosk")) }.padding(6.dp))
                androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
                if (authed != null) {
                    registration?.let { KioskChip(it.label, REG_TONE.getValue(it)) }
                    Text(authed.person.display_name, color = c.snow, style = MaterialTheme.typography.bodySmall)
                    MiniButton("Sign out", onClick = { scope.launch { container.logout(); nav.navigate(Routes.LOGIN) { popUpTo(0) } } })
                }
            }
        }
        // ── page ──
        Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp)) { content() }
        // ── footer ──
        FlowRow(Modifier.fillMaxWidth().background(c.paper).navigationBarsPadding().padding(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FootItem("Mode", "Android")
            FootItem("Version", container.config.kioskVersion)
            setup?.let { FootItem("Move", it.initiativeName); FootItem("Site", it.siteName); FootItem("Scan", it.scanLabel) }
            val good = sync.phase == SyncPhase.DONE
            Text("Data Sync", fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = if (good) ChipTone.GREEN.text else ChipTone.RED.text)
            if (devMode) FootItem("Dev mode", "On", valueColor = c.accent)
        }
    }
}

@Composable
private fun FootItem(label: String, value: String, valueColor: androidx.compose.ui.graphics.Color = LocalKioskColors.current.textDark) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label.uppercase(), fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = LocalKioskColors.current.textMute)
        Text(value, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = valueColor)
    }
}
```

`ui/screens/placeholder/FeaturePlaceholderScreen.kt`:

```kotlin
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
```

- [ ] **Step 6: Run tests, build, install on a device (smoke), commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.*' assembleDebug
~/Library/Android/sdk/platform-tools/adb -s 23287523020891 install -r app/build/outputs/apk/debug/app-debug.apk
~/Library/Android/sdk/platform-tools/adb -s 23287523020891 shell am start -n com.serversherpa.kiosk/.MainActivity
~/Library/Android/sdk/platform-tools/adb -s 23287523020891 exec-out screencap -p > /tmp/kiosk-shell.png
```

Expected: the app opens (the placeholder page inside the shell, or the login placeholder once the restore fails) with no crash in `adb logcat -s AndroidRuntime`. If the MC2200 is not attached, skip the install; the emulator step is Part 4's last task.

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): AppContainer wiring, navigation with guards, the kiosk shell, and the placeholder page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: Login screen and Link-with-phone pairing

**Files:**
- Create: `ui/screens/login/LoginViewModel.kt`, `ui/screens/login/LoginScreen.kt`, `ui/screens/login/PairPanel.kt`, `ui/screens/login/Qr.kt`
- Modify: `ui/KioskApp.kt` (LOGIN route → `LoginScreen(nav)`)
- Test: `ui/screens/login/LoginViewModelTest.kt`, `ui/screens/login/PairViewModelTest.kt`, `ui/screens/login/LoginScreenTest.kt`

**Interfaces:**
- Produces: `LoginViewModel(container)` with `state: StateFlow<LoginUi>` (`view: LoginView`, `email`, `password`, `showPassword`, `error`, `invalidEmail`, `invalidPassword`, `loading`, `movePassword`, `moveNotice`, `status: SystemStatus`), `fun setEmail/setPassword/togglePassword/setView/setMovePassword`, `fun submitPassword(onDone: () -> Unit)`, `fun submitMove()`, `fun loadBanners()`; `enum class LoginView { PASSWORD, CHOOSER, LINK, MOVE }`; `PairViewModel(container, clock)` with `state: StateFlow<PairUi>` (`phase: PairPhase`, `pair: PairCreated?`, `error`, `remainingSec`), `fun request()`, `fun startPolling(onApproved)`; `enum class PairPhase { REQUESTING, SHOWING, DENIED, EXPIRED, ERROR }`; `fun formatCode(code): String`; `fun qrBitmap(text, sizePx): android.graphics.Bitmap`; `@Composable fun LoginScreen(nav)`.
- Error copy: `ERROR_MESSAGES` map exactly as `kiosk/src/pages/Login.tsx`.

- [ ] **Step 1: Tests first**

`LoginViewModelTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.login

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.FakeRefresher
import com.serversherpa.kiosk.data.auth.KioskAuth
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.testIdentity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class LoginViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun kotlinx.coroutines.test.TestScope.vm(api: FakeKioskApi): LoginViewModel {
        val auth = KioskAuth(api, FakeRefresher(), testIdentity(tmp.root, backgroundScope), backgroundScope)
        return LoginViewModel(auth, api, backgroundScope)
    }

    @Test fun emptyFieldsAreRejectedLocally() = runTest {
        val vm = vm(FakeKioskApi())
        var done = false
        vm.submitPassword { done = true }
        assertEquals("Please enter both email and password", vm.state.value.error)
        assertTrue(vm.state.value.invalidEmail && vm.state.value.invalidPassword)
        assertEquals(false, done)
    }

    @Test fun errorCodesMapToCopy() = runTest {
        val api = FakeKioskApi().apply { loginResult = { throw ApiError(403, "kiosk_not_allowed") } }
        val vm = vm(api)
        vm.setEmail("a@b.c"); vm.setPassword("pw")
        vm.submitPassword {}; advanceUntilIdle()
        assertEquals("This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access.", vm.state.value.error)
        assertEquals("", vm.state.value.password)   // cleared after a failure
        api.loginResult = { throw ApiError(0, "network") }
        vm.setPassword("pw"); vm.submitPassword {}; advanceUntilIdle()
        assertEquals("Can't reach the server. Check the kiosk's network connection.", vm.state.value.error)
    }

    @Test fun successCallsOnDone() = runTest {
        val api = FakeKioskApi().apply { loginResult = { fakeSession() } }
        val vm = vm(api)
        vm.setEmail("a@b.c"); vm.setPassword("pw")
        var done = false
        vm.submitPassword { done = true }; advanceUntilIdle()
        assertTrue(done)
    }

    @Test fun movePasswordIsAPlaceholder() = runTest {
        val vm = vm(FakeKioskApi())
        vm.setView(LoginView.MOVE); vm.setMovePassword("x"); vm.submitMove()
        assertTrue(vm.state.value.moveNotice)
    }
}
```

`PairViewModelTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.login

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PairPoll
import com.serversherpa.kiosk.core.model.PairStatus
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.fakeSession
import com.serversherpa.kiosk.data.testIdentity
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class PairViewModelTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun requestsThenPollsUntilApproved() = runTest {
        val api = FakeKioskApi()
        var polls = 0
        api.pollResult = { if (++polls < 3) PairPoll(PairStatus.PENDING, null) else PairPoll(PairStatus.APPROVED, fakeSession()) }
        val vm = PairViewModel(api, testIdentity(tmp.root, backgroundScope), backgroundScope, clock = { testScheduler.currentTime + 1_000_000_000_000L })
        var approved = false
        vm.request(); advanceUntilIdle()
        assertEquals(PairPhase.SHOWING, vm.state.value.phase)
        vm.startPolling { approved = true }
        advanceTimeBy(2_001); advanceUntilIdle(); assertEquals(1, polls)
        advanceTimeBy(4_001); advanceUntilIdle()
        assertTrue(approved)
        assertEquals("ABCD-1234", formatCode(vm.state.value.pair!!.code))
    }

    @Test fun deniedAndRateLimited() = runTest {
        val api = FakeKioskApi().apply { pollResult = { PairPoll(PairStatus.DENIED, null) } }
        val vm = PairViewModel(api, testIdentity(tmp.root, backgroundScope), backgroundScope, clock = { testScheduler.currentTime + 1_000_000_000_000L })
        vm.request(); advanceUntilIdle(); vm.startPolling {}; advanceTimeBy(2_001); advanceUntilIdle()
        assertEquals(PairPhase.DENIED, vm.state.value.phase)
        api.pairCreated = { throw ApiError(429, "pair_rate_limited") }
        vm.request(); advanceUntilIdle()
        assertEquals(PairPhase.ERROR, vm.state.value.phase)
        assertEquals("too many codes requested — wait a few minutes", vm.state.value.error)
    }
}
```

`LoginScreenTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LoginScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun passwordFormThenOtherWays() {
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides testContainer()) { KioskTheme { LoginScreen(rememberNavController()) } } }
        compose.onNodeWithText("Forgot your password? Reset it in the portal.").assertIsDisplayed()
        compose.onNodeWithText("Other ways to sign in").performClick()
        compose.onNodeWithText("Link with phone").assertIsDisplayed()
        compose.onNodeWithText("Move password").assertIsDisplayed()
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`LoginViewModel.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.login

import androidx.lifecycle.ViewModel
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.SystemStatus
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.auth.KioskAuth
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class LoginView { PASSWORD, CHOOSER, LINK, MOVE }

data class LoginUi(
    val view: LoginView = LoginView.PASSWORD,
    val email: String = "", val password: String = "", val showPassword: Boolean = false,
    val error: String? = null, val invalidEmail: Boolean = false, val invalidPassword: Boolean = false, val loading: Boolean = false,
    val movePassword: String = "", val moveNotice: Boolean = false,
    val status: SystemStatus = SystemStatus(),
)

val ERROR_MESSAGES = mapOf(
    "invalid_credentials" to "Invalid email or password.",
    "account_locked" to "Too many failed attempts — this account is temporarily locked. Try again in about 15 minutes.",
    "account_disabled" to "This account is disabled. Contact your coordinator.",
    "totp_required" to "This account requires a verification code. 2FA sign-in is coming soon — contact support.",
    "kiosk_not_allowed" to "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access.",
    "network" to "Can't reach the server. Check the kiosk's network connection.",
)

class LoginViewModel(private val auth: KioskAuth, private val api: KioskApi, private val scope: CoroutineScope) : ViewModel() {
    private val _state = MutableStateFlow(LoginUi())
    val state: StateFlow<LoginUi> = _state

    fun setEmail(v: String) = _state.update { it.copy(email = v, invalidEmail = false, error = null) }
    fun setPassword(v: String) = _state.update { it.copy(password = v, invalidPassword = false, error = null) }
    fun togglePassword() = _state.update { it.copy(showPassword = !it.showPassword) }
    fun setView(v: LoginView) = _state.update { it.copy(view = v, error = null, moveNotice = false) }
    fun setMovePassword(v: String) = _state.update { it.copy(movePassword = v, moveNotice = false) }

    fun loadBanners() { scope.launch { try { _state.update { it.copy(status = api.systemStatus()) } } catch (e: Exception) { /* best effort */ } } }

    fun submitPassword(onDone: () -> Unit) {
        val s = _state.value
        if (s.email.isBlank() || s.password.isBlank()) {
            _state.update { it.copy(error = "Please enter both email and password", invalidEmail = s.email.isBlank(), invalidPassword = s.password.isBlank()) }
            return
        }
        _state.update { it.copy(loading = true, error = null) }
        scope.launch {
            try {
                auth.login(s.email.trim(), s.password)
                _state.update { it.copy(loading = false) }
                onDone()
            } catch (e: Exception) {
                val code = (e as? ApiError)?.code ?: "network"
                _state.update { it.copy(loading = false, error = ERROR_MESSAGES[code] ?: "Login failed. Please try again.", invalidEmail = true, invalidPassword = true, password = "") }
            }
        }
    }

    /** Move passwords have no backend yet. */
    fun submitMove() = _state.update { it.copy(moveNotice = true) }
}
```

`Qr.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.login

import android.graphics.Bitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

fun formatCode(code: String): String = if (code.length > 4) "${code.take(4)}-${code.drop(4)}" else code

fun portalHost(url: String): String = try { java.net.URI(url).host ?: url } catch (e: Exception) { url }

/** A QR of `text`, dark on light, `sizePx` square. */
fun qrBitmap(text: String, sizePx: Int, dark: Int = 0xFF1B2129.toInt(), light: Int = 0xFFFBFCFD.toInt()): Bitmap {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, sizePx, sizePx, mapOf(EncodeHintType.MARGIN to 1, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M))
    val bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
    for (x in 0 until sizePx) for (y in 0 until sizePx) bmp.setPixel(x, y, if (matrix[x, y]) dark else light)
    return bmp
}
```

`PairPanel.kt` (ViewModel + composable):

```kotlin
package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.PairCreated
import com.serversherpa.kiosk.core.model.PairStatus
import com.serversherpa.kiosk.core.model.SessionData
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.identity.Identity
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.LinkButton
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.theme.FragmentMono
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

const val POLL_MS = 2_000L

enum class PairPhase { REQUESTING, SHOWING, DENIED, EXPIRED, ERROR }

data class PairUi(val phase: PairPhase = PairPhase.REQUESTING, val pair: PairCreated? = null, val error: String = "", val remainingSec: Long = 0)

class PairViewModel(
    private val api: KioskApi, private val identity: Identity, private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val _state = MutableStateFlow(PairUi())
    val state: StateFlow<PairUi> = _state
    private var generation = 0
    private var pollJob: Job? = null

    fun request() {
        val mine = ++generation
        pollJob?.cancel()
        _state.value = PairUi(PairPhase.REQUESTING)
        scope.launch {
            try {
                val (serial, name) = identity.get()
                val created = api.createPairRequest(serial, name)
                if (mine != generation) return@launch
                _state.value = PairUi(PairPhase.SHOWING, created, remainingSec = remaining(created))
            } catch (e: Exception) {
                if (mine != generation) return@launch
                val code = (e as? ApiError)?.code
                _state.value = PairUi(PairPhase.ERROR, error = when (code) {
                    "pair_rate_limited" -> "too many codes requested — wait a few minutes"
                    "network" -> "network error"
                    else -> "server error"
                })
            }
        }
    }

    private fun remaining(p: PairCreated): Long = try {
        maxOf(0L, (Instant.parse(p.expires_at).toEpochMilli() - clock()) / 1000)
    } catch (e: Exception) { 0L }

    /** Polls every 2 s while SHOWING; the countdown ticks each second. */
    fun startPolling(onApproved: (SessionData) -> Unit) {
        pollJob?.cancel()
        val mine = generation
        pollJob = scope.launch {
            var nextPoll = clock() + POLL_MS
            while (true) {
                delay(1_000)
                val ui = _state.value
                val pair = ui.pair
                if (mine != generation || ui.phase != PairPhase.SHOWING || pair == null) return@launch
                val left = remaining(pair)
                _state.update { it.copy(remainingSec = left) }
                if (left <= 0) { _state.update { it.copy(phase = PairPhase.EXPIRED) }; return@launch }
                if (clock() < nextPoll) continue
                nextPoll = clock() + POLL_MS
                try {
                    val result = api.pollPair(pair.code, pair.poll_token)
                    when (result.status) {
                        PairStatus.APPROVED -> if (result.session != null) { onApproved(result.session); return@launch }
                        PairStatus.DENIED -> { _state.update { it.copy(phase = PairPhase.DENIED) }; return@launch }
                        PairStatus.EXPIRED -> { _state.update { it.copy(phase = PairPhase.EXPIRED) }; return@launch }
                        PairStatus.PENDING -> Unit
                    }
                } catch (e: Exception) { /* transient — next tick retries */ }
            }
        }
    }
}

@Composable
fun PairPanel(vm: PairViewModel, portalUrl: String, onApproved: (SessionData) -> Unit) {
    val ui by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.request() }
    LaunchedEffect(ui.phase, ui.pair?.code) { if (ui.phase == PairPhase.SHOWING) vm.startPolling(onApproved) }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        when (ui.phase) {
            PairPhase.REQUESTING -> Text("Getting a code…", style = MaterialTheme.typography.bodyMedium)
            PairPhase.ERROR -> { KioskToast("Couldn't get a code (${ui.error}). Try again.", error = true); SolidButton("Try again", { vm.request() }) }
            PairPhase.DENIED -> { KioskToast("Sign-in was declined on the phone.", error = true); SolidButton("Get a new code", { vm.request() }) }
            PairPhase.EXPIRED -> { KioskToast("This code expired.", error = true); SolidButton("Get a new code", { vm.request() }) }
            PairPhase.SHOWING -> {
                val pair = ui.pair!!
                val bmp = remember(pair.code) { runCatching { qrBitmap(pair.link_url, 440) }.getOrNull() }
                if (bmp != null) Image(bmp.asImageBitmap(), contentDescription = "QR code to link this kiosk", modifier = Modifier.size(220.dp))
                Text(formatCode(pair.code), fontFamily = FragmentMono, style = MaterialTheme.typography.displaySmall, modifier = Modifier.padding(top = 12.dp))
                Text("Scan the code, or open ${portalHost(portalUrl)}/link on your phone and enter it.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp))
                Text("Expires in ${ui.remainingSec / 60}:${(ui.remainingSec % 60).toString().padStart(2, '0')}", fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 6.dp))
                LinkButton("Get a new code") { vm.request() }
            }
        }
    }
}
```

`LoginScreen.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.login

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.R
import com.serversherpa.kiosk.data.identity.KioskIdentity
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.LinkButton
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.components.SolidButton
import com.serversherpa.kiosk.ui.components.kioskViewModel
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** kiosk/src/pages/Login.tsx, stacked for portrait: brand band over the paper form. */
@Composable
fun LoginScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val vm = kioskViewModel { LoginViewModel(container.auth, container.api, container.scope) }
    val pairVm = kioskViewModel { PairViewModel(container.api, container.identity, container.scope) }
    val ui by vm.state.collectAsStateWithLifecycle()
    val identity by container.identity.identity.collectAsStateWithLifecycle(initialValue = KioskIdentity("", ""))
    val portalUrl by container.config.portalUrl.collectAsStateWithLifecycle(initialValue = "")
    LaunchedEffect(Unit) { vm.loadBanners() }
    val goHome = { nav.navigate(Routes.HOME) { popUpTo(0) } }

    Column(Modifier.fillMaxSize().background(c.paper).verticalScroll(rememberScrollState())) {
        // ── brand band ──
        Row(Modifier.fillMaxWidth().background(c.ink).statusBarsPadding().padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
            Image(painterResource(R.mipmap.ic_launcher_foreground), contentDescription = null, modifier = Modifier.size(56.dp))
            Column(Modifier.padding(start = 12.dp).weight(1f)) {
                Row { Text("Server", color = c.snow, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.headlineSmall); Text("Sherpa", color = c.accent, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.headlineSmall) }
                Text("KIOSK · ANDROID", fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.accentSoft)
                Text(identity.name, fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.snow)
            }
            IconButton(onClick = { nav.navigate(Routes.settings("this-kiosk")) }) { Text("⚙", color = c.snow) }
        }
        Column(Modifier.padding(20.dp)) {
            if (ui.status.read_only) KioskToast(if (ui.status.read_only_message.isNotBlank()) "Read-only maintenance mode — ${ui.status.read_only_message}" else "Read-only maintenance mode", error = true)
            ui.status.banner?.let { KioskToast(it) }
            Text("Sign in", style = MaterialTheme.typography.displaySmall, modifier = Modifier.padding(bottom = 12.dp))

            if (ui.view == LoginView.PASSWORD || ui.view == LoginView.CHOOSER) {
                OutlinedTextField(ui.email, vm::setEmail, label = { Text("Email") }, placeholder = { Text("you@company.com") }, isError = ui.invalidEmail, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(ui.password, vm::setPassword, label = { Text("Password") }, isError = ui.invalidPassword, singleLine = true,
                    visualTransformation = if (ui.showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = { LinkButton(if (ui.showPassword) "Hide" else "Show") { vm.togglePassword() } },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                KioskToast(ui.error, error = true)
                SolidButton(if (ui.loading) "Signing in…" else "Sign in", onClick = { vm.submitPassword(goHome) }, enabled = !ui.loading, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                Text("Forgot your password? Reset it in the portal.", style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 8.dp))
                Row(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    HorizontalDivider(Modifier.weight(1f)); Text("  or  ", color = c.textMute); HorizontalDivider(Modifier.weight(1f))
                }
                if (ui.view == LoginView.PASSWORD) MiniButton("Other ways to sign in", { vm.setView(LoginView.CHOOSER) }, modifier = Modifier.fillMaxWidth())
                else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MiniButton("Link with phone", { vm.setView(LoginView.LINK) }, modifier = Modifier.fillMaxWidth())
                    MiniButton("Move password", { vm.setView(LoginView.MOVE) }, modifier = Modifier.fillMaxWidth())
                }
            }
            if (ui.view == LoginView.LINK) {
                Text("Link this kiosk with your phone.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 12.dp))
                PairPanel(pairVm, portalUrl) { session -> container.auth.completePair(session); goHome() }
                LinkButton("Back to email & password") { vm.setView(LoginView.PASSWORD) }
            }
            if (ui.view == LoginView.MOVE) {
                Text("Sign in with a move password.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 12.dp))
                OutlinedTextField(ui.movePassword, vm::setMovePassword, label = { Text("Move password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                if (ui.moveNotice) KioskToast("Move passwords aren't available yet. Use email & password or link with your phone.")
                SolidButton("Sign in", { vm.submitMove() }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                LinkButton("Back to email & password") { vm.setView(LoginView.PASSWORD) }
            }
            Spacer(Modifier.size(24.dp))
        }
    }
}
```

In `KioskApp.kt`, replace the LOGIN line with `composable(Routes.LOGIN) { LoginScreen(nav) }` (import it).

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.login.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): login screen (email/password, link with phone via QR + polling, move-password placeholder)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 19: Home launcher

**Files:**
- Create: `ui/screens/home/HomeScreen.kt`, `ui/screens/home/FeatureIcons.kt`
- Modify: `ui/KioskApp.kt` (HOME route → `HomeScreen(nav)`)
- Test: `ui/screens/home/HomeScreenTest.kt`

**Interfaces:**
- Produces: `@Composable fun HomeScreen(nav)`; `@Composable fun FeatureIcon(id: FeatureId, tint: Color, size: Dp)` — vector paths traced from the SVGs in `kiosk/src/pages/Home.tsx` (`ICONS`).

- [ ] **Step 1: Test first**

```kotlin
package com.serversherpa.kiosk.ui.screens.home

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.compose.rememberNavController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.theme.KioskTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class HomeScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun incompleteSetupLocksFeatureTiles() {
        val c = testContainer()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { HomeScreen(rememberNavController()) } } }
        compose.onNodeWithText("What would you like to do?").assertIsDisplayed()
        compose.onNodeWithText("Kiosk setup is incomplete. Only Kiosk Setup and Settings are available.").assertIsDisplayed()
        assertEquals(6, compose.onAllNodesWithText("Finish Kiosk Setup first.").fetchSemanticsNodes().size)
    }

    @Test fun devModeUnlocksWithBanner() {
        val c = testContainer()
        runBlocking { c.prefs.setDevMode(true); c.prefs.setSetupState(SetupState.FAILED) }
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { HomeScreen(rememberNavController()) } } }
        compose.onNodeWithText("Developer mode: all features are available while kiosk setup is failed.").assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithText("Finish Kiosk Setup first.").fetchSemanticsNodes().size)
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`FeatureIcons.kt` — one `ImageVector` per feature built with `ImageVector.Builder` and `path { }` on a 40×40 viewport, tracing the SVG path data in `kiosk/src/pages/Home.tsx` (stroke 2.5, round joins; the `scan` icon is six filled rects; `labels` and `enroll` have a filled 2.5-radius circle). Use `androidx.compose.ui.graphics.vector.PathParser` via `addPath(PathParser().parsePathString(d).toNodes(), stroke = SolidColor(Color.Black), strokeLineWidth = 2.5f, strokeLineJoin = StrokeJoin.Round, strokeLineCap = StrokeCap.Round)` for the stroked paths and `fill = SolidColor(Color.Black)` for the filled parts; the composable tints with `ColorFilter.tint`. Expose:

```kotlin
package com.serversherpa.kiosk.ui.screens.home

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.core.features.FeatureId

private fun icon(name: String, strokes: List<String> = emptyList(), fills: List<String> = emptyList()): ImageVector {
    val b = ImageVector.Builder(name = name, defaultWidth = 40.dp, defaultHeight = 40.dp, viewportWidth = 40f, viewportHeight = 40f)
    for (d in strokes) b.addPath(PathParser().parsePathString(d).toNodes(), stroke = SolidColor(Color.Black), strokeLineWidth = 2.5f, strokeLineJoin = StrokeJoin.Round, strokeLineCap = StrokeCap.Round)
    for (d in fills) b.addPath(PathParser().parsePathString(d).toNodes(), fill = SolidColor(Color.Black))
    return b.build()
}

private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r},$cy a$r,$r 0 1,0 ${2 * r},0 a$r,$r 0 1,0 ${-2 * r},0"

val FEATURE_ICONS: Map<FeatureId, ImageVector> = mapOf(
    FeatureId.SETUP to icon("setup", strokes = listOf(circle(20f, 20f, 4.5f), "M32.3 23.3a2.8 2.8 0 0 0 .6 3.1l.2.2a3.3 3.3 0 1 1-4.7 4.7l-.2-.2a2.8 2.8 0 0 0-3.1-.6 2.8 2.8 0 0 0-1.7 2.6V34a3.3 3.3 0 1 1-6.6 0v-.3a2.8 2.8 0 0 0-1.8-2.6 2.8 2.8 0 0 0-3.1.6l-.2.2a3.3 3.3 0 1 1-4.7-4.7l.2-.2a2.8 2.8 0 0 0 .6-3.1 2.8 2.8 0 0 0-2.6-1.7H4.7a3.3 3.3 0 1 1 0-6.6H5a2.8 2.8 0 0 0 2.6-1.8 2.8 2.8 0 0 0-.6-3.1l-.2-.2a3.3 3.3 0 1 1 4.7-4.7l.2.2a2.8 2.8 0 0 0 3.1.6H15a2.8 2.8 0 0 0 1.7-2.6V4.7a3.3 3.3 0 1 1 6.6 0V5a2.8 2.8 0 0 0 1.7 2.6 2.8 2.8 0 0 0 3.1-.6l.2-.2a3.3 3.3 0 1 1 4.7 4.7l-.2.2a2.8 2.8 0 0 0-.6 3.1V15a2.8 2.8 0 0 0 2.6 1.7h.3a3.3 3.3 0 1 1 0 6.6h-.3a2.8 2.8 0 0 0-2.6 1.7Z")),
    FeatureId.SCAN to icon("scan", fills = listOf("M5 8h3v24H5z", "M11 8h1.5v24H11z", "M15 8h4v24h-4z", "M22 8h1.5v24H22z", "M26 8h3v24h-3z", "M32 8h3v24h-3z")),
    FeatureId.ENROLL to icon("enroll", strokes = listOf("M4 9h11l9 11-9 11H4V9z", "M29 14a8 8 0 0 1 0 12M33.5 10a13.5 13.5 0 0 1 0 20"), fills = listOf(circle(10.5f, 15.5f, 2f))),
    FeatureId.CONTAINERS to icon("containers", strokes = listOf("M6 11h28a2 2 0 0 1 2 2v19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2z", "M4 17h32", "M14 17v17M26 17v17", "M13 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3")),
    FeatureId.TRUCKS to icon("trucks", strokes = listOf("M2 10h19v17H2V10z", "M21 16h7l5 6v5h-12v-11z", circle(12f, 30f, 3.5f), circle(28f, 30f, 3.5f), "M2 27h6.5M15.5 27h9M31.5 27H38")),
    FeatureId.LABELS to icon("labels", strokes = listOf("M6 6h15l13 13-15 15L6 21V6z"), fills = listOf(circle(14f, 14f, 2.5f))),
    FeatureId.TIMECLOCK to icon("timeclock", strokes = listOf(circle(20f, 20f, 15f), "M20 11v9l7 4")),
    FeatureId.SETTINGS to icon("settings", strokes = listOf("M6 12h20M31 12h3", circle(26f, 12f, 3.5f), "M6 28h9M20 28h14", circle(15f, 28f, 3.5f))),
)

@Composable
fun FeatureIcon(id: FeatureId, tint: Color, size: Dp = 40.dp) {
    Image(FEATURE_ICONS.getValue(id), contentDescription = null, colorFilter = ColorFilter.tint(tint), modifier = Modifier.size(size))
}
```

`HomeScreen.kt`:

```kotlin
package com.serversherpa.kiosk.ui.screens.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.features.FEATURES
import com.serversherpa.kiosk.core.features.featureAvailable
import com.serversherpa.kiosk.core.setup.SetupState
import com.serversherpa.kiosk.ui.components.KioskToast
import com.serversherpa.kiosk.ui.components.PageHeader
import com.serversherpa.kiosk.ui.components.SetupCard
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** kiosk/src/pages/Home.tsx: the launcher, two tiles per row. */
@Composable
fun HomeScreen(nav: NavHostController) {
    val container = LocalAppContainer.current
    val c = LocalKioskColors.current
    val setupState by container.prefs.setupState.collectAsStateWithLifecycle(initialValue = SetupState.INCOMPLETE)
    val devMode by container.prefs.devMode.collectAsStateWithLifecycle(initialValue = false)
    val complete = setupState == SetupState.COMPLETE
    val failed = setupState == SetupState.FAILED

    Column {
        PageHeader("Kiosk", "What would you like to do?")
        if (!complete && devMode) KioskToast("Developer mode: all features are available while kiosk setup is ${setupState.wire}.")
        if (!complete && !devMode) KioskToast(if (failed) "Kiosk setup failed. Open Kiosk Setup to try again." else "Kiosk setup is incomplete. Only Kiosk Setup and Settings are available.", error = failed)
        FEATURES.chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (f in pair) {
                    val available = featureAvailable(f, setupState, devMode)
                    SetupCard(selected = false, enabled = available, onClick = { nav.navigate(f.route) }, modifier = Modifier.weight(1f)) {
                        FeatureIcon(f.id, c.accent)
                        Text(f.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 8.dp))
                        Text(f.blurb, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 4.dp))
                        if (!available) Text(if (failed) "Kiosk setup failed — open Kiosk Setup." else "Finish Kiosk Setup first.", fontFamily = FragmentMono, style = MaterialTheme.typography.labelSmall, color = c.textMute, modifier = Modifier.padding(top = 6.dp))
                    }
                }
                if (pair.size == 1) androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
            }
        }
    }
}
```

In `KioskApp.kt`, the HOME route becomes `composable(Routes.HOME) { KioskGuard(nav) { KioskShell(nav) { HomeScreen(nav) } } }`.

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.screens.home.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): Home launcher with the eight feature tiles, setup gating, and traced tile icons

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## End of Part 3

Continue with `docs/superpowers/plans/2026-09-15-android-kiosk-4-feature-screens.md` (Kiosk Setup, Settings, Scanning, RFID Enroll, Timeclock, wrap-up and live verification).
