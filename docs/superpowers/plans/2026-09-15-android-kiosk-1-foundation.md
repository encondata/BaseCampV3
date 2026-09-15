# Android Kiosk Implementation Plan — Part 1 of 4: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the empty Android Studio scaffold into a buildable `com.serversherpa.kiosk` app with the portal's look and the whole Android-free `core/` logic layer (matching, RFID, people search, outbox state machine, settings) ported from the web kiosk and unit-tested, plus the DataStore-backed config, identity, and preference stores.

**Architecture:** One Gradle module `app`. `core/` is pure Kotlin (no `android.*`/`androidx.*` imports, enforced by a test) and mirrors `kiosk/src/lib/*.ts` function for function. `data/` wraps DataStore. `ui/theme` restates the portal's CSS tokens. Parts 2–4 (`2026-09-15-android-kiosk-2-data-and-input.md`, `-3-shell-and-login.md`, `-4-feature-screens.md`) build on the interfaces this part produces.

**Tech Stack:** Kotlin 2.0.21, AGP 8.13.2, Jetpack Compose (BOM 2024.09.00, Material 3), kotlinx.serialization 1.7.3, DataStore 1.1.7, Room 2.6.1 (KSP), OkHttp 4.12.0, CameraX 1.4.2, ML Kit barcode 17.3.0, JUnit 4, Robolectric 4.14.1, MockWebServer.

**Spec:** `docs/superpowers/specs/2026-09-15-android-kiosk-design.md`. The web kiosk being ported lives at `kiosk/src/` in this same worktree; read the matching `.ts` file whenever a rule is unclear — the TypeScript is the reference implementation.

## Global Constraints

- Worktree: `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/android-kiosk`, branch `android-kiosk`. All paths below are relative to `Android_Kiosk_App/` inside it unless they start with `docs/` or `portal/` or `kiosk/`.
- Every Gradle command needs the Android Studio JDK: `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` first. `local.properties` already points `sdk.dir` at `/Users/jrh1812/Library/Android/sdk`. Run Gradle from `Android_Kiosk_App/` (`./gradlew …`). The first build downloads dependencies (minutes); later builds are fast with the daemon.
- Package `com.serversherpa.kiosk`; `minSdk 30`, `targetSdk 36`, `compileSdk 36`. Never raise minSdk.
- `core/` (package `com.serversherpa.kiosk.core`) must not import `android.*` or `androidx.*`. `java.*`, `kotlin.*`, `kotlinx.*` are fine.
- JSON field names are the server's snake_case names, verbatim (`SessionOut`, `HeartbeatIn`, … in `api/src/serversherpa/api/schemas.py`). Every `@Serializable` model that is decoded must tolerate unknown keys (the shared `Json` instance sets `ignoreUnknownKeys = true`).
- American English in every string, comment, and doc (color, customize, enroll).
- Copy for the person at the kiosk is the web kiosk's copy, verbatim, unless the spec says otherwise.
- Commit after every task with the message given; end every commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Tests: JVM unit tests under `app/src/test/java/...`. Robolectric tests carry `@RunWith(RobolectricTestRunner::class)` and `@Config(sdk = [34])`. Run a single class with `./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.ScanMatchTest'`; run everything with `./gradlew testDebugUnitTest`. A task is not done until its tests pass AND `./gradlew assembleDebug` succeeds.

---

### Task 1: Retarget the scaffold (package, SDK levels, dependency catalog)

The scaffold as generated does not build: Android Studio pinned `androidx.core 1.19.0`, `lifecycle 2.11.0`, and `activity-compose 1.13.0`, which require compileSdk 37 and AGP 9.1 (neither installed). This task pins a catalog that was verified to build and test on this Mac on 2026-09-15.

**Files:**
- Modify: `gradle/libs.versions.toml` (replace whole file)
- Modify: `build.gradle.kts` (replace whole file)
- Modify: `app/build.gradle.kts` (replace whole file)
- Modify: `app/src/main/AndroidManifest.xml`
- Move: `app/src/main/java/com/example/serversherpakiosk/**` → `app/src/main/java/com/serversherpa/kiosk/**`
- Delete: `app/src/test/java/com/example/serversherpakiosk/ExampleUnitTest.kt`, `app/src/androidTest/**`
- Create: `app/src/test/resources/robolectric.properties`
- Create: `app/src/test/java/com/serversherpa/kiosk/BuildConfigTest.kt`

**Interfaces:**
- Produces: `BuildConfig.DEFAULT_API_URL`, `BuildConfig.DEFAULT_PORTAL_URL`, `BuildConfig.KIOSK_VERSION` (all `String`); the version catalog aliases used by every later task (`libs.androidx.room.runtime`, `libs.okhttp`, …).

- [ ] **Step 1: Replace the version catalog**

Write `gradle/libs.versions.toml`:

```toml
[versions]
agp = "8.13.2"
kotlin = "2.0.21"
ksp = "2.0.21-1.0.28"
coreKtx = "1.16.0"
junit = "4.13.2"
junitVersion = "1.2.1"
espressoCore = "3.6.1"
lifecycle = "2.9.2"
activityCompose = "1.10.1"
composeBom = "2024.09.00"
navigationCompose = "2.8.9"
datastore = "1.1.7"
room = "2.6.1"
okhttp = "4.12.0"
serialization = "1.7.3"
coroutines = "1.9.0"
securityCrypto = "1.1.0-alpha06"
camerax = "1.4.2"
mlkitBarcode = "17.3.0"
zxing = "3.5.3"
robolectric = "4.14.1"

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "coreKtx" }
junit = { group = "junit", name = "junit", version.ref = "junit" }
androidx-junit = { group = "androidx.test.ext", name = "junit", version.ref = "junitVersion" }
androidx-espresso-core = { group = "androidx.test.espresso", name = "espresso-core", version.ref = "espressoCore" }
androidx-lifecycle-runtime-ktx = { group = "androidx.lifecycle", name = "lifecycle-runtime-ktx", version.ref = "lifecycle" }
androidx-lifecycle-viewmodel-compose = { group = "androidx.lifecycle", name = "lifecycle-viewmodel-compose", version.ref = "lifecycle" }
androidx-lifecycle-runtime-compose = { group = "androidx.lifecycle", name = "lifecycle-runtime-compose", version.ref = "lifecycle" }
androidx-lifecycle-process = { group = "androidx.lifecycle", name = "lifecycle-process", version.ref = "lifecycle" }
androidx-activity-compose = { group = "androidx.activity", name = "activity-compose", version.ref = "activityCompose" }
androidx-compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "composeBom" }
androidx-compose-ui = { group = "androidx.compose.ui", name = "ui" }
androidx-compose-ui-graphics = { group = "androidx.compose.ui", name = "ui-graphics" }
androidx-compose-ui-tooling = { group = "androidx.compose.ui", name = "ui-tooling" }
androidx-compose-ui-tooling-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
androidx-compose-ui-test-manifest = { group = "androidx.compose.ui", name = "ui-test-manifest" }
androidx-compose-ui-test-junit4 = { group = "androidx.compose.ui", name = "ui-test-junit4" }
androidx-compose-material3 = { group = "androidx.compose.material3", name = "material3" }
androidx-navigation-compose = { group = "androidx.navigation", name = "navigation-compose", version.ref = "navigationCompose" }
androidx-datastore-preferences = { group = "androidx.datastore", name = "datastore-preferences", version.ref = "datastore" }
androidx-room-runtime = { group = "androidx.room", name = "room-runtime", version.ref = "room" }
androidx-room-ktx = { group = "androidx.room", name = "room-ktx", version.ref = "room" }
androidx-room-compiler = { group = "androidx.room", name = "room-compiler", version.ref = "room" }
androidx-room-testing = { group = "androidx.room", name = "room-testing", version.ref = "room" }
androidx-security-crypto = { group = "androidx.security", name = "security-crypto", version.ref = "securityCrypto" }
androidx-camera-core = { group = "androidx.camera", name = "camera-core", version.ref = "camerax" }
androidx-camera-camera2 = { group = "androidx.camera", name = "camera-camera2", version.ref = "camerax" }
androidx-camera-lifecycle = { group = "androidx.camera", name = "camera-lifecycle", version.ref = "camerax" }
androidx-camera-view = { group = "androidx.camera", name = "camera-view", version.ref = "camerax" }
mlkit-barcode-scanning = { group = "com.google.mlkit", name = "barcode-scanning", version.ref = "mlkitBarcode" }
zxing-core = { group = "com.google.zxing", name = "core", version.ref = "zxing" }
okhttp = { group = "com.squareup.okhttp3", name = "okhttp", version.ref = "okhttp" }
okhttp-logging = { group = "com.squareup.okhttp3", name = "logging-interceptor", version.ref = "okhttp" }
okhttp-mockwebserver = { group = "com.squareup.okhttp3", name = "mockwebserver", version.ref = "okhttp" }
kotlinx-serialization-json = { group = "org.jetbrains.kotlinx", name = "kotlinx-serialization-json", version.ref = "serialization" }
kotlinx-coroutines-android = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-android", version.ref = "coroutines" }
kotlinx-coroutines-test = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-test", version.ref = "coroutines" }
robolectric = { group = "org.robolectric", name = "robolectric", version.ref = "robolectric" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
ksp = { id = "com.google.devtools.ksp", version.ref = "ksp" }
```

- [ ] **Step 2: Replace the two Gradle build files**

`build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
}
```

`app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.serversherpa.kiosk"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.serversherpa.kiosk"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "KIOSK_VERSION", "\"$versionName\"")
        buildConfigField("String", "DEFAULT_PORTAL_URL", "\"https://portal.dev.serversherpa.com\"")
    }

    buildTypes {
        debug {
            buildConfigField("String", "DEFAULT_API_URL", "\"https://api.dev.serversherpa.com\"")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("String", "DEFAULT_API_URL", "\"https://api.serversherpa.com\"")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions { jvmTarget = "11" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.isReturnDefaultValues = true
    }
}

ksp { arg("room.generateKotlin", "true") }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.zxing.core)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.room.testing)
    testImplementation(libs.androidx.junit)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
```

- [ ] **Step 3: Move the sources to the new package and drop the example tests**

```bash
cd Android_Kiosk_App
mkdir -p app/src/main/java/com/serversherpa/kiosk
git mv app/src/main/java/com/example/serversherpakiosk/MainActivity.kt app/src/main/java/com/serversherpa/kiosk/MainActivity.kt
git mv app/src/main/java/com/example/serversherpakiosk/ui app/src/main/java/com/serversherpa/kiosk/ui
git rm -r -q app/src/test/java/com/example app/src/androidTest
rmdir -p app/src/main/java/com/example/serversherpakiosk 2>/dev/null || true
sed -i '' 's/com\.example\.serversherpakiosk/com.serversherpa.kiosk/g' app/src/main/java/com/serversherpa/kiosk/MainActivity.kt app/src/main/java/com/serversherpa/kiosk/ui/theme/*.kt
grep -rn "com.example" app/src || echo "no stale package references"
```

- [ ] **Step 4: Manifest permissions**

Replace `app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-feature android:name="android.hardware.camera.any" android:required="false" />

    <application
        android:allowBackup="false"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:usesCleartextTraffic="true"
        android:theme="@style/Theme.ServerSherpaKiosk">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:windowSoftInputMode="adjustResize"
            android:label="@string/app_name"
            android:theme="@style/Theme.ServerSherpaKiosk">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>
```

(`allowBackup=false`: the encrypted session must not ride into a device backup. Delete `app/src/main/res/xml/backup_rules.xml` and `data_extraction_rules.xml` since nothing references them now: `git rm app/src/main/res/xml/backup_rules.xml app/src/main/res/xml/data_extraction_rules.xml`.)

- [ ] **Step 5: Robolectric defaults and a smoke test**

`app/src/test/resources/robolectric.properties`:

```properties
sdk=34
```

`app/src/test/java/com/serversherpa/kiosk/BuildConfigTest.kt`:

```kotlin
package com.serversherpa.kiosk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildConfigTest {
    @Test fun debugDefaultsPointAtTheDevStack() {
        assertEquals("https://api.dev.serversherpa.com", BuildConfig.DEFAULT_API_URL)
        assertEquals("https://portal.dev.serversherpa.com", BuildConfig.DEFAULT_PORTAL_URL)
        assertTrue(BuildConfig.KIOSK_VERSION.isNotBlank())
    }
}
```

- [ ] **Step 6: Build and test**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
cd Android_Kiosk_App && ./gradlew assembleDebug testDebugUnitTest
```

Expected: `BUILD SUCCESSFUL`; `app/build/outputs/apk/debug/app-debug.apk` exists; 1 test passed. If `checkDebugAarMetadata` complains about compileSdk, a version in the catalog drifted — do not raise compileSdk; lower the offending library instead.

- [ ] **Step 7: Commit**

```bash
git add -A Android_Kiosk_App
git commit -m "chore(android): retarget scaffold to com.serversherpa.kiosk, minSdk 30, full dependency catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: App icon, fonts, and theme tokens

**Files:**
- Create: `tools/make_icons.py`
- Create: `app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`, `ic_launcher_round.xml` (replace the existing `mipmap-anydpi/` pair: `git rm -r app/src/main/res/mipmap-anydpi app/src/main/res/drawable/ic_launcher_background.xml app/src/main/res/drawable/ic_launcher_foreground.xml`)
- Create (generated): `app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher_foreground.png`, `ic_launcher.webp`, `ic_launcher_round.webp`
- Modify: `app/src/main/res/values/colors.xml` (add `ic_launcher_background`)
- Create: `app/src/main/res/font/geologica.ttf`, `fragment_mono.ttf`, `fragment_mono_italic.ttf`; `FONTS-LICENSE.md`
- Replace: `app/src/main/java/com/serversherpa/kiosk/ui/theme/Color.kt` → delete; create `Tokens.kt`, replace `Type.kt`, replace `Theme.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/ui/theme/TokensTest.kt`

