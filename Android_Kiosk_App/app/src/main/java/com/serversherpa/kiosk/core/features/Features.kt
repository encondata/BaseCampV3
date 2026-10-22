package com.serversherpa.kiosk.core.features

import com.serversherpa.kiosk.core.setup.SetupState

enum class FeatureId { SETUP, SCAN, ENROLL, CONTAINERS, TRUCKS, LABELS, TIMECLOCK, SETTINGS, TIMECLOCK_STATION, ROLODEX }

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

/** Same order and copy as kiosk/src/lib/features.ts, except Label Printing: asset labels only here. */
val FEATURES: List<KioskFeature> = listOf(
    KioskFeature(FeatureId.SETUP, "setup", "Kiosk Setup", "Set up this kiosk for a move.", alwaysAvailable = true),
    KioskFeature(FeatureId.SCAN, "scan", "Scanning", "Scan assets, containers, and badges."),
    KioskFeature(FeatureId.ENROLL, "enroll", "RFID Enroll", "Scan an asset, then scan its RFID tag."),
    KioskFeature(FeatureId.CONTAINERS, "containers", "Containers", "Pack and unpack containers by scanning.", placeholder = true),
    KioskFeature(FeatureId.TRUCKS, "trucks", "Trucks", "Load and unload trucks by scanning.", placeholder = true),
    KioskFeature(FeatureId.LABELS, "labels", "Label Printing", "Print asset labels."),
    KioskFeature(FeatureId.TIMECLOCK, "timeclock", "Timeclock", "Clock in and out of a move."),
    KioskFeature(FeatureId.SETTINGS, "settings", "Settings", "Appearance, sound, devices, and more.", alwaysAvailable = true),
)

fun feature(id: FeatureId): KioskFeature = FEATURES.first { it.id == id }

/** A Time Clock station's Home tile (kiosk/src/lib/features.ts TIMECLOCK_STATION_FEATURE): it
 *  signs the person out and leaves the station on Welcome. Not in [FEATURES], and no route of
 *  its own: Home runs it. */
val TIMECLOCK_STATION_FEATURE = KioskFeature(FeatureId.TIMECLOCK_STATION, "timeclock-station", "Time Clock", "Start the time clock for workers.")

/** The Rolodex (admins look up, edit and photograph workers; native apps only, so not in
 *  [FEATURES], whose order is the web kiosk's). It needs no move or setup step. */
val ROLODEX_FEATURE = KioskFeature(FeatureId.ROLODEX, "rolodex", "Rolodex", "Find, edit, and photograph workers.", alwaysAvailable = true)

/** What Home shows (kiosk/src/lib/features.ts STATION_TILES; Jimmy owns these lists): a Time
 *  Clock station only Time Clock, Kiosk Setup and Settings; any other kiosk every feature, plus
 *  the Rolodex before Settings when [isAdmin] (rank 60+). Station Homes never get the Rolodex. */
fun homeFeatures(stationType: String?, isAdmin: Boolean = false): List<KioskFeature> = when {
    stationType == "timeclock" -> listOf(TIMECLOCK_STATION_FEATURE, feature(FeatureId.SETUP), feature(FeatureId.SETTINGS))
    isAdmin -> FEATURES.flatMap { if (it.id == FeatureId.SETTINGS) listOf(ROLODEX_FEATURE, it) else listOf(it) }
    else -> FEATURES
}

/** The feature whose route the nav destination is (route may carry `?tab=`). */
fun featureForRoute(route: String?): KioskFeature? {
    val base = route?.substringBefore('?')?.substringBefore('/') ?: return null
    return FEATURES.firstOrNull { it.route == base }
}

/** Always for alwaysAvailable features or in dev mode; otherwise only once setup is complete. */
fun featureAvailable(feature: KioskFeature, setupState: SetupState, devMode: Boolean = false): Boolean =
    devMode || feature.alwaysAvailable || setupState.isComplete
