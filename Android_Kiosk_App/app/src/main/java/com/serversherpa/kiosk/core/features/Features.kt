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