**Interfaces:**
- Produces: `KioskColors` (data class of `Color`s), `LocalKioskColors`, `KioskTheme(theme: String, accent: String, content)`, `accentFor(name: String): Pair<Color, Color>` (accent, accentSoft), `ChipTone` enum + `chipColors(tone)`, `Geologica`, `FragmentMono` font families, `KioskTypography`.

- [ ] **Step 1: Icon generator script**

`tools/make_icons.py`:

```python
"""Generate the launcher icon set from the portal logo.

Usage (from Android_Kiosk_App/):  python3 tools/make_icons.py
Source: ../portal/public/images/serversherpa-logo.png (890x890 RGBA).
Writes the adaptive-icon foreground PNGs and the legacy square/round
webp icons for every density. The background is a flat color resource
(ic_launcher_background in values/colors.xml), so no background image is
written. Re-run this script to change the icon; never hand-edit the
generated files.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT.parent / "portal" / "public" / "images" / "serversherpa-logo.png"
RES = ROOT / "app" / "src" / "main" / "res"
BG = (241, 244, 247, 255)  # --paper-2

# density -> (adaptive canvas px for 108dp, legacy icon px for 48dp)
DENSITIES = {
    "mdpi": (108, 48), "hdpi": (162, 72), "xhdpi": (216, 96),
    "xxhdpi": (324, 144), "xxxhdpi": (432, 192),
}
SAFE_FRACTION = 66 / 108   # the adaptive safe zone is a 66dp circle


def fit_logo(logo: Image.Image, canvas_px: int, fraction: float) -> Image.Image:
    size = round(canvas_px * fraction)
    scaled = logo.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
    off = (canvas_px - size) // 2
    out.alpha_composite(scaled, (off, off))
    return out


def legacy(logo: Image.Image, px: int, round_mask: bool) -> Image.Image:
    base = Image.new("RGBA", (px, px), BG)
    base.alpha_composite(fit_logo(logo, px, 0.80))
    if round_mask:
        mask = Image.new("L", (px, px), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, px - 1, px - 1), fill=255)
        base.putalpha(mask)
    return base


def main() -> None:
    logo = Image.open(SRC).convert("RGBA")
    for density, (adaptive_px, legacy_px) in DENSITIES.items():
        d = RES / f"mipmap-{density}"
        d.mkdir(parents=True, exist_ok=True)
        fit_logo(logo, adaptive_px, SAFE_FRACTION).save(d / "ic_launcher_foreground.png")
        legacy(logo, legacy_px, False).save(d / "ic_launcher.webp", quality=95)
        legacy(logo, legacy_px, True).save(d / "ic_launcher_round.webp", quality=95)
    print("icons written")


if __name__ == "__main__":
    main()
```

Run it and wire the adaptive icon:

```bash
cd Android_Kiosk_App
git rm -r -q app/src/main/res/mipmap-anydpi app/src/main/res/drawable/ic_launcher_background.xml app/src/main/res/drawable/ic_launcher_foreground.xml
python3 tools/make_icons.py
mkdir -p app/src/main/res/mipmap-anydpi-v26
```

`app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml` (identical content):

```xml
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
```

`app/src/main/res/values/colors.xml` (replace):

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#F1F4F7</color>
    <color name="ink">#0C1117</color>
    <color name="paper">#FBFCFD</color>
</resources>
```

Also set the window background so the first frame is paper, in `app/src/main/res/values/themes.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.ServerSherpaKiosk" parent="android:Theme.Material.Light.NoActionBar">
        <item name="android:windowBackground">@color/paper</item>
        <item name="android:statusBarColor">@color/ink</item>
    </style>
</resources>
```

- [ ] **Step 2: Fonts**

```bash
cd Android_Kiosk_App
mkdir -p app/src/main/res/font
curl -sL -o app/src/main/res/font/geologica.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/geologica/Geologica%5BCRSV%2CSHRP%2Cslnt%2Cwght%5D.ttf"
curl -sL -o app/src/main/res/font/fragment_mono.ttf https://raw.githubusercontent.com/google/fonts/main/ofl/fragmentmono/FragmentMono-Regular.ttf
curl -sL -o app/src/main/res/font/fragment_mono_italic.ttf https://raw.githubusercontent.com/google/fonts/main/ofl/fragmentmono/FragmentMono-Italic.ttf
file app/src/main/res/font/*.ttf   # each must say "TrueType Font data"
```

(Copies of all three already sit in this session's scratchpad at `/private/tmp/claude-501/-Users-jrh1812-Developer-BaseCampV3/6009f08d-6939-4f83-8238-644d1b8f30e9/scratchpad/fonts/` if the network is down.)

`FONTS-LICENSE.md`:

```markdown
# Bundled fonts

- Geologica (variable) — Copyright 2023 The Geologica Project Authors, SIL Open Font License 1.1.
- Fragment Mono — Copyright 2022 The Fragment Mono Project Authors, SIL Open Font License 1.1.

Both from https://github.com/google/fonts (ofl/geologica, ofl/fragmentmono). The OFL text is at https://openfontlicense.org/open-font-license-official-text/.
```

- [ ] **Step 3: Tokens**

Delete `ui/theme/Color.kt`. Create `app/src/main/java/com/serversherpa/kiosk/ui/theme/Tokens.kt`:

```kotlin
package com.serversherpa.kiosk.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/** The portal's CSS tokens (portal/src/styles/portal-theme.css), restated
 *  by name so a Compose screen and a web screen read the same color. */
@Immutable
data class KioskColors(
    val ink: Color = Color(0xFF0C1117),
    val ink2: Color = Color(0xFF121925),
    val inkLine: Color = Color(0xFF243140),
    val snow: Color = Color(0xFFE8EDF4),
    val paper: Color,
    val paper2: Color,
    val paperLine: Color,
    val textDark: Color,
    val textMute: Color,
    val ok: Color = Color(0xFF3ECF8E),
    val accent: Color,
    val accentSoft: Color,
    val isDark: Boolean,
)

val LightPalette = KioskColors(
    paper = Color(0xFFFBFCFD), paper2 = Color(0xFFF1F4F7), paperLine = Color(0xFFE4E8EE),
    textDark = Color(0xFF1B2129), textMute = Color(0xFF667085),
    accent = Color(0xFFFFA12E), accentSoft = Color(0xFFFFC06B), isDark = false,
)

val DarkPalette = KioskColors(
    paper = Color(0xFF10151F), paper2 = Color(0xFF0B0F17), paperLine = Color(0x17FFFFFF),
    textDark = Color(0xFFE8EDF4), textMute = Color(0xFF8A97AA),
    accent = Color(0xFFFFA12E), accentSoft = Color(0xFFFFC06B), isDark = true,
)

/** `.portal-shell[data-accent=…]` — a named accent, or a custom #rrggbb
 *  (the soft variant of a custom color is the color itself at 70% white). */
fun accentFor(name: String): Pair<Color, Color> = when (name.trim().lowercase()) {
    "aqua" -> Color(0xFF35E0C8) to Color(0xFF6AF0DD)
    "blue" -> Color(0xFF4DD0FF) to Color(0xFF86E0FF)
    "violet" -> Color(0xFFA78BFA) to Color(0xFFC4B5FD)
    "pink" -> Color(0xFFFF6FAE) to Color(0xFFFF9EC9)
    "green" -> Color(0xFF3DDC84) to Color(0xFF74E8A8)
    else -> parseHex(name)?.let { it to lighten(it) } ?: (Color(0xFFFFA12E) to Color(0xFFFFC06B))
}

private fun parseHex(value: String): Color? {
    val v = value.trim().removePrefix("#")
    if (v.length != 6 || v.any { it.lowercaseChar() !in "0123456789abcdef" }) return null
    return Color(0xFF000000L or v.toLong(16))
}

private fun lighten(c: Color): Color = Color(
    red = c.red + (1f - c.red) * 0.3f,
    green = c.green + (1f - c.green) * 0.3f,
    blue = c.blue + (1f - c.blue) * 0.3f,
)

/** The portal's `.chip.c-*` tones: text color, background, border. */
enum class ChipTone(val text: Color, val bg: Color, val border: Color) {
    GREEN(Color(0xFF3DDC84), Color(0x1F3DDC84), Color(0x403DDC84)),
    AMBER(Color(0xFFFFB84D), Color(0x1FFFB84D), Color(0x40FFB84D)),
    RED(Color(0xFFFF5D6C), Color(0x1FFF5D6C), Color(0x40FF5D6C)),
    BLUE(Color(0xFF4DD0FF), Color(0x1F4DD0FF), Color(0x404DD0FF)),
    VIOLET(Color(0xFFA78BFA), Color(0x1FA78BFA), Color(0x40A78BFA)),
    AQUA(Color(0xFF35E0C8), Color(0x1F35E0C8), Color(0x4035E0C8)),
    SLATE(Color(0xFF8A97AA), Color(0x1F8A97AA), Color(0x408A97AA)),
}

val LocalKioskColors = staticCompositionLocalOf { LightPalette }
```

- [ ] **Step 4: Typography**

Replace `app/src/main/java/com/serversherpa/kiosk/ui/theme/Type.kt`:

```kotlin
package com.serversherpa.kiosk.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.serversherpa.kiosk.R

// FontVariation on a resource Font is still @ExperimentalTextApi in this Compose version.
@OptIn(ExperimentalTextApi::class)
private fun geologica(weight: FontWeight) = Font(
    R.font.geologica, weight = weight,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
)

/** `--font-display`: Geologica (variable), the weights the portal loads. */
val Geologica = FontFamily(
    geologica(FontWeight.Light), geologica(FontWeight.Normal), geologica(FontWeight.Medium),
    geologica(FontWeight.SemiBold), geologica(FontWeight.ExtraBold),
)

/** `--font-mono`: Fragment Mono. */
val FragmentMono = FontFamily(
    Font(R.font.fragment_mono, weight = FontWeight.Normal),
    Font(R.font.fragment_mono_italic, weight = FontWeight.Normal, style = FontStyle.Italic),
)

val KioskTypography = Typography(
    displaySmall = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.SemiBold, fontSize = 28.sp),
    headlineSmall = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.SemiBold, fontSize = 22.sp),
    titleLarge = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
    titleMedium = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    bodyLarge = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.Normal, fontSize = 16.sp),
    bodyMedium = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.Normal, fontSize = 14.sp),
    bodySmall = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.Normal, fontSize = 12.sp),
    labelLarge = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelMedium = TextStyle(fontFamily = FragmentMono, fontSize = 12.sp, letterSpacing = 0.5.sp),
    labelSmall = TextStyle(fontFamily = FragmentMono, fontSize = 11.sp, letterSpacing = 1.sp),
)
```

- [ ] **Step 5: Theme**

Replace `app/src/main/java/com/serversherpa/kiosk/ui/theme/Theme.kt`:

```kotlin
package com.serversherpa.kiosk.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember

/**
 * The kiosk's theme. `theme` and `accent` are the signed-in person's
 * `preferences.theme` ("light" | "dark"; anything else follows the OS)
 * and `preferences.accent` (a named accent or #rrggbb), exactly what the
 * portal's applyPreferences() stamps on `.portal-shell`.
 */
@Composable
fun KioskTheme(theme: String = "light", accent: String = "amber", content: @Composable () -> Unit) {
    val systemDark = isSystemInDarkTheme()
    val dark = when (theme) { "dark" -> true; "light" -> false; else -> systemDark }
    val colors = remember(dark, accent) {
        val (a, soft) = accentFor(accent)
        (if (dark) DarkPalette else LightPalette).copy(accent = a, accentSoft = soft)
    }
    val scheme = if (dark) darkColorScheme(
        primary = colors.accent, onPrimary = colors.ink, background = colors.paper2,
        onBackground = colors.textDark, surface = colors.paper, onSurface = colors.textDark,
        surfaceVariant = colors.paper2, onSurfaceVariant = colors.textMute, outline = colors.paperLine,
    ) else lightColorScheme(
        primary = colors.accent, onPrimary = colors.ink, background = colors.paper2,
        onBackground = colors.textDark, surface = colors.paper, onSurface = colors.textDark,
        surfaceVariant = colors.paper2, onSurfaceVariant = colors.textMute, outline = colors.paperLine,
    )
    CompositionLocalProvider(LocalKioskColors provides colors) {
        MaterialTheme(colorScheme = scheme, typography = KioskTypography, content = content)
    }
}
```

Then fix `MainActivity.kt` so it still compiles: replace every `ServerSherpaKioskTheme` with `KioskTheme` (the greeting placeholder stays until Part 3 replaces the activity).

- [ ] **Step 6: Test**

`app/src/test/java/com/serversherpa/kiosk/ui/theme/TokensTest.kt`:

```kotlin
package com.serversherpa.kiosk.ui.theme

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TokensTest {
    @Test fun namedAccents() {
        assertEquals(Color(0xFF35E0C8), accentFor("aqua").first)
        assertEquals(Color(0xFF6AF0DD), accentFor("aqua").second)
        assertEquals(Color(0xFF3DDC84), accentFor("GREEN").first)
    }

    @Test fun customHexAccent() {
        assertEquals(Color(0xFF123456), accentFor("#123456").first)
    }

    @Test fun unknownFallsBackToAmber() {
        assertEquals(Color(0xFFFFA12E), accentFor("mauve").first)
        assertEquals(Color(0xFFFFA12E), accentFor("#12").first)
    }
}
```

- [ ] **Step 7: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.ui.theme.TokensTest' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): adaptive launcher icon from the portal logo, bundled Geologica/Fragment Mono, portal color tokens and theme

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `core/` models, feature registry, setup state, settings tabs, access helpers, purity guardrail

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/core/ApiError.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/core/model/Session.kt`, `Kiosk.kt`, `Sync.kt`, `Scans.kt`, `Timeclock.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/core/features/Features.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/core/setup/SetupState.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/core/settings/SettingsTabs.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/core/access/Access.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/core/devices/Registration.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/core/CorePurityTest.kt`, `core/features/FeaturesTest.kt`, `core/settings/SettingsTabsTest.kt`, `core/access/AccessTest.kt`, `core/devices/RegistrationTest.kt`, `core/model/ModelsJsonTest.kt`

