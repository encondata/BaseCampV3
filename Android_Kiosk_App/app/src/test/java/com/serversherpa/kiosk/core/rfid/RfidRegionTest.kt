package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Test

class RfidRegionTest {
    private fun region(code: String, name: String, hopping: Boolean = false) =
        RfidRegion(code, name, hoppingConfigurable = hopping, channels = emptyList())

    private val usa = region("USA", "United States")
    private val eu = region("ETSI", "Europe", hopping = true)

    @Test fun nothingReportedIsUnknownRatherThanAnEmptyChoice() {
        assertEquals(RegionChoice.Unknown, regionChoice(RfidRegions(emptyList(), null)))
        assertEquals(RegionChoice.Unknown, regionChoice(RfidRegions(emptyList(), "USA")))
        assertEquals("Connect the reader to see its regions.", regionLine(RegionChoice.Unknown))
    }

    /** A region-locked reader states a fact; it does not offer a choice. */
    @Test fun oneRegionIsLocked() {
        val choice = regionChoice(RfidRegions(listOf(usa), "USA"))
        assertEquals(RegionChoice.Locked(usa), choice)
        assertEquals("This reader supports only United States (USA).", regionLine(choice))
    }

    @Test fun severalRegionsAreChoosableAndTheActiveOneIsResolved() {
        val choice = regionChoice(RfidRegions(listOf(usa, eu), "ETSI"))
        assertEquals(RegionChoice.Choosable(listOf(usa, eu), eu), choice)
        assertEquals("Set to Europe (ETSI).", regionLine(choice))
    }

    /** A reader that names an active region we were not offered must not make
     *  one up; the row says nothing is set rather than inventing an entry. */
    @Test fun anActiveCodeThatMatchesNothingResolvesToNull() {
        val choice = regionChoice(RfidRegions(listOf(usa, eu), "NOWHERE"))
        assertEquals(RegionChoice.Choosable(listOf(usa, eu), null), choice)
        assertEquals("No region set on this reader yet.", regionLine(choice))
    }

    @Test fun aNullActiveCodeIsAlsoNoRegionSet() {
        assertEquals(RegionChoice.Choosable(listOf(usa, eu), null), regionChoice(RfidRegions(listOf(usa, eu), null)))
    }

    /** The code is matched exactly as the reader spells it, with surrounding
     *  space ignored — some readers pad the value. */
    @Test fun theActiveCodeIsMatchedIgnoringSurroundingSpace() {
        assertEquals(RegionChoice.Choosable(listOf(usa, eu), usa), regionChoice(RfidRegions(listOf(usa, eu), "  USA ")))
    }

    /** A reader that reports its active region in a different case still resolves
     *  to the listed region, and the line reads as that region being set. */
    @Test fun aCaseInsensitiveActiveCodeStillResolvesToTheListedRegion() {
        assertEquals(RegionChoice.Choosable(listOf(usa, eu), usa), regionChoice(RfidRegions(listOf(usa, eu), "usa")))
        assertEquals("Set to United States (USA).", regionLine(RegionChoice.Choosable(listOf(usa, eu), usa)))
    }
}
