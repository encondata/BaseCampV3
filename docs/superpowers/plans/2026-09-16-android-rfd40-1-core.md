# RFD40 RFID — Part 1: library wiring and the pure core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Zebra's RFID library on the build path and write the pure Kotlin that decides what a trigger pull and a burst of tags mean, with no Android and no vendor code in it.

**Architecture:** `core/rfid/` holds the settings model, the trigger state machine, and the read-session accumulator. All three are plain Kotlin covered by `CorePurityTest`, so the iOS app can transliterate them and every rule is testable with no sled attached.

**Tech Stack:** Kotlin, kotlinx.serialization for the settings JSON, plain JUnit, Gradle Kotlin DSL, Zebra RFIDAPI3 `.aar`.

## Global Constraints

Everything in `.superpowers/sdd/global-constraints.md` applies to every task here. In addition:

- The spec is `docs/superpowers/specs/2026-09-16-android-rfd40-rfid-design.md`. Read it before Task 1.
- The vendor library is already downloaded at `Android_Kiosk_App/RFIDAPI3Library/API3_LIB-release.aar` (Zebra RFIDAPI3 2.0.2.82, from Zebra's public sample repo). Do not re-download it and do not rename it.
- Nothing under `core/` may import `android.*`, `androidx.*`, or `com.zebra.*`. Only `ZebraRfidReader.kt` in Part 2 may import `com.zebra.*`.
- Tag values are compared with the existing `com.serversherpa.kiosk.core.scan.rfidKey` (zero-padding stripped, upper-cased). Never write a second normalizer.
- American English in every string, comment, and doc.

---

### Task 1: Put the Zebra library on the build path

**Files:**
- Create: `Android_Kiosk_App/RFIDAPI3Library/build.gradle`
- Modify: `Android_Kiosk_App/settings.gradle.kts`
- Modify: `Android_Kiosk_App/app/build.gradle.kts`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/input/rfid/RfidLibraryOnClasspathTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: the Gradle module `:RFIDAPI3Library`, so later tasks can write `import com.zebra.rfid.api3.*`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/input/rfid/RfidLibraryOnClasspathTest.kt`:

```kotlin
package com.serversherpa.kiosk.input.rfid

import org.junit.Assert.assertNotNull
import org.junit.Test

/** The vendor library is a hand-placed .aar, not a Gradle coordinate, so a
 *  bad path fails silently at runtime instead of at build time. This is the
 *  cheapest possible proof that it is really on the classpath. */
class RfidLibraryOnClasspathTest {
    @Test fun zebraApi3ClassesAreOnTheClasspath() {
        assertNotNull(Class.forName("com.zebra.rfid.api3.RFIDReader"))
        assertNotNull(Class.forName("com.zebra.rfid.api3.Readers"))
        assertNotNull(Class.forName("com.zebra.rfid.api3.TagData"))
        assertNotNull(Class.forName("com.zebra.rfid.api3.RfidEventsListener"))
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.input.rfid.RfidLibraryOnClasspathTest'
```

Expected: FAIL with `java.lang.ClassNotFoundException: com.zebra.rfid.api3.RFIDReader`.

- [ ] **Step 3: Add the library module**

Create `RFIDAPI3Library/build.gradle` (Groovy, exactly as Zebra ships it — this module has no Android plugin and needs no repositories):

```groovy
configurations.maybeCreate("default")
artifacts.add("default", file('API3_LIB-release.aar'))
```

In `settings.gradle.kts`, add the module after the app:

```kotlin
rootProject.name = "ServerSherpa Kiosk"
include(":app")
include(":RFIDAPI3Library")
```

In `app/build.gradle.kts`, add to the `dependencies { }` block, next to the other `implementation` lines:

```kotlin
    implementation(project(":RFIDAPI3Library"))
```

- [ ] **Step 4: Run the test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.input.rfid.RfidLibraryOnClasspathTest'
```

Expected: PASS.

- [ ] **Step 5: Prove the whole app still builds**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL.

**If this fails with a duplicate-class error** (the `.aar` bundles its own copies of slf4j, Apache Commons, jdom, antlr and jsch), add a `packaging` block to `app/build.gradle.kts` inside `android { }` excluding only the exact files the error names, for example:

```kotlin
    packaging {
        resources {
            excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
        }
    }
```

If the collision is a real duplicate *class* rather than a duplicate resource, report it in the task notes rather than deleting entries from the `.aar`.

- [ ] **Step 6: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "build(android): put Zebra's RFIDAPI3 library on the build path

A hand-placed .aar, not a Gradle coordinate: Zebra publishes no Maven
artifact. This copy is 2.0.2.82 from Zebra's public sample repo, enough to
build against; 2.0.5.292 from the download page replaces it before the sled
is trusted on a floor.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The settings model

**Files:**
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidSettings.kt`
- Modify: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/data/prefs/KioskPrefs.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/core/rfid/RfidSettingsTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: `RfidSettings`, `DEFAULT_RFID_SETTINGS`, `RfidTriggerMode`, `RepeatSweepPolicy`, `SledBeeper`, `RfidSession`, `RfidSettings.clamped()`, `RfidSettings.toJson()`, `parseRfidSettings(String?)`, `powerToTenths(Int)`, and on `KioskPrefs`: `val rfid: Flow<RfidSettings>` and `suspend fun setRfid(s: RfidSettings)`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/core/rfid/RfidSettingsTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Test

class RfidSettingsTest {
    @Test fun defaultsMatchTheSpec() {
        val d = DEFAULT_RFID_SETTINGS
        assertEquals(false, d.enabled)
        assertEquals(RfidTriggerMode.HOLD, d.triggerMode)
        assertEquals(RepeatSweepPolicy.ALWAYS_QUEUE, d.repeatPolicy)
        assertEquals(SledBeeper.MEDIUM, d.beeper)
        assertEquals(27, d.powerDbm)
        assertEquals(RfidSession.S1, d.session)
        assertEquals(30, d.tagPopulation)
        assertEquals(true, d.uniqueTagReport)
        assertEquals(true, d.ledOnRead)
        assertEquals(true, d.dpo)
        assertEquals(null, d.region)
    }

    @Test fun roundTripsThroughJson() {
        val s = RfidSettings(
            enabled = true, triggerMode = RfidTriggerMode.TOGGLE, repeatPolicy = RepeatSweepPolicy.SKIP_AND_COUNT,
            beeper = SledBeeper.OFF, powerDbm = 12, session = RfidSession.S2, tagPopulation = 200,
            uniqueTagReport = false, ledOnRead = false, dpo = false, region = "USA",
        )
        assertEquals(s, parseRfidSettings(s.toJson()))
    }

    @Test fun junkAndMissingFieldsFallBackToTheDefaults() {
        assertEquals(DEFAULT_RFID_SETTINGS, parseRfidSettings(null))
        assertEquals(DEFAULT_RFID_SETTINGS, parseRfidSettings("not json"))
        assertEquals(DEFAULT_RFID_SETTINGS, parseRfidSettings("{}"))
        // An unknown enum value is not a reason to lose the rest of the settings.
        val partial = parseRfidSettings("""{"enabled":true,"triggerMode":"nonsense","powerDbm":19}""")
        assertEquals(true, partial.enabled)
        assertEquals(RfidTriggerMode.HOLD, partial.triggerMode)
        assertEquals(19, partial.powerDbm)
    }

    /** A saved file from an older build, or a slider bug, must not ask the
     *  reader for an illegal power. */
    @Test fun outOfRangeNumbersAreClamped() {
        assertEquals(RFID_POWER_MAX, parseRfidSettings("""{"powerDbm":99}""").powerDbm)
        assertEquals(RFID_POWER_MIN, parseRfidSettings("""{"powerDbm":-4}""").powerDbm)
        assertEquals(RFID_POPULATION_MAX, parseRfidSettings("""{"tagPopulation":99999}""").tagPopulation)
        assertEquals(RFID_POPULATION_MIN, parseRfidSettings("""{"tagPopulation":0}""").tagPopulation)
    }

    @Test fun powerConvertsToTheTenthsOfADbmTheSdkWants() {
        assertEquals(270, powerToTenths(27))
        assertEquals(50, powerToTenths(5))
        assertEquals(300, powerToTenths(99))
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.rfid.RfidSettingsTest'
```

Expected: FAIL to compile, `Unresolved reference: DEFAULT_RFID_SETTINGS`.

- [ ] **Step 3: Write the model**

Create `app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidSettings.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** How the sled's trigger drives an inventory. */
enum class RfidTriggerMode(val wire: String, val label: String, val hint: String) {
    HOLD("hold", "Hold to read", "Reading starts when the trigger goes down and stops when it comes up."),
    HOLD_OR_LATCH("latch", "Hold, or click to latch", "Holding reads. A quick click leaves it reading until the next click."),
    TOGGLE("toggle", "Click to start and stop", "Every press flips between reading and stopped."),
    ;
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

/** What to do with a tag this kiosk already queued since the screen opened. */
enum class RepeatSweepPolicy(val wire: String, val label: String, val hint: String) {
    ALWAYS_QUEUE("always", "Queue every sweep", "A second pass over the same rack queues those tags again."),
    SKIP_SILENT("skip", "Skip tags already sent", "A tag queued earlier on this screen is dropped without a word."),
    SKIP_AND_COUNT("count", "Skip, but count them", "Dropped repeats are counted on screen so a second pass still shows."),
    ;
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

/** The sled's own beeper. OFF is the reader's quiet setting, not a mute we fake. */
enum class SledBeeper(val wire: String, val label: String) {
    OFF("off", "Off"), LOW("low", "Low"), MEDIUM("medium", "Medium"), HIGH("high", "High");
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

/** The gen2 session. Higher sessions make a tag stay quiet longer after it answers. */
enum class RfidSession(val wire: String, val label: String) {
    S0("s0", "S0"), S1("s1", "S1"), S2("s2", "S2"), S3("s3", "S3");
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

const val RFID_POWER_MIN = 5
const val RFID_POWER_MAX = 30
const val RFID_POPULATION_MIN = 1
const val RFID_POPULATION_MAX = 1000

/**
 * Everything the operator can set about the reader, kiosk-local like the rest
 * of the settings. `powerDbm` is the one most likely to need tuning on site:
 * high power is what makes a sweep pull in the next rack.
 */
data class RfidSettings(
    val enabled: Boolean = false,
    val triggerMode: RfidTriggerMode = RfidTriggerMode.HOLD,
    val repeatPolicy: RepeatSweepPolicy = RepeatSweepPolicy.ALWAYS_QUEUE,
    val beeper: SledBeeper = SledBeeper.MEDIUM,
    val powerDbm: Int = 27,
    val session: RfidSession = RfidSession.S1,
    val tagPopulation: Int = 30,
    val uniqueTagReport: Boolean = true,
    val ledOnRead: Boolean = true,
    val dpo: Boolean = true,
    val region: String? = null,
)

val DEFAULT_RFID_SETTINGS = RfidSettings()

fun RfidSettings.clamped(): RfidSettings = copy(
    powerDbm = powerDbm.coerceIn(RFID_POWER_MIN, RFID_POWER_MAX),
    tagPopulation = tagPopulation.coerceIn(RFID_POPULATION_MIN, RFID_POPULATION_MAX),
)

/** The SDK takes transmit power in tenths of a dBm: 27 dBm is 270. */
fun powerToTenths(dbm: Int): Int = dbm.coerceIn(RFID_POWER_MIN, RFID_POWER_MAX) * 10

private val json = Json { ignoreUnknownKeys = true }

fun RfidSettings.toJson(): String = buildJsonObject {
    put("enabled", enabled)
    put("triggerMode", triggerMode.wire)
    put("repeatPolicy", repeatPolicy.wire)
    put("beeper", beeper.wire)
    put("powerDbm", powerDbm)
    put("session", session.wire)
    put("tagPopulation", tagPopulation)
    put("uniqueTagReport", uniqueTagReport)
    put("ledOnRead", ledOnRead)
    put("dpo", dpo)
    if (region != null) put("region", region)
}.toString()

/** A bad field falls back to its default; a bad document falls back to all of them. */
fun parseRfidSettings(raw: String?): RfidSettings {
    val obj = try { raw?.let { json.parseToJsonElement(it).jsonObject } } catch (e: Exception) { null }
        ?: return DEFAULT_RFID_SETTINGS
    fun prim(key: String) = obj[key]?.jsonPrimitive
    fun str(key: String) = prim(key)?.takeIf { it.isString }?.content
    fun int(key: String) = prim(key)?.takeIf { !it.isString }?.intOrNull
    fun bool(key: String) = (prim(key) as? JsonPrimitive)?.booleanOrNull
    val d = DEFAULT_RFID_SETTINGS
    return RfidSettings(
        enabled = bool("enabled") ?: d.enabled,
        triggerMode = RfidTriggerMode.fromWire(str("triggerMode")) ?: d.triggerMode,
        repeatPolicy = RepeatSweepPolicy.fromWire(str("repeatPolicy")) ?: d.repeatPolicy,
        beeper = SledBeeper.fromWire(str("beeper")) ?: d.beeper,
        powerDbm = int("powerDbm") ?: d.powerDbm,
        session = RfidSession.fromWire(str("session")) ?: d.session,
        tagPopulation = int("tagPopulation") ?: d.tagPopulation,
        uniqueTagReport = bool("uniqueTagReport") ?: d.uniqueTagReport,
        ledOnRead = bool("ledOnRead") ?: d.ledOnRead,
        dpo = bool("dpo") ?: d.dpo,
        region = str("region"),
    ).clamped()
}
```

- [ ] **Step 4: Run the test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.rfid.RfidSettingsTest'
```

Expected: PASS.

- [ ] **Step 5: Store it in DataStore**

In `app/src/main/java/com/serversherpa/kiosk/data/prefs/KioskPrefs.kt`, add to the imports:

```kotlin
import com.serversherpa.kiosk.core.rfid.RfidSettings
import com.serversherpa.kiosk.core.rfid.parseRfidSettings
import com.serversherpa.kiosk.core.rfid.toJson
```

Add to `private object Keys`, after `sound`:

```kotlin
        val rfid = stringPreferencesKey("ss.kiosk.rfid")
```

Add after the `sound` flow and setter:

```kotlin
    val rfid: Flow<RfidSettings> = store.data.map { parseRfidSettings(it[Keys.rfid]) }
    suspend fun setRfid(s: RfidSettings) { store.edit { it[Keys.rfid] = s.toJson() } }
```

Note: `toJson()` is now ambiguous between `Appearance`, `SoundSettings` and `RfidSettings` only if they are imported unqualified into the same file. They are extension functions on different receivers, so Kotlin resolves them by receiver type and no change to the existing lines is needed.

- [ ] **Step 6: Run the whole suite and build**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL, `CorePurityTest` still passing.

- [ ] **Step 7: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): RFID reader settings model, stored like every other preference

Trigger mode, repeat-sweep policy, sled beeper, and the radio settings, with
the defaults the spec names. A bad field falls back to its default rather than
losing the rest, and power and population are clamped so a stale file cannot
ask the reader for something illegal.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The trigger state machine

**Files:**
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidTrigger.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/core/rfid/RfidTriggerTest.kt`

**Interfaces:**
- Consumes: `RfidTriggerMode` from Task 2.
- Produces: `enum class TriggerEvent { PRESSED, RELEASED }`, `enum class TriggerAction { START, STOP, NONE }`, `const val LATCH_MS: Long`, and `fun nextTriggerAction(mode: RfidTriggerMode, event: TriggerEvent, reading: Boolean, heldMs: Long): TriggerAction`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/core/rfid/RfidTriggerTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Test

class RfidTriggerTest {
    private fun act(mode: RfidTriggerMode, event: TriggerEvent, reading: Boolean, heldMs: Long = 0) =
        nextTriggerAction(mode, event, reading, heldMs)

    @Test fun holdReadsWhileTheTriggerIsDown() {
        assertEquals(TriggerAction.START, act(RfidTriggerMode.HOLD, TriggerEvent.PRESSED, reading = false))
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.HOLD, TriggerEvent.RELEASED, reading = true, heldMs = 1_500))
        // Even a flick of the trigger stops: hold mode never latches.
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.HOLD, TriggerEvent.RELEASED, reading = true, heldMs = 20))
    }

    @Test fun holdIgnoresEventsThatDoNotChangeAnything() {
        assertEquals(TriggerAction.NONE, act(RfidTriggerMode.HOLD, TriggerEvent.PRESSED, reading = true))
        assertEquals(TriggerAction.NONE, act(RfidTriggerMode.HOLD, TriggerEvent.RELEASED, reading = false))
    }

    @Test fun toggleFlipsOnEveryPressAndIgnoresRelease() {
        assertEquals(TriggerAction.START, act(RfidTriggerMode.TOGGLE, TriggerEvent.PRESSED, reading = false))
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.TOGGLE, TriggerEvent.PRESSED, reading = true))
        assertEquals(TriggerAction.NONE, act(RfidTriggerMode.TOGGLE, TriggerEvent.RELEASED, reading = true, heldMs = 5_000))
        assertEquals(TriggerAction.NONE, act(RfidTriggerMode.TOGGLE, TriggerEvent.RELEASED, reading = false))
    }

    @Test fun latchKeepsReadingAfterAQuickClick() {
        assertEquals(TriggerAction.START, act(RfidTriggerMode.HOLD_OR_LATCH, TriggerEvent.PRESSED, reading = false))
        // Let go quickly and it stays on.
        assertEquals(TriggerAction.NONE, act(RfidTriggerMode.HOLD_OR_LATCH, TriggerEvent.RELEASED, reading = true, heldMs = LATCH_MS - 1))
        // The next press ends the latched read.
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.HOLD_OR_LATCH, TriggerEvent.PRESSED, reading = true))
    }

    @Test fun latchStillBehavesLikeHoldWhenTheTriggerIsHeld() {
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.HOLD_OR_LATCH, TriggerEvent.RELEASED, reading = true, heldMs = LATCH_MS))
        assertEquals(TriggerAction.STOP, act(RfidTriggerMode.HOLD_OR_LATCH, TriggerEvent.RELEASED, reading = true, heldMs = 3_000))
    }

    @Test fun aReleaseWhileStoppedNeverStartsAnything() {
        for (mode in RfidTriggerMode.entries) {
            assertEquals(mode.name, TriggerAction.NONE, act(mode, TriggerEvent.RELEASED, reading = false, heldMs = 10))
        }
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.rfid.RfidTriggerTest'
```

Expected: FAIL to compile, `Unresolved reference: TriggerEvent`.

- [ ] **Step 3: Write the machine**

Create `app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidTrigger.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

/** What the sled's trigger just did. */
enum class TriggerEvent { PRESSED, RELEASED }

/** What that means for the inventory. */
enum class TriggerAction { START, STOP, NONE }

/** A release inside this window is a click, not the end of a hold. */
const val LATCH_MS = 500L

/**
 * The whole of the trigger's behavior, as a function of the mode, whether an
 * inventory is running, and how long the trigger was down. Keeping it pure is
 * the point: the three modes are fiddly, and nobody wants to hold a sled to
 * find out whether a latch works.
 *
 * `heldMs` matters only for a RELEASED event in latch mode; pass 0 otherwise.
 */
fun nextTriggerAction(mode: RfidTriggerMode, event: TriggerEvent, reading: Boolean, heldMs: Long): TriggerAction =
    when (mode) {
        RfidTriggerMode.HOLD -> when {
            event == TriggerEvent.PRESSED && !reading -> TriggerAction.START
            event == TriggerEvent.RELEASED && reading -> TriggerAction.STOP
            else -> TriggerAction.NONE
        }
        RfidTriggerMode.TOGGLE -> when {
            event == TriggerEvent.RELEASED -> TriggerAction.NONE
            reading -> TriggerAction.STOP
            else -> TriggerAction.START
        }
        RfidTriggerMode.HOLD_OR_LATCH -> when {
            event == TriggerEvent.PRESSED && !reading -> TriggerAction.START
            // A press while it is reading always ends a latched read.
            event == TriggerEvent.PRESSED -> TriggerAction.STOP
            // Released: a quick click latches, a real hold ends.
            reading && heldMs < LATCH_MS -> TriggerAction.NONE
            reading -> TriggerAction.STOP
            else -> TriggerAction.NONE
        }
    }
```

- [ ] **Step 4: Run the test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.rfid.RfidTriggerTest'
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): the RFD40 trigger's three modes as a pure state machine

Hold, hold-or-latch, and toggle, decided from the mode, whether an inventory
is running, and how long the trigger was down. Pure because the latch boundary
is fiddly and nobody should need a sled in hand to test it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The read session and what a burst queues

**Files:**
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidReadSession.kt`
- Create: `Android_Kiosk_App/app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidBurst.kt`
- Test: `Android_Kiosk_App/app/src/test/java/com/serversherpa/kiosk/core/rfid/RfidReadSessionTest.kt`

**Interfaces:**
- Consumes: `RepeatSweepPolicy` from Task 2, `com.serversherpa.kiosk.core.scan.rfidKey`.
- Produces: `data class TagSighting(val epc: String, val key: String)`, `data class RfidReadSession(val startedAtMs: Long, val totalReads: Int, val tags: List<TagSighting>, val skippedRepeats: Int)` with `val uniqueCount: Int`, `fun startSession(nowMs: Long): RfidReadSession`, `fun onTagRead(session: RfidReadSession, rawEpc: String, alreadyQueued: Set<String>, policy: RepeatSweepPolicy): RfidReadSession`, `fun burstToScans(session: RfidReadSession): List<String>`, `fun queuedAfter(alreadyQueued: Set<String>, session: RfidReadSession): Set<String>`.

- [ ] **Step 1: Write the failing test**

Create `app/src/test/java/com/serversherpa/kiosk/core/rfid/RfidReadSessionTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Test

class RfidReadSessionTest {
    private fun read(s: RfidReadSession, epc: String, queued: Set<String> = emptySet(), policy: RepeatSweepPolicy = RepeatSweepPolicy.ALWAYS_QUEUE) =
        onTagRead(s, epc, queued, policy)

    @Test fun countsEveryReportButKeepsEachTagOnce() {
        var s = startSession(1_000)
        s = read(s, "100348"); s = read(s, "100349"); s = read(s, "100348")
        assertEquals(3, s.totalReads)
        assertEquals(2, s.uniqueCount)
        assertEquals(listOf("100348", "100349"), burstToScans(s))
    }

    /** One reader pads the EPC and another does not. They are the same tag. */
    @Test fun paddingDoesNotMakeASecondTag() {
        var s = startSession(0)
        s = read(s, "000000000000000000100348"); s = read(s, "100348")
        assertEquals(2, s.totalReads)
        assertEquals(1, s.uniqueCount)
        // The value queued is the EPC as it was first seen, not the stripped key.
        assertEquals(listOf("000000000000000000100348"), burstToScans(s))
    }

    @Test fun blankAndUnreadableValuesAreIgnoredEntirely() {
        var s = startSession(0)
        s = read(s, "   "); s = read(s, "")
        assertEquals(0, s.totalReads)
        assertEquals(0, s.uniqueCount)
    }

    @Test fun alwaysQueueKeepsATagThisScreenAlreadySent() {
        var s = startSession(0)
        s = read(s, "100348", queued = setOf("100348"), policy = RepeatSweepPolicy.ALWAYS_QUEUE)
        assertEquals(1, s.uniqueCount)
        assertEquals(0, s.skippedRepeats)
    }

    @Test fun skipPoliciesDropATagThisScreenAlreadySentAndCountIt() {
        for (policy in listOf(RepeatSweepPolicy.SKIP_SILENT, RepeatSweepPolicy.SKIP_AND_COUNT)) {
            var s = startSession(0)
            s = read(s, "100348", queued = setOf("100348"), policy = policy)
            s = read(s, "100349", queued = setOf("100348"), policy = policy)
            assertEquals(policy.name, 2, s.totalReads)
            assertEquals(policy.name, 1, s.uniqueCount)
            assertEquals(policy.name, 1, s.skippedRepeats)
            assertEquals(policy.name, listOf("100349"), burstToScans(s))
        }
    }

    /** A repeat inside one burst is not a "skipped repeat" — it is the same
     *  tag answering twice, which is what a reader does. */
    @Test fun aRepeatWithinTheBurstIsNotCountedAsSkipped() {
        var s = startSession(0)
        s = read(s, "100348", policy = RepeatSweepPolicy.SKIP_AND_COUNT)
        s = read(s, "100348", policy = RepeatSweepPolicy.SKIP_AND_COUNT)
        assertEquals(0, s.skippedRepeats)
        assertEquals(1, s.uniqueCount)
    }

    @Test fun whatIsQueuedCarriesForwardToTheNextBurst() {
        var s = startSession(0)
        s = read(s, "100348"); s = read(s, "0100349")
        assertEquals(setOf("9000", "100348", "100349"), queuedAfter(setOf("9000"), s))
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.rfid.RfidReadSessionTest'
```

Expected: FAIL to compile, `Unresolved reference: startSession`.

- [ ] **Step 3: Write the session**

Create `app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidReadSession.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

import com.serversherpa.kiosk.core.scan.rfidKey

/** One tag as the burst saw it: the EPC to queue, and the key to compare by. */
data class TagSighting(val epc: String, val key: String)

/**
 * One pull of the trigger. `totalReads` counts every report the reader made,
 * including the same tag answering repeatedly, so an operator can tell a thin
 * read from a chatty one. `tags` holds each tag once, in the order it first
 * appeared. `skippedRepeats` counts tags dropped because this screen already
 * queued them.
 */
data class RfidReadSession(
    val startedAtMs: Long,
    val totalReads: Int = 0,
    val tags: List<TagSighting> = emptyList(),
    val skippedRepeats: Int = 0,
) {
    val uniqueCount: Int get() = tags.size
}

fun startSession(nowMs: Long): RfidReadSession = RfidReadSession(startedAtMs = nowMs)

/**
 * Fold one tag report into the session.
 *
 * `alreadyQueued` is the set of keys this visit to the screen has already put
 * in the outbox. Under ALWAYS_QUEUE it is ignored: a second sweep of a rack is
 * a second scan, the same as pulling a barcode trigger twice.
 */
fun onTagRead(
    session: RfidReadSession,
    rawEpc: String,
    alreadyQueued: Set<String>,
    policy: RepeatSweepPolicy,
): RfidReadSession {
    val key = rfidKey(rawEpc) ?: return session
    val counted = session.copy(totalReads = session.totalReads + 1)
    // The same tag answering again inside this burst is normal, not a repeat sweep.
    if (counted.tags.any { it.key == key }) return counted
    if (policy != RepeatSweepPolicy.ALWAYS_QUEUE && key in alreadyQueued) {
        return counted.copy(skippedRepeats = counted.skippedRepeats + 1)
    }
    return counted.copy(tags = counted.tags + TagSighting(rawEpc.trim(), key))
}
```

- [ ] **Step 4: Write the burst helpers**

Create `app/src/main/java/com/serversherpa/kiosk/core/rfid/RfidBurst.kt`:

```kotlin
package com.serversherpa.kiosk.core.rfid

/**
 * What a finished burst puts in the outbox: each tag once, in the order it was
 * first seen, as the EPC the reader reported. The repeat policy has already
 * been applied while the tags arrived, so there is nothing left to filter.
 */
fun burstToScans(session: RfidReadSession): List<String> = session.tags.map { it.epc }

/** The queued-key set to carry into the next burst on this screen. */
fun queuedAfter(alreadyQueued: Set<String>, session: RfidReadSession): Set<String> =
    alreadyQueued + session.tags.map { it.key }
```

- [ ] **Step 5: Run the test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.rfid.RfidReadSessionTest'
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Prove the core is still pure and the app builds**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest assembleDebug
```

Expected: BUILD SUCCESSFUL, including `CorePurityTest`.

- [ ] **Step 7: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "feat(android): the RFID read session and what a burst queues

A burst counts every report but keeps each tag once, keyed the same way the
roster match keys it so a padding reader and a non-padding one agree. The
repeat-sweep policy is applied as tags arrive, so a finished burst is simply
its tags in the order they were first seen.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