**Interfaces:**
- Produces (used by every later task): the `@Serializable` models below with the server's field names; `ApiError(status, code, detail)`; `FeatureId`, `KioskFeature`, `FEATURES`, `featureAvailable`, `featureForRoute`; `SetupState`; `SettingsTabId`, `SettingsTab`, `SETTINGS_TABS`, `visibleTabs`; `computeCan`, `ADMIN_RANK`; `RegistrationState`, `tokenExpiryState`, `registrationLabel`.

- [ ] **Step 1: Purity test (write first — it fails until the package exists)**

`app/src/test/java/com/serversherpa/kiosk/core/CorePurityTest.kt`:

```kotlin
package com.serversherpa.kiosk.core

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** core/ is the layer the iOS app will transliterate: no Android in it. */
class CorePurityTest {
    @Test fun coreImportsNothingFromAndroid() {
        val root = File("src/main/java/com/serversherpa/kiosk/core")
        assertTrue("core/ package missing at ${root.absolutePath}", root.isDirectory)
        val offenders = root.walkTopDown().filter { it.extension == "kt" }.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line ->
                val t = line.trim()
                if (t.startsWith("import android") || t.startsWith("import androidx")) "${file.name}:${i + 1}: $t" else null
            }
        }.toList()
        assertTrue("Android imports in core/:\n${offenders.joinToString("\n")}", offenders.isEmpty())
    }
}
```

Run: `./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.CorePurityTest'` → FAIL ("core/ package missing").

- [ ] **Step 2: ApiError and models**

`core/ApiError.kt`:

```kotlin
package com.serversherpa.kiosk.core

import kotlinx.serialization.json.JsonElement

/** A non-2xx answer (`code` from the body's `detail.code`, else
 *  `unknown_error`) or a transport failure (`status` 0, code `network`). */
class ApiError(val status: Int, val code: String, val detail: JsonElement? = null) : Exception(code) {
    val isNetwork: Boolean get() = status == 0
    /** `detail.<key>` when the detail is an object with a string there. */
    fun detailString(key: String): String? =
        (detail as? kotlinx.serialization.json.JsonObject)?.get(key)
            ?.let { it as? kotlinx.serialization.json.JsonPrimitive }?.takeIf { it.isString }?.content
}
```

`core/model/Session.kt`:

```kotlin
package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable
data class PersonOut(
    val id: String,
    val first_name: String,
    val last_name: String,
    val preferred_name: String? = null,
    val display_name: String,
    val email: String? = null,
    val job_title: String? = null,
    val avatar_url: String? = null,
)

/** The two preferences the kiosk honors; the rest are ignored on decode. */
@Serializable
data class UiPreferences(val accent: String = "amber", val theme: String = "light")

/** `SessionOut` — what /auth/login, /auth/refresh, and an approved pair poll return. */
@Serializable
data class SessionData(
    val access_token: String,
    val expires_in: Int,
    val session_expires_at: String,
    val person: PersonOut,
    val roles: List<String> = emptyList(),
    val must_change_password: Boolean = false,
    val preferences: UiPreferences = UiPreferences(),
    val perms: Map<String, Map<String, Boolean>> = emptyMap(),
    val max_rank: Int = 0,
)

@Serializable
data class LoginIn(val email: String, val password: String, val client: String = "kiosk")

@Serializable
data class SystemStatus(
    val read_only: Boolean = false,
    val read_only_message: String = "",
    val workers_paused: Boolean = false,
    val banner: String? = null,
)
```

`core/model/Kiosk.kt`:

```kotlin
package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable data class PairCreateIn(val serial: String, val name: String)

@Serializable
data class PairCreated(val code: String, val poll_token: String, val link_url: String, val expires_at: String)

@Serializable data class PairPollIn(val poll_token: String)

enum class PairStatus { PENDING, APPROVED, DENIED, EXPIRED;
    companion object { fun fromWire(s: String) = entries.firstOrNull { it.name.equals(s, true) } ?: EXPIRED }
}

@Serializable data class PairPollOut(val status: String, val session: SessionData? = null)

data class PairPoll(val status: PairStatus, val session: SessionData?)

@Serializable
data class HeartbeatIn(
    val serial: String,
    val name: String,
    val mode: String = "android",
    val version: String? = null,
    val raw_info: Map<String, String> = emptyMap(),
    val sign_in: Boolean = false,
    val login_method: String? = null,
)

@Serializable
data class HeartbeatResult(
    val device_id: String,
    val name: String,
    val registration: String,
    val token_expires_at: String? = null,
)

@Serializable data class KioskSignOutIn(val serial: String)

@Serializable data class SetupOptionSite(val id: String, val name: String)

@Serializable
data class SetupOptionInitiative(
    val id: String,
    val name: String,
    val status: String,
    val status_label: String,
    val client_name: String? = null,
    val scheduled_start: String? = null,
    val scheduled_end: String? = null,
    val source_site: SetupOptionSite? = null,
    val destination_site: SetupOptionSite? = null,
)

@Serializable data class SetupOptionScanType(val key: String, val label: String, val color: String)

@Serializable
data class SetupOptions(
    val initiatives: List<SetupOptionInitiative> = emptyList(),
    val scan_types: List<SetupOptionScanType> = emptyList(),
)

@Serializable
data class KioskSetupIn(val serial: String, val initiative_id: String, val site_id: String, val scan_status: String)

@Serializable
data class KioskSetupResult(
    val device_id: String,
    val initiative_id: String,
    val initiative_name: String,
    val site_id: String,
    val site_name: String,
    val site_role: String,
    val scan_status: String,
    val scan_status_label: String,
)

/** What Kiosk Setup saved on this kiosk (DataStore JSON). */
@Serializable
data class KioskSetupSelection(
    val initiativeId: String,
    val initiativeName: String,
    val siteId: String,
    val siteName: String,
    val siteRole: String,
    val scanStatus: String,
    val scanLabel: String,
)
```

`core/model/Sync.kt`:

```kotlin
package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable
data class KioskAssetRow(
    val id: String,
    val asset_id: String = "",
    val name: String? = null,
    val rfid: String? = null,
    val serial_number: String? = null,
    val make: String? = null,
    val model: String? = null,
    val make_model: String = "",
    val container_id: String? = null,
    val label: Map<String, String> = emptyMap(),
)

@Serializable
data class KioskAssetsSync(
    val initiative_id: String, val initiative_name: String, val generated_at: String,
    val assets: List<KioskAssetRow> = emptyList(),
)

@Serializable
data class KioskPersonRow(
    val id: String,
    val display_name: String,
    val first_name: String = "",
    val last_name: String = "",
    val preferred_name: String? = null,
    val rfid_tag: String? = null,
    val is_worker: Boolean = false,
    val has_account: Boolean = false,
)

@Serializable data class KioskPeopleSync(val generated_at: String, val people: List<KioskPersonRow> = emptyList())

@Serializable
data class KioskContainerRow(
    val id: String, val name: String, val rfid_tag: String? = null, val label_tag: String? = null,
    val container_type: String? = null, val status: String = "", val status_label: String = "",
    val site_id: String? = null, val site_name: String? = null, val asset_count: Int = 0,
)

@Serializable
data class KioskContainersSync(
    val initiative_id: String, val generated_at: String, val containers: List<KioskContainerRow> = emptyList(),
)

@Serializable
data class KioskTruckRow(
    val id: String, val name: String, val load_number: String? = null, val status: String = "",
    val status_label: String = "", val driver_name: String? = null,
    val start_site_id: String? = null, val start_site_name: String? = null,
    val end_site_id: String? = null, val end_site_name: String? = null, val container_count: Int = 0,
)

@Serializable
data class KioskTrucksSync(val initiative_id: String, val generated_at: String, val trucks: List<KioskTruckRow> = emptyList())
```

`core/model/Scans.kt`:

```kotlin
package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable
data class KioskScanIn(
    val client_scan_id: String,
    val scanned_value: String,
    val scan_type: String,
    val scanned_at: String,
    val asset_id: String? = null,
    val site_id: String? = null,
    val initiative_id: String? = null,
    val scan_status: String? = null,
)

@Serializable data class KioskScanBatchIn(val serial: String, val scans: List<KioskScanIn>)

@Serializable data class KioskScanRejected(val client_scan_id: String, val code: String)

@Serializable
data class KioskScanBatchOut(val accepted: List<String> = emptyList(), val rejected: List<KioskScanRejected> = emptyList())

@Serializable
data class KioskRfidEnrollIn(
    val serial: String,
    val rfid_tag: String,
    val scan_status: String,
    val client_scan_id: String,
    val site_id: String? = null,
    val initiative_id: String? = null,
)

@Serializable
data class KioskRfidEnroll(
    val asset_id: String,
    val asset_name: String? = null,
    val asset_tag: String = "",
    val serial_number: String? = null,
    val rfid_tag: String,
    val already_had_tag: Boolean = false,
)
```

`core/model/Timeclock.kt`:

```kotlin
package com.serversherpa.kiosk.core.model

import kotlinx.serialization.Serializable

@Serializable
data class KioskTimeclockPerson(
    val id: String, val display_name: String, val first_name: String = "", val last_name: String = "",
    val preferred_name: String? = null, val avatar_url: String? = null, val rfid_tag: String? = null,
)

@Serializable
data class KioskTimeclockEntry(
    val id: String, val started_at: String, val initiative_id: String? = null, val initiative_name: String? = null,
    val site_id: String? = null, val site_name: String? = null,
)

@Serializable
data class KioskTimeclockLastEntry(val id: String, val started_at: String, val ended_at: String, val minutes: Int)

@Serializable
data class KioskTimeclockStatus(
    val person: KioskTimeclockPerson,
    val clocked_in: Boolean,
    val entry: KioskTimeclockEntry? = null,
    val last_entry: KioskTimeclockLastEntry? = null,
)

@Serializable
data class ClockInIn(val serial: String, val person_id: String, val site_id: String? = null, val initiative_id: String? = null)

@Serializable data class ClockOutIn(val serial: String, val person_id: String)
```

- [ ] **Step 3: Features, setup state, settings tabs, access, registration**

`core/setup/SetupState.kt`:

```kotlin
package com.serversherpa.kiosk.core.setup

/** `kiosk_setup_complete` — kiosk-local; default INCOMPLETE. */
enum class SetupState(val wire: String, val label: String) {
    INCOMPLETE("incomplete", "Incomplete"), COMPLETE("complete", "Complete"), FAILED("failed", "Failed");

    val isComplete: Boolean get() = this == COMPLETE

    companion object {
        fun fromWire(s: String?): SetupState = entries.firstOrNull { it.wire == s } ?: INCOMPLETE
    }
}
```

`core/features/Features.kt`:

```kotlin
package com.serversherpa.kiosk.core.features

import com.serversherpa.kiosk.core.setup.SetupState

enum class FeatureId { SETUP, SCAN, ENROLL, CONTAINERS, TRUCKS, LABELS, TIMECLOCK, SETTINGS }

/** One launcher tile / route. `placeholder` features open the generic
 *  "not available yet" page; `alwaysAvailable` ones ignore setup state. */
data class KioskFeature(
    val id: FeatureId,
    val route: String,
    val title: String,
    val blurb: String,
    val placeholder: Boolean = false,
    val alwaysAvailable: Boolean = false,
)

/** Same order and copy as kiosk/src/lib/features.ts. */
val FEATURES: List<KioskFeature> = listOf(
    KioskFeature(FeatureId.SETUP, "setup", "Kiosk Setup", "Set up this kiosk for a move.", alwaysAvailable = true),
    KioskFeature(FeatureId.SCAN, "scan", "Scanning", "Scan assets, containers, and badges."),
    KioskFeature(FeatureId.ENROLL, "enroll", "RFID Enroll", "Scan an asset, then scan its RFID tag."),
    KioskFeature(FeatureId.CONTAINERS, "containers", "Containers", "Pack and unpack containers by scanning.", placeholder = true),
    KioskFeature(FeatureId.TRUCKS, "trucks", "Trucks", "Load and unload trucks by scanning.", placeholder = true),
    KioskFeature(FeatureId.LABELS, "labels", "Label Printing", "Print asset and container labels.", placeholder = true),
    KioskFeature(FeatureId.TIMECLOCK, "timeclock", "Timeclock", "Clock in and out of a move."),
    KioskFeature(FeatureId.SETTINGS, "settings", "Settings", "Appearance, sound, devices, and more.", alwaysAvailable = true),
)

fun feature(id: FeatureId): KioskFeature = FEATURES.first { it.id == id }

/** The feature whose route the nav destination is (route may carry `?tab=`). */
fun featureForRoute(route: String?): KioskFeature? {
    val base = route?.substringBefore('?')?.substringBefore('/') ?: return null
    return FEATURES.firstOrNull { it.route == base }
}

/** Always for alwaysAvailable features or in dev mode; otherwise only once setup is complete. */
fun featureAvailable(feature: KioskFeature, setupState: SetupState, devMode: Boolean = false): Boolean =
    devMode || feature.alwaysAvailable || setupState.isComplete
```

`core/settings/SettingsTabs.kt`:

