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
