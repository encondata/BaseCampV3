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
        unitTests.all {
            // The Zebra RFIDAPI3 .aar (see project(":RFIDAPI3Library")) bundles an
            // incomplete vendor copy of Apache Xerces plus META-INF/services JAXP
            // registration files. Those hijack DocumentBuilderFactory resolution on the
            // unit test JVM's classpath toward the broken vendor impl; without this
            // override, every Robolectric-backed test that parses AndroidManifest.xml
            // fails with NoClassDefFoundError: org.apache.xerces.impl.dv.ObjectFactory.
            it.systemProperty(
                "javax.xml.parsers.DocumentBuilderFactory",
                "com.sun.org.apache.xerces.internal.jaxp.DocumentBuilderFactoryImpl",
            )
        }
    }

    packaging {
        resources {
            // The Zebra RFIDAPI3 .aar bundles JAXP META-INF/services registration files
            // (see the systemProperty override above for the unit-test-side symptom).
            // These land unmodified in the packaged APK and would hijack
            // DocumentBuilderFactory/SAXParserFactory/etc. resolution at runtime on a
            // real device toward the vendor's incomplete Xerces bundle, which is
            // missing classes it needs. Exclude exactly the entries confirmed present
            // in app-debug.apk; nothing else is swept up.
            excludes += setOf(
                "META-INF/services/javax.xml.datatype.DatatypeFactory",
                "META-INF/services/javax.xml.parsers.DocumentBuilderFactory",
                "META-INF/services/javax.xml.parsers.SAXParserFactory",
                "META-INF/services/javax.xml.stream.XMLEventFactory",
                "META-INF/services/javax.xml.validation.SchemaFactory",
                "META-INF/services/org.w3c.dom.DOMImplementationSourceList",
                "META-INF/services/org.xml.sax.driver",
            )
            // AGP's default `merges` set includes "/META-INF/services/**" and takes
            // precedence over `excludes` for matching paths, so the excludes above are
            // silently ignored unless this default is narrowed first. Removing it does
            // not drop any legitimate service file: the app's only other
            // META-INF/services/* entries (kotlinx.coroutines' CoroutineExceptionHandler
            // and MainDispatcherFactory) each come from a single dependency, so they
            // pass straight through with no duplicate to merge.
            merges -= "/META-INF/services/**"
        }
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
    implementation(project(":RFIDAPI3Library"))
    // The RFIDAPI3 .aar is wired in as a raw local artifact (see
    // RFIDAPI3Library/build.gradle), not a real Maven/AAR dependency, and its
    // Readers/API3Service/API3UsbService classes call four methods on the
    // OLD android.support.v4.content.LocalBroadcastManager (getInstance,
    // registerReceiver, unregisterReceiver, sendBroadcast) — confirmed by
    // javap against classes.jar; that's the entire support-library surface
    // the vendor code touches. AGP's Jetifier *does* still transform this
    // artifact (verified: it rewrites those refs to
    // androidx/localbroadcastmanager/content/LocalBroadcastManager), but
    // flipping android.enableJetifier on doesn't supply that androidx class
    // either — Jetifier only rewrites bytecode, it never adds the target
    // dependency, so without this the app would just trade one
    // NoClassDefFoundError for another. Depending directly on the real
    // legacy artifact instead sidesteps Jetifier and rewriting entirely: the
    // vendor .aar's bytecode is left completely alone, and the exact old
    // package name it expects resolves as-is.
    //
    // localbroadcastmanager is its own standalone artifact, not bundled in
    // support-compat (checked: support-compat 27.1.1 and 28.0.0 both lack
    // the class; it only showed up pulled in transitively under
    // support-core-utils, which also drags in support-compat, documentfile,
    // loader and print — support-compat's manifest overrides
    // android:appComponentFactory and collides with androidx-core's, which
    // fails the manifest merge). Depending on localbroadcastmanager alone
    // avoids all of that: it pulls in only support-annotations (a
    // plain-jar, manifest-free annotations library), and its own manifest
    // declares nothing that conflicts with AndroidX.
    implementation("com.android.support:localbroadcastmanager:28.0.0")

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