```kotlin
package com.serversherpa.kiosk.core.settings

enum class SettingsTabId(val wire: String) {
    APPEARANCE("appearance"), SOUND("sound"), DEVICES("devices"), THIS_KIOSK("this-kiosk"),
    ADMIN("admin"), DEVELOPER("developer");

    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

enum class TabRequirement { ADMIN, DEVELOPER }

data class SettingsTab(
    val id: SettingsTabId,
    val label: String,
    val blurb: String,
    val requires: TabRequirement? = null,
    /** Visible signed out. */
    val anon: Boolean = false,
)

val SETTINGS_TABS: List<SettingsTab> = listOf(
    SettingsTab(SettingsTabId.APPEARANCE, "Appearance", "Theme, accent, and text size for this kiosk."),
    SettingsTab(SettingsTabId.SOUND, "Sound", "Scan and alert sounds."),
    SettingsTab(SettingsTabId.DEVICES, "Devices", "Scanners, printers, and readers attached to this kiosk."),
    SettingsTab(SettingsTabId.THIS_KIOSK, "This Kiosk", "This kiosk's name, identity, and connection.", anon = true),
    SettingsTab(SettingsTabId.ADMIN, "Admin", "Kiosk administration.", requires = TabRequirement.ADMIN),
    SettingsTab(SettingsTabId.DEVELOPER, "Developer", "Diagnostics and developer tools.", requires = TabRequirement.DEVELOPER),
)

val DEFAULT_TAB = SettingsTabId.APPEARANCE

fun visibleTabs(isAdmin: Boolean, isDeveloper: Boolean, signedIn: Boolean, tabs: List<SettingsTab> = SETTINGS_TABS): List<SettingsTab> {
    if (!signedIn) return tabs.filter { it.anon }
    return tabs.filter {
        when (it.requires) {
            TabRequirement.ADMIN -> isAdmin
            TabRequirement.DEVELOPER -> isDeveloper
            null -> true
        }
    }
}
```

`core/access/Access.kt`:

```kotlin
package com.serversherpa.kiosk.core.access

/** portal/src/lib/access.ts: rank 60 and up is admin client-side. */
const val ADMIN_RANK = 60

fun computeCan(perms: Map<String, Map<String, Boolean>>?, resource: String, action: String): Boolean =
    perms?.get(resource)?.get(action) == true
```

`core/devices/Registration.kt`:

```kotlin
package com.serversherpa.kiosk.core.devices

import java.time.Instant
import java.time.format.DateTimeParseException

enum class RegistrationState(val wire: String, val label: String) {
    OK("ok", "Registered"), SOON("soon", "Expires soon"), EXPIRED("expired", "Expired"), NONE("none", "Unregistered");

    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } ?: NONE }
}

/** portal/src/lib/devices.ts tokenExpiryState: ok > 7 d, soon ≤ 7 d, expired past, none null. */
const val SOON_MS: Long = 7L * 24 * 60 * 60 * 1000

fun tokenExpiryState(iso: String?, nowMs: Long = System.currentTimeMillis()): RegistrationState {
    if (iso.isNullOrBlank()) return RegistrationState.NONE
    val t = try { Instant.parse(iso).toEpochMilli() } catch (e: DateTimeParseException) { return RegistrationState.NONE }
    if (t <= nowMs) return RegistrationState.EXPIRED
    return if (t - nowMs <= SOON_MS) RegistrationState.SOON else RegistrationState.OK
}
```

- [ ] **Step 4: Tests**

`core/features/FeaturesTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.features

import com.serversherpa.kiosk.core.setup.SetupState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FeaturesTest {
    @Test fun orderMatchesTheWebKiosk() {
        assertEquals(listOf("setup", "scan", "enroll", "containers", "trucks", "labels", "timeclock", "settings"), FEATURES.map { it.route })
    }

    @Test fun onlySetupAndSettingsAreAlwaysAvailable() {
        assertEquals(setOf(FeatureId.SETUP, FeatureId.SETTINGS), FEATURES.filter { it.alwaysAvailable }.map { it.id }.toSet())
    }

    @Test fun placeholdersAreContainersTrucksLabels() {
        assertEquals(setOf(FeatureId.CONTAINERS, FeatureId.TRUCKS, FeatureId.LABELS), FEATURES.filter { it.placeholder }.map { it.id }.toSet())
    }

    @Test fun availabilityFollowsSetupStateUnlessDevMode() {
        val scan = feature(FeatureId.SCAN)
        assertFalse(featureAvailable(scan, SetupState.INCOMPLETE))
        assertFalse(featureAvailable(scan, SetupState.FAILED))
        assertTrue(featureAvailable(scan, SetupState.COMPLETE))
        assertTrue(featureAvailable(scan, SetupState.INCOMPLETE, devMode = true))
        assertTrue(featureAvailable(feature(FeatureId.SETTINGS), SetupState.INCOMPLETE))
    }

    @Test fun featureForRouteStripsQueryAndChildren() {
        assertEquals(FeatureId.SETTINGS, featureForRoute("settings?tab=admin")?.id)
        assertEquals(FeatureId.LABELS, featureForRoute("labels/printers")?.id)
        assertNull(featureForRoute("home"))
        assertNull(featureForRoute(null))
    }
}
```

`core/settings/SettingsTabsTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsTabsTest {
    private fun ids(isAdmin: Boolean, isDeveloper: Boolean, signedIn: Boolean) =
        visibleTabs(isAdmin, isDeveloper, signedIn).map { it.id }

    @Test fun signedOutSeesOnlyThisKiosk() {
        assertEquals(listOf(SettingsTabId.THIS_KIOSK), ids(isAdmin = true, isDeveloper = true, signedIn = false))
    }

    @Test fun workerSeesTheFourOpenTabs() {
        assertEquals(
            listOf(SettingsTabId.APPEARANCE, SettingsTabId.SOUND, SettingsTabId.DEVICES, SettingsTabId.THIS_KIOSK),
            ids(isAdmin = false, isDeveloper = false, signedIn = true),
        )
    }

    @Test fun adminGetsAdminDeveloperGetsDeveloper() {
        assertEquals(true, SettingsTabId.ADMIN in ids(isAdmin = true, isDeveloper = false, signedIn = true))
        assertEquals(false, SettingsTabId.DEVELOPER in ids(isAdmin = true, isDeveloper = false, signedIn = true))
        assertEquals(true, SettingsTabId.DEVELOPER in ids(isAdmin = false, isDeveloper = true, signedIn = true))
    }

    @Test fun wireRoundTrip() {
        assertEquals(SettingsTabId.THIS_KIOSK, SettingsTabId.fromWire("this-kiosk"))
        assertEquals(null, SettingsTabId.fromWire("nope"))
    }
}
```

`core/access/AccessTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.access

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessTest {
    @Test fun computeCanReadsTheNestedMap() {
        val perms = mapOf("kiosk" to mapOf("view" to true, "add" to false))
        assertTrue(computeCan(perms, "kiosk", "view"))
        assertFalse(computeCan(perms, "kiosk", "add"))
        assertFalse(computeCan(perms, "labels", "view"))
        assertFalse(computeCan(null, "kiosk", "view"))
    }
}
```

`core/devices/RegistrationTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.devices

import org.junit.Assert.assertEquals
import org.junit.Test

class RegistrationTest {
    private val now = 1_700_000_000_000L

    @Test fun thresholds() {
        assertEquals(RegistrationState.NONE, tokenExpiryState(null, now))
        assertEquals(RegistrationState.NONE, tokenExpiryState("garbage", now))
        assertEquals(RegistrationState.EXPIRED, tokenExpiryState(java.time.Instant.ofEpochMilli(now - 1).toString(), now))
        assertEquals(RegistrationState.SOON, tokenExpiryState(java.time.Instant.ofEpochMilli(now + SOON_MS).toString(), now))
        assertEquals(RegistrationState.OK, tokenExpiryState(java.time.Instant.ofEpochMilli(now + SOON_MS + 1).toString(), now))
    }

    @Test fun labels() {
        assertEquals("Registered", RegistrationState.OK.label)
        assertEquals("Unregistered", RegistrationState.fromWire("bogus").label)
    }
}
```

`core/model/ModelsJsonTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.model

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class ModelsJsonTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

    @Test fun sessionDecodesWithUnknownKeysAndPreferencesSubset() {
        val body = """{"access_token":"t","token_type":"bearer","expires_in":900,
          "session_expires_at":"2026-09-16T00:00:00Z",
          "person":{"id":"p1","first_name":"Tina","last_name":"T","preferred_name":null,"display_name":"Tina T","email":null,"job_title":null,"avatar_key":null},
          "roles":["worker"],"must_change_password":false,
          "preferences":{"accent":"aqua","theme":"dark","density":"compact","notif":{"critical":true}},
          "perms":{"kiosk":{"view":true,"add":false,"change":false,"delete":false}},
          "max_rank":20,"scope":{"global":true,"client_ids":[]},"password_min_length":8}"""
        val s = json.decodeFromString<SessionData>(body)
        assertEquals("t", s.access_token)
        assertEquals("aqua", s.preferences.accent)
        assertEquals("dark", s.preferences.theme)
        assertEquals(true, s.perms["kiosk"]?.get("view"))
        assertNull(s.person.avatar_url)
    }

    @Test fun heartbeatOmitsNullsAndKeepsSnakeCase() {
        val encoded = json.encodeToString(HeartbeatIn.serializer(), HeartbeatIn(serial = "s", name = "n", version = "0.1.0"))
        assertEquals(true, encoded.contains("\"mode\":\"android\""))
        assertFalse(encoded.contains("login_method"))
        assertEquals(true, encoded.contains("\"sign_in\":false"))
    }

    @Test fun assetRowDefaultsLabelMap() {
        val row = json.decodeFromString<KioskAssetRow>("""{"id":"a","asset_id":"A-1","make_model":"Dell R740","label":{"asset_id":"A-1"}}""")
        assertEquals("A-1", row.label["asset_id"])
        assertNull(row.rfid)
    }
}
```

- [ ] **Step 5: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): core models, feature registry, setup state, settings tabs, access and registration helpers, purity guardrail

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `core/scan` — RFID padding/display and scan matching

Port of `kiosk/src/lib/rfid.ts`, `portal/src/lib/format.ts::displayRfid`, and `kiosk/src/lib/scanMatch.ts`.

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/core/scan/Rfid.kt`, `core/scan/ScanMatch.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/core/scan/RfidTest.kt`, `core/scan/ScanMatchTest.kt`

**Interfaces:**
- Produces: `RFID_LENGTH`, `displayRfid(tag: String?): String`, `RfidProblem`, `PaddedRfid(tag, problem)`, `padRfid(raw): PaddedRfid`, `rfidProblemText(problem)`; `ScanAsset` interface, `ScanMatchKind`, `ScanMatch(kind, asset)`, `ScanIndex<A>`, `buildScanIndex(assets)`, `matchScan(index, raw)`, `matchAssetOrSerial(index, raw)`, `scanTypeFor(kind): String`.

- [ ] **Step 1: Tests first**

`core/scan/RfidTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RfidTest {
    @Test fun padsTo24AndUppercases() {
        val p = padRfid(" 10 03 48 ")
        assertEquals("000000000000000000100348", p.tag)
        assertNull(p.problem)
        assertEquals("00000000000000000000ABCD", padRfid("abcd").tag)
    }

    @Test fun problems() {
        assertEquals(RfidProblem.EMPTY, padRfid("   ").problem)
        assertEquals(RfidProblem.NOT_ALPHANUMERIC, padRfid("10-03").problem)
        assertEquals(RfidProblem.TOO_LONG, padRfid("1".repeat(25)).problem)
        assertEquals("Scan the RFID tag.", rfidProblemText(RfidProblem.EMPTY))
        assertEquals("That tag is longer than 24 characters.", rfidProblemText(RfidProblem.TOO_LONG))
    }

    @Test fun displayStripsLeadingZerosButKeepsOne() {
        assertEquals("100348", displayRfid("000000000000000000100348"))
        assertEquals("0", displayRfid("0000"))
        assertEquals("—", displayRfid(null))
        assertEquals("—", displayRfid(""))
    }
}
```

`core/scan/ScanMatchTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private data class A(
    override val id: String, override val assetId: String, override val name: String? = null,
    override val rfid: String? = null, override val serialNumber: String? = null, override val makeModel: String = "",
) : ScanAsset

class ScanMatchTest {
    private val rack = A("1", "A-100", "Rack", rfid = "000000000000000000100348", serialNumber = "SN-1")
    private val server = A("2", "A-200", "Server", rfid = null, serialNumber = "sn-2")
    private val index = buildScanIndex(listOf(rack, server))

    @Test fun rfidThenAssetIdThenSerial() {
        assertEquals(ScanMatchKind.RFID, matchScan(index, "100348")?.kind)
        assertEquals(ScanMatchKind.RFID, matchScan(index, "000000000000000000100348")?.kind)
        assertEquals("1", matchScan(index, "a-100")?.asset?.id)
        assertEquals(ScanMatchKind.ASSET_ID, matchScan(index, "a-100")?.kind)
        assertEquals(ScanMatchKind.SERIAL, matchScan(index, "SN-2")?.kind)
        assertNull(matchScan(index, "nothing"))
        assertNull(matchScan(index, "   "))
    }

    @Test fun firstRowWinsOnDuplicateKeys() {
        val dup = A("9", "A-100", "Other")
        val i = buildScanIndex(listOf(rack, dup))
        assertEquals("1", matchScan(i, "A-100")?.asset?.id)
        assertEquals(2, i.size)
    }

    @Test fun assetOrSerialNeverMatchesByTag() {
        assertNull(matchAssetOrSerial(index, "100348"))
        assertEquals(ScanMatchKind.ASSET_ID, matchAssetOrSerial(index, "A-100")?.kind)
        assertEquals(ScanMatchKind.SERIAL, matchAssetOrSerial(index, "sn-1")?.kind)
    }

    @Test fun scanTypeWire() {
        assertEquals("rfid", scanTypeFor(ScanMatchKind.RFID))
        assertEquals("barcode", scanTypeFor(ScanMatchKind.ASSET_ID))
        assertEquals("barcode", scanTypeFor(ScanMatchKind.SERIAL))
    }
}
```

Run: `./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.scan.*'` → FAIL (unresolved references).

- [ ] **Step 2: Implement**

`core/scan/Rfid.kt`:

