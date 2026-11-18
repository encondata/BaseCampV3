plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Push notifications (FCM) read the Firebase project from app/google-services.json, which is
// committed once the project exists (it identifies the project; it is not a secret). Without it
// the plugin stays off: the app still builds, its tests run, and "This is my phone" reports that
// push isn't available in this build (data/push/FcmTokens.kt).
if (file("google-services.json").exists()) {
    apply(plugin = libs.plugins.google.services.get().pluginId)
}

android {
    namespace = "com.serversherpa.kiosk"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.serversherpa.kiosk"
        minSdk = 30
        targetSdk = 36
        versionCode = 2
        versionName = "0.1.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "KIOSK_VERSION", "\"$versionName\"")
        buildConfigField("String", "DEFAULT_PORTAL_URL", "\"https://portal.dev.serversherpa.com\"")
    }

    // The Play upload key lives outside the repo: ~/.gradle/gradle.properties holds the
    // serversherpaUpload* properties (keystore path + passwords). Without them the release
    // build stays unsigned, so a fresh checkout still assembles.
    val uploadStoreFile = providers.gradleProperty("serversherpaUploadStoreFile").orNull
    signingConfigs {
        if (uploadStoreFile != null) {
            create("upload") {
                storeFile = file(uploadStoreFile)
                storePassword = providers.gradleProperty("serversherpaUploadStorePassword").get()
                keyAlias = providers.gradleProperty("serversherpaUploadKeyAlias").get()
                keyPassword = providers.gradleProperty("serversherpaUploadKeyPassword").get()
            }
        }
    }

    // play: the Google Play build, with no self-update code. direct: the build installed from
    // devices.<env>, which checks that site for a newer APK. Same applicationId and version.
    flavorDimensions += "distribution"
    productFlavors {
        create("play") {
            dimension = "distribution"
            isDefault = true
        }
        create("direct") { dimension = "distribution" }
    }

    buildTypes {
        debug {
            buildConfigField("String", "DEFAULT_API_URL", "\"https://api.dev.serversherpa.com\"")
        }
        release {
            isMinifyEnabled = false
            signingConfigs.findByName("upload")?.let { signingConfig = it }
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
    sourceSets {
        // MigrationTestHelper loads exported schemas from the instrumentation context's assets,
        // and under Robolectric that is the tested variant's merged assets (src/test assets are
        // never merged). So the schemas ride in debug builds only (release stays clean), and
        // testReleaseUnitTest does not see them: run the migration tests with testDebugUnitTest.
        getByName("debug").assets.srcDir("$projectDir/schemas")
    }

}

ksp {
    arg("room.generateKotlin", "true")
    // Exported schemas are committed: MigrationTestHelper reads them to
    // build each old version for real (data/db/MigrationTest).
    arg("room.schemaLocation", "$projectDir/schemas")
}

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
    // The label generator (assets/labelgen.js) runs in an isolated V8 sandbox from the system WebView.
    implementation(libs.androidx.javascriptengine)
    implementation(libs.androidx.biometric)
    // MainActivity is a FragmentActivity (BiometricPrompt); never left to whatever appcompat pulls in.
    implementation(libs.androidx.fragment.ktx)
    // Push notifications. Only data/push/FirebaseFcmTokens.kt and the thin KioskMessagingService.kt
    // touch Firebase; tests use a fake and the logic around them.
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    // The RFIDAPI3 .aar is wired in as a raw local artifact (see
    // RFIDAPI3Library/build.gradle), not a real Maven/AAR dependency.
    implementation(project(":RFIDAPI3Library"))

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
