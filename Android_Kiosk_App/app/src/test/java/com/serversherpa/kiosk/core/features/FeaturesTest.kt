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

    @Test fun placeholdersAreContainersAndTrucks() {
        assertEquals(setOf(FeatureId.CONTAINERS, FeatureId.TRUCKS), FEATURES.filter { it.placeholder }.map { it.id }.toSet())
    }

    @Test fun labelPrintingIsAssetLabels() {
        assertEquals("Print asset labels.", feature(FeatureId.LABELS).blurb)
        assertEquals(FeatureId.LABELS, featureForRoute("labels/print")?.id)
        assertEquals(FeatureId.LABELS, featureForRoute("labels/printer")?.id)
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

    @Test fun aTimeClockStationHomeHasThreeTiles() {
        assertEquals(listOf(FeatureId.TIMECLOCK_STATION, FeatureId.SETUP, FeatureId.SETTINGS), homeFeatures("timeclock").map { it.id })
        assertEquals("Time Clock", homeFeatures("timeclock").first().title)
        assertEquals("Start the time clock for workers.", homeFeatures("timeclock").first().blurb)
        assertEquals(FEATURES, homeFeatures(null))
        assertEquals(FEATURES, homeFeatures("label"))                  // no Label or RFID station on Android
    }

    // ── Rolodex: admins only, on the full Home only (spec §3.1) ──

    @Test fun anAdminsFullHomeHasTheRolodexBeforeSettings() {
        val ids = homeFeatures(null, isAdmin = true).map { it.id }
        assertTrue(FeatureId.ROLODEX in ids)
        assertEquals(ids.indexOf(FeatureId.SETTINGS) - 1, ids.indexOf(FeatureId.ROLODEX))
        assertEquals(FEATURES.size + 1, ids.size)
        assertEquals("rolodex", ROLODEX_FEATURE.route)
        assertEquals("Rolodex", ROLODEX_FEATURE.title)
        // Ruling S16: the same words as the iOS tile.
        assertEquals("Look up workers, edit their details, and take photos.", ROLODEX_FEATURE.blurb)
        // No move or setup step: the tile is usable on a kiosk that isn't set up.
        assertTrue(featureAvailable(ROLODEX_FEATURE, SetupState.INCOMPLETE))
    }

    @Test fun aNonAdminNeverSeesTheRolodex() {
        assertFalse(FeatureId.ROLODEX in homeFeatures(null, isAdmin = false).map { it.id })
        assertEquals(FEATURES, homeFeatures(null, isAdmin = false))
    }

    @Test fun aTimeClockStationHomeNeverHasTheRolodex() {
        assertEquals(listOf(FeatureId.TIMECLOCK_STATION, FeatureId.SETUP, FeatureId.SETTINGS), homeFeatures("timeclock", isAdmin = true).map { it.id })
    }

    /** The parity lists stay as they were: the Rolodex is a tile outside FEATURES. */
    @Test fun theRolodexStaysOutOfFeatures() {
        assertFalse(FEATURES.any { it.id == FeatureId.ROLODEX })
    }
}