```kotlin
package com.serversherpa.kiosk.core.scan

/** The house RFID format: 24 characters, zero-padded on the left. The
 *  server normalizes independently (`normalize_rfid` in routes/kiosk.py);
 *  the kiosk pads so the operator sees what will be stored. */
const val RFID_LENGTH = 24

enum class RfidProblem { EMPTY, NOT_ALPHANUMERIC, TOO_LONG }

data class PaddedRfid(val tag: String?, val problem: RfidProblem?)

private val ALPHANUMERIC = Regex("^[0-9A-Z]+$")

fun padRfid(raw: String): PaddedRfid {
    val tag = raw.replace(Regex("\\s+"), "").uppercase()
    if (tag.isEmpty()) return PaddedRfid(null, RfidProblem.EMPTY)
    if (!ALPHANUMERIC.matches(tag)) return PaddedRfid(null, RfidProblem.NOT_ALPHANUMERIC)
    if (tag.length > RFID_LENGTH) return PaddedRfid(null, RfidProblem.TOO_LONG)
    return PaddedRfid(tag.padStart(RFID_LENGTH, '0'), null)
}

fun rfidProblemText(problem: RfidProblem): String = when (problem) {
    RfidProblem.EMPTY -> "Scan the RFID tag."
    RfidProblem.TOO_LONG -> "That tag is longer than $RFID_LENGTH characters."
    RfidProblem.NOT_ALPHANUMERIC -> "That tag has characters we can't store — letters and numbers only."
}

/** portal/src/lib/format.ts: leading zeros stripped for display; a
 *  missing tag renders as an em dash. */
fun displayRfid(tag: String?): String {
    if (tag.isNullOrEmpty()) return "—"
    return tag.replace(Regex("^0+(?=.)"), "")
}
```

`core/scan/ScanMatch.kt`:

```kotlin
package com.serversherpa.kiosk.core.scan

/** What matching needs from an asset row (the Room entity and the
 *  synced `KioskAssetRow` both provide these). */
interface ScanAsset {
    val id: String
    val assetId: String
    val name: String?
    val rfid: String?
    val serialNumber: String?
    val makeModel: String
}

enum class ScanMatchKind { RFID, ASSET_ID, SERIAL }

data class ScanMatch<A : ScanAsset>(val kind: ScanMatchKind, val asset: A)

class ScanIndex<A : ScanAsset>(
    val byRfid: Map<String, A>,
    val byAssetId: Map<String, A>,
    val bySerial: Map<String, A>,
    val size: Int,
)

private fun key(value: String?): String? = value?.trim()?.uppercase()?.takeIf { it.isNotEmpty() }

/** Zero-padding stripped, upper-cased — so a handheld that pads the EPC
 *  and a fixed reader that doesn't land on the same asset. */
private fun rfidKey(value: String?): String? {
    if (value.isNullOrBlank()) return null
    return key(displayRfid(value.trim()))
}

/** First row wins on a duplicate key, as in scanMatch.ts. */
fun <A : ScanAsset> buildScanIndex(assets: List<A>): ScanIndex<A> {
    val byRfid = LinkedHashMap<String, A>()
    val byAssetId = LinkedHashMap<String, A>()
    val bySerial = LinkedHashMap<String, A>()
    for (asset in assets) {
        rfidKey(asset.rfid)?.let { byRfid.putIfAbsent(it, asset) }
        key(asset.assetId)?.let { byAssetId.putIfAbsent(it, asset) }
        key(asset.serialNumber)?.let { bySerial.putIfAbsent(it, asset) }
    }
    return ScanIndex(byRfid, byAssetId, bySerial, assets.size)
}

/** RFID first (the readers), then asset ID (the labels), then serial. */
fun <A : ScanAsset> matchScan(index: ScanIndex<A>, raw: String): ScanMatch<A>? {
    val plain = key(raw) ?: return null
    rfidKey(raw)?.let { index.byRfid[it] }?.let { return ScanMatch(ScanMatchKind.RFID, it) }
    index.byAssetId[plain]?.let { return ScanMatch(ScanMatchKind.ASSET_ID, it) }
    index.bySerial[plain]?.let { return ScanMatch(ScanMatchKind.SERIAL, it) }
    return null
}

/** Asset ID or serial only — RFID Enroll's first step, where a tag read
 *  must not silently pick "re-tag that asset". */
fun <A : ScanAsset> matchAssetOrSerial(index: ScanIndex<A>, raw: String): ScanMatch<A>? {
    val plain = key(raw) ?: return null
    index.byAssetId[plain]?.let { return ScanMatch(ScanMatchKind.ASSET_ID, it) }
    index.bySerial[plain]?.let { return ScanMatch(ScanMatchKind.SERIAL, it) }
    return null
}

/** The ingest endpoint's `scan_type`. */
fun scanTypeFor(kind: ScanMatchKind): String = if (kind == ScanMatchKind.RFID) "rfid" else "barcode"
```

- [ ] **Step 3: Run tests, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.scan.*'
git add -A Android_Kiosk_App
git commit -m "feat(android): core scan matching and RFID padding ported from the web kiosk

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `core/people` — badge/id exact match and typed-name search

Port of `kiosk/src/lib/peopleMatch.ts`. Read its module docstring before starting; every rule below comes from it.

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/core/people/PeopleMatch.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/core/people/PeopleMatchTest.kt`

**Interfaces:**
- Produces: `MatchPerson` interface (`id, displayName, firstName?, lastName?, preferredName?, rfidTag?, isWorker, hasAccount`), `PeopleIndex<P>`, `buildPeopleIndex(people)`, `matchPersonExact(index, raw): P?`, `isAmbiguousPrefix(index, raw): Boolean`, `searchPeople(index, query, limit = 8): List<P>`.

- [ ] **Step 1: Tests first**

```kotlin
package com.serversherpa.kiosk.core.people

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private data class P(
    override val id: String, override val displayName: String, override val firstName: String? = null,
    override val lastName: String? = null, override val preferredName: String? = null,
    override val rfidTag: String? = null, override val isWorker: Boolean = false, override val hasAccount: Boolean = false,
) : MatchPerson

class PeopleMatchTest {
    private val jimmy = P("0a1b2c3d-1111-4000-8000-000000000001", "Jimmy Henderson", "James", "Henderson", "Jimmy", rfidTag = "000000000000000000100348")
    private val tina = P("ffffffff-2222-4000-8000-000000000002", "Tina Timeclock", "Tina", "Timeclock", rfidTag = "1003")
    private val smithJones = P("abcdef01-3333-4000-8000-000000000003", "Ann Smith-Jones", "Ann", "Smith-Jones")
    private val index = buildPeopleIndex(listOf(jimmy, tina, smithJones))

    @Test fun exactByBadgeIgnoresPaddingAndCase() {
        assertEquals(jimmy, matchPersonExact(index, "100348"))
        assertEquals(jimmy, matchPersonExact(index, "000000000000000000100348"))
        assertNull(matchPersonExact(index, "Jimmy"))
    }

    @Test fun exactByFullIdAndHexShortId() {
        assertEquals(jimmy, matchPersonExact(index, jimmy.id.uppercase()))
        assertEquals(jimmy, matchPersonExact(index, "0a1b2c3d"))
        assertEquals(smithJones, matchPersonExact(index, "abcdef01"))
    }

    @Test fun anEightLetterNameIsNeverAnId() {
        val hen = P("hendersn-4444-4000-8000-000000000004", "Hen Dersn")
        val i = buildPeopleIndex(listOf(hen))
        assertNull(matchPersonExact(i, "hendersn"))
    }

    @Test fun ambiguousPrefixOnlyForStrictPrefixes() {
        assertTrue(isAmbiguousPrefix(index, "1003"))          // 1003 vs 100348
        assertFalse(isAmbiguousPrefix(index, "100348"))
        assertFalse(isAmbiguousPrefix(index, "9999"))
    }

    @Test fun searchByAnyNamePartsInAnyOrder() {
        assertEquals(listOf(jimmy), searchPeople(index, "jim hen"))
        assertEquals(listOf(jimmy), searchPeople(index, "hen jim"))
        assertEquals(listOf(jimmy), searchPeople(index, "james henderson"))
        assertEquals(listOf(jimmy), searchPeople(index, "henderson j"))
        assertEquals(listOf(smithJones), searchPeople(index, "jones"))
        assertEquals(emptyList<P>(), searchPeople(index, "tina tina"))   // distinct parts
        assertEquals(emptyList<P>(), searchPeople(index, "   "))
    }

    @Test fun rankingExactFullNameFirstThenFewestPartsThenAlpha() {
        val t1 = P("1", "Tina Timeclock", "Tina", "Timeclock")
        val t2 = P("2", "Tina T", "Tina", "T")
        val t3 = P("3", "Tina Timeclock Jr", "Tina", "Timeclock")
        val i = buildPeopleIndex(listOf(t3, t1, t2))
        // "tina timeclock": t2's parts are [tina, t] — "t" is not a prefix match for "timeclock", so t2 is out;
        // t1 (exact full name) ranks ahead of t3 (three parts).
        assertEquals(listOf("1", "3"), searchPeople(i, "tina timeclock").map { it.id })
        // "tina": all three match; fewest parts first, then alphabetical ("tina t" < "tina timeclock").
        assertEquals(listOf("2", "1", "3"), searchPeople(i, "tina").map { it.id })
        assertEquals(2, searchPeople(i, "tina", limit = 2).size)
    }
}
```

Run: `./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.people.*'` → FAIL.

- [ ] **Step 2: Implement**

```kotlin
package com.serversherpa.kiosk.core.people

import com.serversherpa.kiosk.core.scan.displayRfid

interface MatchPerson {
    val id: String
    val displayName: String
    val firstName: String?
    val lastName: String?
    val preferredName: String?
    val rfidTag: String?
    val isWorker: Boolean
    val hasAccount: Boolean
}

private class Entry<P : MatchPerson>(val person: P, val parts: List<String>, val fullNames: List<String>, val sortKey: String)

class PeopleIndex<P : MatchPerson> internal constructor(
    val byRfid: Map<String, P>,
    /** Full id and the eight-character short id, both lower-cased. */
    val byId: Map<String, P>,
    private val entries: List<Entry<P>>,
    val size: Int,
) {
    internal fun entries() = entries
}

private val SHORT_ID = Regex("^[0-9a-f]{8}$", RegexOption.IGNORE_CASE)

/** Whitespace or a hyphen starts a new part ("Smith-Jones" → smith, jones). */
private fun words(value: String?): List<String> =
    (value ?: "").trim().lowercase().split(Regex("[\\s-]+")).filter { it.isNotEmpty() }

private fun rfidKey(value: String?): String? {
    if (value.isNullOrBlank()) return null
    return displayRfid(value.trim()).uppercase().takeIf { it.isNotEmpty() }
}

private fun <P : MatchPerson> entryFor(person: P): Entry<P> {
    val parts = ArrayList<String>()
    fun push(w: String) { if (w.isNotEmpty() && w !in parts) parts.add(w) }
    for (source in listOf(person.firstName, person.lastName, person.preferredName)) words(source).forEach(::push)
    words(person.displayName).forEach(::push)

    val first = (person.firstName ?: "").trim().lowercase()
    val last = (person.lastName ?: "").trim().lowercase()
    val preferred = (person.preferredName ?: "").trim().lowercase()
    val fullNames = ArrayList<String>()
    fun pushFull(name: String) {
        val collapsed = name.trim().replace(Regex("\\s+"), " ")
        if (collapsed.isNotEmpty() && collapsed !in fullNames) fullNames.add(collapsed)
    }
    pushFull(person.displayName.lowercase())
    if (first.isNotEmpty() && last.isNotEmpty()) pushFull("$first $last")
    if (preferred.isNotEmpty() && last.isNotEmpty()) pushFull("$preferred $last")
    return Entry(person, parts, fullNames, person.displayName.lowercase())
}

fun <P : MatchPerson> buildPeopleIndex(people: List<P>): PeopleIndex<P> {
    val byRfid = LinkedHashMap<String, P>()
    val byId = LinkedHashMap<String, P>()
    val entries = ArrayList<Entry<P>>(people.size)
    for (person in people) {
        rfidKey(person.rfidTag)?.let { byRfid.putIfAbsent(it, person) }
        val id = person.id.trim().lowercase()
        if (id.isNotEmpty()) byId.putIfAbsent(id, person)
        val short = id.take(8)
        if (short.length == 8) byId.putIfAbsent(short, person)
        entries.add(entryFor(person))
    }
    return PeopleIndex(byRfid, byId, entries, people.size)
}

/** The badge/id door: a value naming exactly one person, or null. */
fun <P : MatchPerson> matchPersonExact(index: PeopleIndex<P>, raw: String): P? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    rfidKey(trimmed)?.let { index.byRfid[it] }?.let { return it }
    val lower = trimmed.lowercase()
    val byId = index.byId[lower] ?: return null
    // The eight-character short form only counts when it looks like hex.
    return if (lower.length != 8 || SHORT_ID.matches(lower)) byId else null
}

/** True when `raw` is an exact tag AND a strict prefix of a longer tag
 *  ("1003" vs "100348") — too soon to auto-select mid-scan. */
fun <P : MatchPerson> isAmbiguousPrefix(index: PeopleIndex<P>, raw: String): Boolean {
    val tag = rfidKey(raw.trim()) ?: return false
    if (!index.byRfid.containsKey(tag)) return false
    return index.byRfid.keys.any { it != tag && it.startsWith(tag) }
}

/** Every term is a prefix of a distinct part — a tiny bipartite match. */
private fun assign(terms: List<String>, parts: List<String>): Boolean {
    if (terms.size > parts.size) return false
    val used = BooleanArray(parts.size)
    fun go(i: Int): Boolean {
        if (i == terms.size) return true
        for (j in parts.indices) {
            if (used[j] || !parts[j].startsWith(terms[i])) continue
            used[j] = true
            if (go(i + 1)) return true
            used[j] = false
        }
        return false
    }
    return go(0)
}

/** The typed-name door: full-name matches first, then fewest name parts, then alphabetical. */
fun <P : MatchPerson> searchPeople(index: PeopleIndex<P>, query: String, limit: Int = 8): List<P> {
    val terms = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (terms.isEmpty()) return emptyList()
    val typed = terms.joinToString(" ")
    return index.entries()
        .filter { assign(terms, it.parts) }
        .sortedWith(
            compareBy<Entry<P>> { if (typed in it.fullNames) 0 else 1 }
                .thenBy { it.parts.size }
                .thenBy { it.sortKey },
        )
        .take(limit)
        .map { it.person }
}
```

- [ ] **Step 3: Run tests, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.people.*'
git add -A Android_Kiosk_App
git commit -m "feat(android): core people matching (badge/id exact, ambiguous prefix, name-part search)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `core/outbox` — the outbox state machine as pure functions

Port of the decision logic in `kiosk/src/lib/outbox.ts` (read it first). Persistence and timers come in Part 2; here everything is a pure function over rows and a clock so the transitions are testable without Room.

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/core/outbox/OutboxMachine.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/core/outbox/OutboxMachineTest.kt`

**Interfaces:**
- Produces: `OutboxStatus`, `OutboxAsset`, `OutboxRow`, `EnqueueInput`, `OutboxCounts`, `object OutboxMachine { BACKOFF, MAX_BATCH, BATCH_DELAY_MS, LIST_CAP, NOMATCH_TTL_MS, NOMATCH_SWEEP_MS; newRow; recoverStranded; dueRows; markSending; applyResponse; applyFailure; staleNoMatch; counts; nextRetryDelayMs; retryFailed }`.

- [ ] **Step 1: Tests first**

```kotlin
package com.serversherpa.kiosk.core.outbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxMachineTest {
    private val asset = OutboxAsset("a1", "A-1", "Rack", null, "SN", "Dell")
    private val input = EnqueueInput("A-1", "barcode", asset, "site", "init", "pre_stage")

    private fun row(seq: Long, status: OutboxStatus = OutboxStatus.QUEUED, attempts: Int = 0, next: Long? = null, scannedAtMs: Long = 0) =
        OutboxMachine.newRow(input, "id$seq", seq, scannedAtMs).copy(status = status, attempts = attempts, nextAttemptAt = next)

    @Test fun newRowIsQueuedWhenMatchedNomatchOtherwise() {
        assertEquals(OutboxStatus.QUEUED, OutboxMachine.newRow(input, "x", 1, 0).status)
        val miss = OutboxMachine.newRow(input.copy(asset = null), "y", 2, 0)
        assertEquals(OutboxStatus.NOMATCH, miss.status)
        assertEquals(false, miss.matched)
        assertEquals("1970-01-01T00:00:00Z", miss.scannedAt)
    }

    @Test fun dueRowsTakesQueuedAndDueRetriesOldestFirstCapped() {
        val rows = (1..120L).map { row(it) } + row(200, OutboxStatus.RETRYING, next = 50) + row(201, OutboxStatus.RETRYING, next = 500) +
            row(300, OutboxStatus.FAILED) + row(301, OutboxStatus.ACCEPTED) + row(302, OutboxStatus.NOMATCH)
        val due = OutboxMachine.dueRows(rows.shuffled(), nowMs = 100)
        assertEquals(OutboxMachine.MAX_BATCH, due.size)
        assertEquals(1L, due.first().seq)
        assertTrue(due.none { it.seq == 201L || it.seq >= 300 })
    }

    @Test fun recoverStrandedResetsSendingToQueued() {
        val out = OutboxMachine.recoverStranded(listOf(row(1, OutboxStatus.SENDING), row(2, OutboxStatus.ACCEPTED)))
        assertEquals(listOf(OutboxStatus.QUEUED), out.map { it.status })
        assertEquals(1L, out.single().seq)
    }

    @Test fun responseAcceptsRejectsAndFailsUnmentioned() {
        val batch = listOf(row(1, OutboxStatus.SENDING), row(2, OutboxStatus.SENDING), row(3, OutboxStatus.SENDING))
        val out = OutboxMachine.applyResponse(batch, accepted = setOf("id1"), rejected = mapOf("id2" to "bad_site"))
        assertEquals(OutboxStatus.ACCEPTED, out[0].status)
        assertEquals(OutboxStatus.FAILED, out[1].status); assertEquals("bad_site", out[1].lastError)
        assertEquals(OutboxStatus.FAILED, out[2].status); assertEquals("no_ack", out[2].lastError)
    }

    @Test fun failureWalksTheLadderThenFails() {
        var rows = listOf(row(1, OutboxStatus.SENDING))
        val waits = mutableListOf<Long>()
        repeat(4) { i ->
            rows = OutboxMachine.applyFailure(rows, "network", nowMs = 1000)
            assertEquals(OutboxStatus.RETRYING, rows[0].status)
            assertEquals(i + 1, rows[0].attempts)
            waits += rows[0].nextAttemptAt!! - 1000
        }
        assertEquals(listOf(2000L, 4000L, 15000L, 60000L), waits)
        rows = OutboxMachine.applyFailure(rows, "network", nowMs = 1000)
        assertEquals(OutboxStatus.FAILED, rows[0].status)
        assertNull(rows[0].nextAttemptAt)
        assertEquals("network", rows[0].lastError)
    }

    @Test fun staleNoMatchAndCounts() {
        val rows = listOf(
            row(1, OutboxStatus.NOMATCH, scannedAtMs = 0), row(2, OutboxStatus.NOMATCH, scannedAtMs = 100_000),
            row(3, OutboxStatus.QUEUED, scannedAtMs = 0), row(4, OutboxStatus.ACCEPTED), row(5, OutboxStatus.FAILED), row(6, OutboxStatus.RETRYING),
        )
        assertEquals(listOf(1L), OutboxMachine.staleNoMatch(rows, nowMs = 130_000).map { it.seq })
        val c = OutboxMachine.counts(rows)
        assertEquals(OutboxCounts(queued = 2, accepted = 1, failed = 1, nomatch = 2, total = 6), c)
    }

    @Test fun nextRetryDelayAndRetryFailed() {
        assertNull(OutboxMachine.nextRetryDelayMs(listOf(row(1)), nowMs = 0))
        assertEquals(40L, OutboxMachine.nextRetryDelayMs(listOf(row(1, OutboxStatus.RETRYING, next = 140), row(2, OutboxStatus.RETRYING, next = 900)), nowMs = 100))
        assertEquals(0L, OutboxMachine.nextRetryDelayMs(listOf(row(1, OutboxStatus.RETRYING, next = 10)), nowMs = 100))
        val retried = OutboxMachine.retryFailed(listOf(row(1, OutboxStatus.FAILED, attempts = 5), row(2, OutboxStatus.ACCEPTED)))
        assertEquals(1, retried.size)
        assertEquals(OutboxStatus.QUEUED, retried[0].status); assertEquals(0, retried[0].attempts); assertNull(retried[0].lastError)
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

```kotlin
package com.serversherpa.kiosk.core.outbox

import java.time.Instant

enum class OutboxStatus(val wire: String) {
    QUEUED("queued"), SENDING("sending"), ACCEPTED("accepted"), RETRYING("retrying"), FAILED("failed"), NOMATCH("nomatch");
    companion object { fun fromWire(s: String) = entries.first { it.wire == s } }
}

/** The matched asset, denormalized onto the row so the receipt list keeps
 *  showing it after the roster is re-synced or cleared. */
data class OutboxAsset(
    val id: String, val assetId: String, val name: String?, val rfid: String?, val serialNumber: String?, val makeModel: String,
)

data class OutboxRow(
    val clientScanId: String,
    /** Monotonic per kiosk; the list is ordered by this, not by scannedAt. */
    val seq: Long,
    val scannedValue: String,
    val scanType: String,
    val scannedAt: String,
    val asset: OutboxAsset?,
    val matched: Boolean,
    val status: OutboxStatus,
    val attempts: Int,
    val nextAttemptAt: Long?,
    val lastError: String?,
    val siteId: String,
    val initiativeId: String,
    val scanStatus: String,
)

data class EnqueueInput(
    val scannedValue: String, val scanType: String, val asset: OutboxAsset?,
    val siteId: String, val initiativeId: String, val scanStatus: String,
)

/** queued = queued + sending + retrying ("still on its way"). */
data class OutboxCounts(val queued: Int, val accepted: Int, val failed: Int, val nomatch: Int, val total: Int)

object OutboxMachine {
    /** Waits between retries, indexed by the row's pre-increment attempts. */
    val BACKOFF: List<Long> = listOf(2_000, 4_000, 15_000, 60_000)
    const val MAX_BATCH = 100
    const val BATCH_DELAY_MS = 500L
    const val LIST_CAP = 200
    const val NOMATCH_TTL_MS = 120_000L
    const val NOMATCH_SWEEP_MS = 10_000L

    fun newRow(input: EnqueueInput, clientScanId: String, seq: Long, nowMs: Long): OutboxRow {
        val matched = input.asset != null
        return OutboxRow(
            clientScanId = clientScanId, seq = seq, scannedValue = input.scannedValue, scanType = input.scanType,
            scannedAt = Instant.ofEpochMilli(nowMs).toString(), asset = input.asset, matched = matched,
            status = if (matched) OutboxStatus.QUEUED else OutboxStatus.NOMATCH, attempts = 0,
            nextAttemptAt = null, lastError = null, siteId = input.siteId, initiativeId = input.initiativeId, scanStatus = input.scanStatus,
        )
    }

    /** Rows left `sending` by a process that died mid-POST go back to queued. */
    fun recoverStranded(all: List<OutboxRow>): List<OutboxRow> =
        all.filter { it.status == OutboxStatus.SENDING }.map { it.copy(status = OutboxStatus.QUEUED) }

    fun dueRows(all: List<OutboxRow>, nowMs: Long): List<OutboxRow> = all
        .filter { it.status == OutboxStatus.QUEUED || (it.status == OutboxStatus.RETRYING && (it.nextAttemptAt ?: 0) <= nowMs) }
        .sortedBy { it.seq }
        .take(MAX_BATCH)

    fun markSending(batch: List<OutboxRow>): List<OutboxRow> = batch.map { it.copy(status = OutboxStatus.SENDING) }

    /** A named rejection is permanent; an id in neither list is `no_ack`. */
    fun applyResponse(batch: List<OutboxRow>, accepted: Set<String>, rejected: Map<String, String>): List<OutboxRow> = batch.map { row ->
        if (row.clientScanId in accepted) row.copy(status = OutboxStatus.ACCEPTED, nextAttemptAt = null, lastError = null)
        else row.copy(status = OutboxStatus.FAILED, lastError = rejected[row.clientScanId] ?: "no_ack")
    }

    fun applyFailure(batch: List<OutboxRow>, code: String, nowMs: Long): List<OutboxRow> = batch.map { row ->
        val wait = BACKOFF.getOrNull(row.attempts)
        if (wait == null) row.copy(status = OutboxStatus.FAILED, attempts = row.attempts + 1, lastError = code, nextAttemptAt = null)
        else row.copy(status = OutboxStatus.RETRYING, attempts = row.attempts + 1, lastError = code, nextAttemptAt = nowMs + wait)
    }

    fun staleNoMatch(all: List<OutboxRow>, nowMs: Long): List<OutboxRow> {
        val cutoff = nowMs - NOMATCH_TTL_MS
        return all.filter { it.status == OutboxStatus.NOMATCH && parseMs(it.scannedAt) < cutoff }
    }

    fun counts(all: List<OutboxRow>): OutboxCounts {
        var queued = 0; var accepted = 0; var failed = 0; var nomatch = 0
        for (r in all) when (r.status) {
            OutboxStatus.ACCEPTED -> accepted++
            OutboxStatus.FAILED -> failed++
            OutboxStatus.NOMATCH -> nomatch++
            else -> queued++
        }
        return OutboxCounts(queued, accepted, failed, nomatch, all.size)
    }

    /** Milliseconds until the earliest retry is due (0 when overdue), or null when none is retrying. */
    fun nextRetryDelayMs(all: List<OutboxRow>, nowMs: Long): Long? = all
        .filter { it.status == OutboxStatus.RETRYING && it.nextAttemptAt != null }
        .minOfOrNull { maxOf(0L, it.nextAttemptAt!! - nowMs) }

    fun retryFailed(all: List<OutboxRow>): List<OutboxRow> = all
        .filter { it.status == OutboxStatus.FAILED }
        .map { it.copy(status = OutboxStatus.QUEUED, attempts = 0, nextAttemptAt = null, lastError = null) }

    private fun parseMs(iso: String): Long = try { Instant.parse(iso).toEpochMilli() } catch (e: Exception) { 0L }
}
```

- [ ] **Step 3: Run tests, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.outbox.*'
git add -A Android_Kiosk_App
git commit -m "feat(android): core outbox state machine (batching, backoff ladder, rejection, nomatch expiry) as pure functions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `core/settings` — appearance, sound choice, checkpoints

Ports of `kiosk/src/lib/appearance.ts`, `sound.ts` (settings part only), `checkpointSettings.ts`. Storage comes in Task 8; here the shapes, defaults, parsing with per-field fallback, and HSL→RGB.

**Files:**
- Create: `core/settings/Appearance.kt`, `core/settings/SoundSettings.kt`, `core/settings/Checkpoints.kt`
- Test: `core/settings/AppearanceTest.kt`, `core/settings/SoundSettingsTest.kt`, `core/settings/CheckpointsTest.kt`

**Interfaces:**
- Produces: `Hsl(h, s, l)`, `Appearance(goodScan, notFoundScan, duplicateScan, flashMs)`, `DEFAULT_APPEARANCE`, `FLASH_MS_MIN/MAX/STEP`, `clampFlashMs`, `parseAppearance(json: String?)`, `Appearance.toJson()`, `hslToArgb(hsl): Int`, `hslCss(hsl)`; `BuiltinSound` enum (`CHIME, BEEP, DOUBLE_BEEP, BUZZ, BONK` with `label`), `SoundChoice` (sealed: `None`, `Builtin(id)`), `SoundSettings(good, notFound, duplicate, volume)`, `DEFAULT_SOUND_SETTINGS`, `parseSoundSettings`, `SoundSettings.toJson()`; `CheckpointId` enum (`ENROLL, CONTAINER_PACK, CONTAINER_UNPACK, TRUCK_LOAD, TRUCK_UNLOAD` with `storageKey`, `fallback`), `effectiveCheckpoint(id, stored, offered)`.

- [ ] **Step 1: Tests first**

`AppearanceTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class AppearanceTest {
    @Test fun defaults() {
        assertEquals(Hsl(150.0, 60.0, 45.0), DEFAULT_APPEARANCE.goodScan)
        assertEquals(Hsl(0.0, 70.0, 50.0), DEFAULT_APPEARANCE.notFoundScan)
        assertEquals(Hsl(38.0, 92.0, 50.0), DEFAULT_APPEARANCE.duplicateScan)
        assertEquals(350, DEFAULT_APPEARANCE.flashMs)
    }

    @Test fun parsePerFieldFallback() {
        val a = parseAppearance("""{"good_scan":{"h":10,"s":20,"l":30},"not_found_scan":{"h":999,"s":1,"l":1},"flash_ms":5000}""")
        assertEquals(Hsl(10.0, 20.0, 30.0), a.goodScan)
        assertEquals(DEFAULT_APPEARANCE.notFoundScan, a.notFoundScan)   // out of range → default
        assertEquals(DEFAULT_APPEARANCE.duplicateScan, a.duplicateScan) // missing → default
        assertEquals(2000, a.flashMs)                                    // clamped
        assertEquals(DEFAULT_APPEARANCE, parseAppearance(null))
        assertEquals(DEFAULT_APPEARANCE, parseAppearance("not json"))
    }

    @Test fun roundTrip() {
        val a = DEFAULT_APPEARANCE.copy(flashMs = 700, goodScan = Hsl(1.0, 2.0, 3.0))
        assertEquals(a, parseAppearance(a.toJson()))
    }

    @Test fun hslConversion() {
        assertEquals(0xFF2EB873.toInt(), hslToArgb(Hsl(150.0, 60.0, 45.0)))
        assertEquals(0xFFD92626.toInt(), hslToArgb(Hsl(0.0, 70.0, 50.0)))
        assertEquals("hsl(150 60% 45%)", hslCss(Hsl(150.0, 60.0, 45.0)))
    }

    @Test fun clamp() {
        assertEquals(100, clampFlashMs(3))
        assertEquals(2000, clampFlashMs(99999))
        assertEquals(350, clampFlashMs(null))
    }
}
```

`SoundSettingsTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class SoundSettingsTest {
    @Test fun defaults() {
        assertEquals(SoundChoice.Builtin(BuiltinSound.CHIME), DEFAULT_SOUND_SETTINGS.good)
        assertEquals(SoundChoice.Builtin(BuiltinSound.BUZZ), DEFAULT_SOUND_SETTINGS.notFound)
        assertEquals(SoundChoice.Builtin(BuiltinSound.DOUBLE_BEEP), DEFAULT_SOUND_SETTINGS.duplicate)
        assertEquals(0.8, DEFAULT_SOUND_SETTINGS.volume, 1e-9)
    }

    @Test fun parseWebShapeWithFallbacks() {
        val s = parseSoundSettings("""{"good":{"kind":"none"},"not_found":{"kind":"builtin","id":"bonk"},"duplicate":{"kind":"upload","id":"x"},"volume":7}""")
        assertEquals(SoundChoice.None, s.good)
        assertEquals(SoundChoice.Builtin(BuiltinSound.BONK), s.notFound)
        assertEquals(DEFAULT_SOUND_SETTINGS.duplicate, s.duplicate)   // uploads unsupported here → default
        assertEquals(1.0, s.volume, 1e-9)
        assertEquals(DEFAULT_SOUND_SETTINGS, parseSoundSettings(null))
    }

    @Test fun roundTrip() {
        val s = SoundSettings(SoundChoice.None, SoundChoice.Builtin(BuiltinSound.BEEP), SoundChoice.Builtin(BuiltinSound.CHIME), 0.25)
        assertEquals(s, parseSoundSettings(s.toJson()))
    }
}
```

`CheckpointsTest.kt`:

```kotlin
package com.serversherpa.kiosk.core.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class CheckpointsTest {
    @Test fun defaultsMatchTheWebKiosk() {
        assertEquals("pre_stage", CheckpointId.ENROLL.fallback)
        assertEquals("in_container", CheckpointId.CONTAINER_PACK.fallback)
        assertEquals("un_pack", CheckpointId.CONTAINER_UNPACK.fallback)
        assertEquals("on_truck", CheckpointId.TRUCK_LOAD.fallback)
        assertEquals("received", CheckpointId.TRUCK_UNLOAD.fallback)
        assertEquals("ss.kiosk.enrollStatus", CheckpointId.ENROLL.storageKey)
    }

    @Test fun effectiveFallsBackOnlyWhenOfferedAndMissing() {
        assertEquals("custom", effectiveCheckpoint(CheckpointId.ENROLL, "custom", emptyList()))
        assertEquals("custom", effectiveCheckpoint(CheckpointId.ENROLL, "custom", listOf("custom", "pre_stage")))
        assertEquals("pre_stage", effectiveCheckpoint(CheckpointId.ENROLL, "retired", listOf("pre_stage")))
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`Appearance.kt`:

```kotlin
package com.serversherpa.kiosk.core.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.roundToInt

data class Hsl(val h: Double, val s: Double, val l: Double)

/** The three scan flashes and their duration — kiosk-local. */
data class Appearance(val goodScan: Hsl, val notFoundScan: Hsl, val duplicateScan: Hsl, val flashMs: Int)

const val FLASH_MS_MIN = 100
const val FLASH_MS_MAX = 2000
const val FLASH_MS_STEP = 50

val DEFAULT_APPEARANCE = Appearance(
    goodScan = Hsl(150.0, 60.0, 45.0),
    notFoundScan = Hsl(0.0, 70.0, 50.0),
    duplicateScan = Hsl(38.0, 92.0, 50.0),
    flashMs = 350,
)

fun clampFlashMs(value: Int?): Int = value?.coerceIn(FLASH_MS_MIN, FLASH_MS_MAX) ?: DEFAULT_APPEARANCE.flashMs

private val json = Json { ignoreUnknownKeys = true }

private fun hslOf(obj: JsonObject?): Hsl? {
    if (obj == null) return null
    val h = obj["h"]?.jsonPrimitive?.doubleOrNull ?: return null
    val s = obj["s"]?.jsonPrimitive?.doubleOrNull ?: return null
    val l = obj["l"]?.jsonPrimitive?.doubleOrNull ?: return null
    if (h !in 0.0..360.0 || s !in 0.0..100.0 || l !in 0.0..100.0) return null
    return Hsl(h, s, l)
}

/** Each channel falls back on its own, as appearance.ts does. */
fun parseAppearance(raw: String?): Appearance {
    if (raw.isNullOrBlank()) return DEFAULT_APPEARANCE
    val obj = try { json.parseToJsonElement(raw).jsonObject } catch (e: Exception) { return DEFAULT_APPEARANCE }
    fun field(name: String) = try { obj[name]?.jsonObject } catch (e: Exception) { null }
    val flash = try { obj["flash_ms"]?.jsonPrimitive?.double?.roundToInt() } catch (e: Exception) { null }
    return Appearance(
        goodScan = hslOf(field("good_scan")) ?: DEFAULT_APPEARANCE.goodScan,
        notFoundScan = hslOf(field("not_found_scan")) ?: DEFAULT_APPEARANCE.notFoundScan,
        duplicateScan = hslOf(field("duplicate_scan")) ?: DEFAULT_APPEARANCE.duplicateScan,
        flashMs = clampFlashMs(flash),
    )
}

private fun Hsl.toJsonObject() = buildJsonObject { put("h", h); put("s", s); put("l", l) }

fun Appearance.toJson(): String = buildJsonObject {
    put("good_scan", goodScan.toJsonObject())
    put("not_found_scan", notFoundScan.toJsonObject())
    put("duplicate_scan", duplicateScan.toJsonObject())
    put("flash_ms", flashMs)
}.toString()

/** `hsl(150 60% 45%)` — the readout string the Appearance tab shows. */
fun hslCss(hsl: Hsl): String = "hsl(${hsl.h.roundToInt()} ${hsl.s.roundToInt()}% ${hsl.l.roundToInt()}%)"

/** Opaque ARGB int for the flash overlay. */
fun hslToArgb(hsl: Hsl): Int {
    val h = ((hsl.h % 360) + 360) % 360
    val s = (hsl.s / 100.0).coerceIn(0.0, 1.0)
    val l = (hsl.l / 100.0).coerceIn(0.0, 1.0)
    val c = (1 - abs(2 * l - 1)) * s
    val x = c * (1 - abs((h / 60.0) % 2 - 1))
    val m = l - c / 2
    val (r1, g1, b1) = when {
        h < 60 -> Triple(c, x, 0.0)
        h < 120 -> Triple(x, c, 0.0)
        h < 180 -> Triple(0.0, c, x)
        h < 240 -> Triple(0.0, x, c)
        h < 300 -> Triple(x, 0.0, c)
        else -> Triple(c, 0.0, x)
    }
    fun ch(v: Double) = ((v + m) * 255).roundToInt().coerceIn(0, 255)
    return (0xFF shl 24) or (ch(r1) shl 16) or (ch(g1) shl 8) or ch(b1)
}
```

`SoundSettings.kt`:

```kotlin
package com.serversherpa.kiosk.core.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

enum class BuiltinSound(val wire: String, val label: String) {
    CHIME("chime", "Chime"), BEEP("beep", "Beep"), DOUBLE_BEEP("double_beep", "Double beep"), BUZZ("buzz", "Buzz"), BONK("bonk", "Bonk");
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

sealed class SoundChoice {
    data object None : SoundChoice()
    data class Builtin(val id: BuiltinSound) : SoundChoice()
}

/** good / not-found / duplicate choices and a 0–1 volume — kiosk-local. */
data class SoundSettings(val good: SoundChoice, val notFound: SoundChoice, val duplicate: SoundChoice, val volume: Double)

val DEFAULT_SOUND_SETTINGS = SoundSettings(
    good = SoundChoice.Builtin(BuiltinSound.CHIME),
    notFound = SoundChoice.Builtin(BuiltinSound.BUZZ),
    duplicate = SoundChoice.Builtin(BuiltinSound.DOUBLE_BEEP),
    volume = 0.8,
)

private val json = Json { ignoreUnknownKeys = true }

private fun choiceOf(obj: JsonObject?): SoundChoice? {
    val kind = obj?.get("kind")?.jsonPrimitive?.content ?: return null
    return when (kind) {
        "none" -> SoundChoice.None
        "builtin" -> BuiltinSound.fromWire(obj["id"]?.jsonPrimitive?.content)?.let { SoundChoice.Builtin(it) }
        else -> null   // "upload" is a web-only kind
    }
}

fun parseSoundSettings(raw: String?): SoundSettings {
    if (raw.isNullOrBlank()) return DEFAULT_SOUND_SETTINGS
    val obj = try { json.parseToJsonElement(raw).jsonObject } catch (e: Exception) { return DEFAULT_SOUND_SETTINGS }
    fun field(name: String) = try { obj[name]?.jsonObject } catch (e: Exception) { null }
    val volume = try { obj["volume"]?.jsonPrimitive?.doubleOrNull } catch (e: Exception) { null }
    return SoundSettings(
        good = choiceOf(field("good")) ?: DEFAULT_SOUND_SETTINGS.good,
        notFound = choiceOf(field("not_found")) ?: DEFAULT_SOUND_SETTINGS.notFound,
        duplicate = choiceOf(field("duplicate")) ?: DEFAULT_SOUND_SETTINGS.duplicate,
        volume = volume?.coerceIn(0.0, 1.0) ?: DEFAULT_SOUND_SETTINGS.volume,
    )
}

private fun SoundChoice.toJsonObject() = when (this) {
    SoundChoice.None -> buildJsonObject { put("kind", "none") }
    is SoundChoice.Builtin -> buildJsonObject { put("kind", "builtin"); put("id", id.wire) }
}

fun SoundSettings.toJson(): String = buildJsonObject {
    put("good", good.toJsonObject()); put("not_found", notFound.toJsonObject())
    put("duplicate", duplicate.toJsonObject()); put("volume", volume)
}.toString()
```

`Checkpoints.kt`:

```kotlin
package com.serversherpa.kiosk.core.settings

/** The checkpoints the non-scanning screens record; keys and defaults
 *  from kiosk/src/lib/checkpointSettings.ts. Only ENROLL has a UI here. */
enum class CheckpointId(val storageKey: String, val fallback: String, val label: String) {
    ENROLL("ss.kiosk.enrollStatus", "pre_stage", "RFID Enroll checkpoint"),
    CONTAINER_PACK("ss.kiosk.containerPackStatus", "in_container", "Container pack checkpoint"),
    CONTAINER_UNPACK("ss.kiosk.containerUnpackStatus", "un_pack", "Container unpack checkpoint"),
    TRUCK_LOAD("ss.kiosk.truckLoadStatus", "on_truck", "Truck load checkpoint"),
    TRUCK_UNLOAD("ss.kiosk.truckUnloadStatus", "received", "Truck unload checkpoint"),
}

/** The stored key, or the default when the portal no longer offers it.
 *  An empty `offered` means the options have not loaded — the stored key stands. */
fun effectiveCheckpoint(id: CheckpointId, stored: String, offered: List<String>): String {
    if (offered.isEmpty()) return stored
    return if (stored in offered) stored else id.fallback
}
```

- [ ] **Step 3: Run tests, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.core.*'
git add -A Android_Kiosk_App
git commit -m "feat(android): core appearance, sound, and checkpoint settings with per-field parsing and HSL conversion

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `data/prefs` — DataStore-backed config, identity, and kiosk-local settings

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/data/prefs/KioskPrefs.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/data/config/KioskConfig.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/data/identity/Identity.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/data/prefs/KioskPrefsTest.kt`, `data/identity/IdentityTest.kt`, `data/config/KioskConfigTest.kt`

**Interfaces:**
- Produces:
  - `class KioskPrefs(store: DataStore<Preferences>)` with `val setupState: Flow<SetupState>`, `suspend fun setSetupState(SetupState)`, `val setupSelection: Flow<KioskSetupSelection?>`, `suspend fun setSetupSelection(KioskSetupSelection?)`, `val appearance: Flow<Appearance>`, `suspend fun setAppearance(Appearance)`, `val sound: Flow<SoundSettings>`, `suspend fun setSound(SoundSettings)`, `fun checkpoint(id): Flow<String>`, `suspend fun setCheckpoint(id, key)`, `val devMode: Flow<Boolean>`, `suspend fun setDevMode(Boolean)`, `val apiUrl: Flow<String?>`, `suspend fun setApiUrl(String?)`, `val portalUrl: Flow<String?>`, `suspend fun setPortalUrl(String?)`, `val serial: Flow<String?>`, `suspend fun setSerial(String)`, `val name: Flow<String?>`, `suspend fun setName(String?)`, `suspend fun snapshot(): Preferences`.
  - `class KioskConfig(prefs: KioskPrefs, defaultApiUrl: String, defaultPortalUrl: String, version: String)` with `val apiUrl: Flow<String>`, `val portalUrl: Flow<String>`, `suspend fun apiUrlNow(): String`, `suspend fun portalUrlNow(): String`, `val kioskVersion: String`, `companion fun normalizeUrl(raw: String): String?` (trims, strips trailing slashes, requires `http://` or `https://`, else null).
  - `data class KioskIdentity(serial, name)`; `class Identity(prefs: KioskPrefs)` with `suspend fun get(): KioskIdentity` (generates and persists `kiosk-android-<uuid4>` once), `val identity: Flow<KioskIdentity>` (after `get()` has run once), `suspend fun setName(name): Boolean`; `const val NAME_MAX = 80`; `fun defaultName(serial): String`; `fun newSerial(): String`.

- [ ] **Step 1: Tests first**

`data/prefs/KioskPrefsTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.prefs

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.settings.CheckpointId
import com.serversherpa.kiosk.core.settings.DEFAULT_APPEARANCE
import com.serversherpa.kiosk.core.settings.DEFAULT_SOUND_SETTINGS
import com.serversherpa.kiosk.core.settings.SoundChoice
import com.serversherpa.kiosk.core.setup.SetupState
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class KioskPrefsTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var prefs: KioskPrefs

    @Before fun setUp() {
        scope = CoroutineScope(Dispatchers.IO + Job())
        prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "t.preferences_pb") })
    }

    @After fun tearDown() { scope.cancel() }

    @Test fun defaultsWhenEmpty() = runBlocking {
        assertEquals(SetupState.INCOMPLETE, prefs.setupState.first())
        assertNull(prefs.setupSelection.first())
        assertEquals(DEFAULT_APPEARANCE, prefs.appearance.first())
        assertEquals(DEFAULT_SOUND_SETTINGS, prefs.sound.first())
        assertEquals("pre_stage", prefs.checkpoint(CheckpointId.ENROLL).first())
        assertEquals(false, prefs.devMode.first())
        assertNull(prefs.apiUrl.first())
        assertNull(prefs.serial.first())
    }

    @Test fun roundTrips() = runBlocking {
        prefs.setSetupState(SetupState.COMPLETE)
        val sel = KioskSetupSelection("i", "Move", "s", "Site", "source", "pre_stage", "Pre-stage")
        prefs.setSetupSelection(sel)
        prefs.setAppearance(DEFAULT_APPEARANCE.copy(flashMs = 900))
        prefs.setSound(DEFAULT_SOUND_SETTINGS.copy(good = SoundChoice.None))
        prefs.setCheckpoint(CheckpointId.ENROLL, "received")
        prefs.setDevMode(true)
        prefs.setApiUrl("http://10.0.2.2:8000")
        prefs.setSerial("kiosk-android-x"); prefs.setName("Dock 4")
        assertEquals(SetupState.COMPLETE, prefs.setupState.first())
        assertEquals(sel, prefs.setupSelection.first())
        assertEquals(900, prefs.appearance.first().flashMs)
        assertEquals(SoundChoice.None, prefs.sound.first().good)
        assertEquals("received", prefs.checkpoint(CheckpointId.ENROLL).first())
        assertEquals(true, prefs.devMode.first())
        assertEquals("http://10.0.2.2:8000", prefs.apiUrl.first())
        assertEquals("kiosk-android-x", prefs.serial.first()); assertEquals("Dock 4", prefs.name.first())
        prefs.setSetupSelection(null); assertNull(prefs.setupSelection.first())
    }
}
```

`data/identity/IdentityTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.identity

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class IdentityTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var identity: Identity

    @Before fun setUp() {
        scope = CoroutineScope(Dispatchers.IO + Job())
        identity = Identity(KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "t.preferences_pb") }))
    }

    @After fun tearDown() { scope.cancel() }

    @Test fun serialIsGeneratedOnceAndStable() = runBlocking {
        val a = identity.get()
        val b = identity.get()
        assertTrue(a.serial.startsWith("kiosk-android-"))
        assertEquals(a.serial, b.serial)
        assertEquals("Kiosk " + a.serial.takeLast(4).uppercase(), a.name)
    }

    @Test fun nameValidation() = runBlocking {
        identity.get()
        assertFalse(identity.setName("   "))
        assertFalse(identity.setName("x".repeat(81)))
        assertTrue(identity.setName("  Dock 4 "))
        assertEquals("Dock 4", identity.get().name)
    }

    @Test fun helpers() {
        assertEquals("Kiosk AB12", defaultName("kiosk-android-0000-ab12"))
        assertTrue(newSerial().matches(Regex("kiosk-android-[0-9a-f-]{36}")))
    }
}
```

`data/config/KioskConfigTest.kt`:

```kotlin
package com.serversherpa.kiosk.data.config

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class KioskConfigTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var scope: CoroutineScope
    private lateinit var prefs: KioskPrefs
    private lateinit var config: KioskConfig

    @Before fun setUp() {
        scope = CoroutineScope(Dispatchers.IO + Job())
        prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "t.preferences_pb") })
        config = KioskConfig(prefs, "https://api.dev.serversherpa.com", "https://portal.dev.serversherpa.com", "0.1.0")
    }

    @After fun tearDown() { scope.cancel() }

    @Test fun defaultsThenOverride() = runBlocking {
        assertEquals("https://api.dev.serversherpa.com", config.apiUrlNow())
        assertEquals("https://portal.dev.serversherpa.com", config.portalUrlNow())
        prefs.setApiUrl("http://10.10.48.103:8000")
        assertEquals("http://10.10.48.103:8000", config.apiUrlNow())
        assertEquals("0.1.0", config.kioskVersion)
    }

    @Test fun normalize() {
        assertEquals("https://x.example", KioskConfig.normalizeUrl("  https://x.example/// "))
        assertNull(KioskConfig.normalizeUrl("x.example"))
        assertNull(KioskConfig.normalizeUrl("ftp://x"))
        assertNull(KioskConfig.normalizeUrl(""))
    }
}
```

Run → FAIL.

- [ ] **Step 2: Implement**

`data/prefs/KioskPrefs.kt`:

```kotlin
package com.serversherpa.kiosk.data.prefs

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.settings.Appearance
import com.serversherpa.kiosk.core.settings.CheckpointId
import com.serversherpa.kiosk.core.settings.SoundSettings
import com.serversherpa.kiosk.core.settings.parseAppearance
import com.serversherpa.kiosk.core.settings.parseSoundSettings
import com.serversherpa.kiosk.core.settings.toJson
import com.serversherpa.kiosk.core.setup.SetupState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json

/**
 * Every kiosk-local value the web kiosk kept in localStorage, in one
 * DataStore file. Keys keep the web's `ss.kiosk.*` names so the two apps
 * read the same way in a bug report.
 */
class KioskPrefs(private val store: DataStore<Preferences>) {
    private val json = Json { ignoreUnknownKeys = true }

    private object Keys {
        val setupState = stringPreferencesKey("ss.kiosk.setupState")
        val setupSelection = stringPreferencesKey("ss.kiosk.setup")
        val appearance = stringPreferencesKey("ss.kiosk.appearance")
        val sound = stringPreferencesKey("ss.kiosk.sound")
        val devMode = booleanPreferencesKey("ss.kiosk.devMode")
        val apiUrl = stringPreferencesKey("ss.kiosk.apiUrl")
        val portalUrl = stringPreferencesKey("ss.kiosk.portalUrl")
        val serial = stringPreferencesKey("ss.kiosk.serial")
        val name = stringPreferencesKey("ss.kiosk.name")
    }

    val setupState: Flow<SetupState> = store.data.map { SetupState.fromWire(it[Keys.setupState]) }
    suspend fun setSetupState(state: SetupState) { store.edit { it[Keys.setupState] = state.wire } }

    val setupSelection: Flow<KioskSetupSelection?> = store.data.map { p ->
        p[Keys.setupSelection]?.let { raw -> try { json.decodeFromString<KioskSetupSelection>(raw) } catch (e: Exception) { null } }
    }
    suspend fun setSetupSelection(selection: KioskSetupSelection?) {
        store.edit { if (selection == null) it.remove(Keys.setupSelection) else it[Keys.setupSelection] = json.encodeToString(KioskSetupSelection.serializer(), selection) }
    }

    val appearance: Flow<Appearance> = store.data.map { parseAppearance(it[Keys.appearance]) }
    suspend fun setAppearance(a: Appearance) { store.edit { it[Keys.appearance] = a.toJson() } }

    val sound: Flow<SoundSettings> = store.data.map { parseSoundSettings(it[Keys.sound]) }
    suspend fun setSound(s: SoundSettings) { store.edit { it[Keys.sound] = s.toJson() } }

    fun checkpoint(id: CheckpointId): Flow<String> = store.data.map { it[stringPreferencesKey(id.storageKey)]?.takeIf { v -> v.isNotBlank() } ?: id.fallback }
    suspend fun setCheckpoint(id: CheckpointId, key: String) { store.edit { it[stringPreferencesKey(id.storageKey)] = key } }

    val devMode: Flow<Boolean> = store.data.map { it[Keys.devMode] ?: false }
    suspend fun setDevMode(on: Boolean) { store.edit { it[Keys.devMode] = on } }

    val apiUrl: Flow<String?> = store.data.map { it[Keys.apiUrl] }
    suspend fun setApiUrl(url: String?) { store.edit { if (url == null) it.remove(Keys.apiUrl) else it[Keys.apiUrl] = url } }

    val portalUrl: Flow<String?> = store.data.map { it[Keys.portalUrl] }
    suspend fun setPortalUrl(url: String?) { store.edit { if (url == null) it.remove(Keys.portalUrl) else it[Keys.portalUrl] = url } }

    val serial: Flow<String?> = store.data.map { it[Keys.serial] }
    suspend fun setSerial(serial: String) { store.edit { it[Keys.serial] = serial } }

    val name: Flow<String?> = store.data.map { it[Keys.name] }
    suspend fun setName(name: String?) { store.edit { if (name == null) it.remove(Keys.name) else it[Keys.name] = name } }

    suspend fun snapshot(): Preferences = store.data.first()
}
```

`data/config/KioskConfig.kt`:

```kotlin
package com.serversherpa.kiosk.data.config

import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/** Runtime configuration: the stored URL wins, else the build default.
 *  Read per call — never cached at construction. */
class KioskConfig(
    private val prefs: KioskPrefs,
    private val defaultApiUrl: String,
    private val defaultPortalUrl: String,
    val kioskVersion: String,
) {
    val apiUrl: Flow<String> = prefs.apiUrl.map { normalizeUrl(it ?: "") ?: defaultApiUrl }
    val portalUrl: Flow<String> = prefs.portalUrl.map { normalizeUrl(it ?: "") ?: defaultPortalUrl }

    suspend fun apiUrlNow(): String = apiUrl.first()
    suspend fun portalUrlNow(): String = portalUrl.first()

    companion object {
        /** Trimmed, trailing slashes removed; only http(s) origins are accepted. */
        fun normalizeUrl(raw: String): String? {
            val v = raw.trim().trimEnd('/')
            if (v.isEmpty()) return null
            if (!v.startsWith("http://") && !v.startsWith("https://")) return null
            if (v.substringAfter("://").isEmpty()) return null
            return v
        }
    }
}
```

`data/identity/Identity.kt`:

```kotlin
package com.serversherpa.kiosk.data.identity

import com.serversherpa.kiosk.data.prefs.KioskPrefs
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

const val NAME_MAX = 80

data class KioskIdentity(val serial: String, val name: String)

fun newSerial(): String = "kiosk-android-${UUID.randomUUID()}"

fun defaultName(serial: String): String = "Kiosk ${serial.takeLast(4).uppercase()}"

/** Who this kiosk is: a serial generated once, and a friendly name. */
class Identity(private val prefs: KioskPrefs) {
    private val mutex = Mutex()

    /** Generates and persists the serial the first time it is asked for. */
    suspend fun get(): KioskIdentity {
        val serial = prefs.serial.first() ?: mutex.withLock {
            prefs.serial.first() ?: newSerial().also { prefs.setSerial(it) }
        }
        val stored = prefs.name.first()?.trim()
        return KioskIdentity(serial, if (stored.isNullOrEmpty()) defaultName(serial) else stored)
    }

    /** Live identity; emits once a serial exists (call get() at startup). */
    val identity: Flow<KioskIdentity> = combine(prefs.serial, prefs.name) { serial, name ->
        val s = serial ?: ""
        KioskIdentity(s, name?.trim()?.takeIf { it.isNotEmpty() } ?: defaultName(s))
    }

    /** Trims and stores; false when blank or too long. */
    suspend fun setName(name: String): Boolean {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || trimmed.length > NAME_MAX) return false
        prefs.setName(trimmed)
        return true
    }
}
```

- [ ] **Step 3: Run tests, build, commit**

```bash
./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.data.*' assembleDebug
git add -A Android_Kiosk_App
git commit -m "feat(android): DataStore-backed kiosk prefs, runtime config, and kiosk identity

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## End of Part 1

Continue with `docs/superpowers/plans/2026-09-15-android-kiosk-2-data-and-input.md` (API client, session, auth, heartbeat, Room, sync, outbox sender, scan bus, DataWedge, camera).
