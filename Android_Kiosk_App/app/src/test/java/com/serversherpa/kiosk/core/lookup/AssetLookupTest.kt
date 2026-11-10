package com.serversherpa.kiosk.core.lookup

import com.serversherpa.kiosk.core.model.KioskAssetFull
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssetLookupTest {
    private fun a(
        id: String, tag: String = "", name: String? = null, serial: String? = null,
        rfid: String? = null, container: String? = null,
    ) = LocalAsset(id = id, asset_id = tag, name = name, serial_number = serial, rfid = rfid, container_id = container)

    private fun data(assets: List<LocalAsset>, moveId: String = "m1") = LocalLookupData(
        assets, mapOf("c1" to "Crate 7"), moveId, "Move One", "Src", "Dst",
    )

    @Test fun assetTagMatchesOnlyPlainDigits() {
        val xs = listOf(a("1", tag = "102466"))
        assertTrue(matchLocal(xs, "0102466").matches.isEmpty())
        assertTrue(matchLocal(xs, "12a").matches.isEmpty())
        val r = matchLocal(xs, "102466")
        assertEquals(listOf("asset_tag"), r.matches.single().matched)
    }

    @Test fun serialIgnoresCaseAndSpaces() {
        val xs = listOf(a("1", serial = " ab12 "))
        assertEquals(listOf("serial"), matchLocal(xs, " AB12 ").matches.single().matched)
    }

    @Test fun rfidMatchesPaddedOrNot() {
        val xs = listOf(a("1", rfid = "000000000000000000100418"))
        assertEquals(1, matchLocal(xs, "100418").matches.size)
        assertEquals(listOf("rfid"), matchLocal(xs, "000000000000000000100418").matches.single().matched)
    }

    @Test fun oneValueOnTwoDevicesListsBothWithKinds() {
        val xs = listOf(a("A", tag = "102466", name = "A"), a("B", rfid = "000000000000000000102466", name = "B"))
        val r = matchLocal(xs, "102466")
        assertEquals(2, r.matches.size)
        assertEquals(listOf("asset_tag"), r.matches[0].matched)
        assertEquals(listOf("rfid"), r.matches[1].matched)
    }

    @Test fun nameFallbackOnlyWithoutExactHit() {
        val xs = listOf(a("1", name = "Switch 55", serial = "SW55"), a("2", name = "Router sw"))
        val r = matchLocal(xs, "sw55")
        assertEquals(listOf("serial"), r.matches.single().matched)
        val n = matchLocal(xs, "sw")
        assertEquals(2, n.matches.size)
        assertEquals(listOf("name"), n.matches[0].matched)
    }

    @Test fun capAt25Truncates() {
        val xs = (1..30).map { a("$it", name = "Box $it") }
        val r = matchLocal(xs, "box")
        assertEquals(25, r.matches.size)
        assertTrue(r.truncated)
        assertFalse(matchLocal(xs.take(25), "box").truncated)
    }

    @Test fun sortsNaturally() {
        val xs = listOf(a("1", name = "Rack 10"), a("2", name = "Rack 2"))
        assertEquals(listOf("Rack 2", "Rack 10"), matchLocal(xs, "rack").matches.map { it.name })
    }

    @Test fun emptyValueFindsNothing() {
        assertTrue(matchLocal(listOf(a("1", name = "x")), "   ").matches.isEmpty())
    }

    @Test fun localDetailHidesFullBelowAdmin() {
        val x = a("1", tag = "5")
        val d = localDetail(x, data(listOf(x)), false)
        assertNull(d.full)
        assertEquals(1, d.routes.size)
        assertEquals("Src", d.routes[0].source.site_name)
        assertEquals("Dst", d.routes[0].destination.site_name)
        assertEquals("5", d.asset_tag)
    }

    @Test fun localDetailAdminHasContainerNameNoTruckNoColor() {
        val x = a("1", tag = "5", container = "c1").copy(asset_status = "ok", asset_status_label = "OK", location_detail = null)
        val f = localDetail(x, data(listOf(x)), true).full!!
        assertEquals("Crate 7", f.container_name)
        assertNull(f.truck_name)
        assertEquals("", f.status_color)
        assertEquals("ok", f.status)
        assertEquals("", f.location_detail)
        assertEquals("m1", f.moves.single().initiative_id)
        assertEquals("", f.moves.single().status)
        val none = localDetail(x, data(listOf(x), moveId = ""), true).full!!
        assertTrue(none.moves.isEmpty())
    }

    @Test fun placementTextForms() {
        assertEquals("C · on T", placementText(KioskAssetFull(container_name = "C", truck_name = "T")))
        assertEquals("C", placementText(KioskAssetFull(container_name = "C")))
        assertEquals("Dock", placementText(KioskAssetFull(location_detail = "Dock")))
        assertEquals("", placementText(KioskAssetFull()))
    }

    @Test fun scanWhenTextIs24Hour() {
        assertEquals("2026-11-08 21:05", scanWhenText("2026-11-08T21:05:00Z", ZoneOffset.UTC))
        assertEquals("not a date", scanWhenText("not a date", ZoneOffset.UTC))
    }

    @Test fun matchLabels() {
        assertEquals("Asset tag", matchLabel("asset_tag"))
        assertEquals("Serial", matchLabel("serial"))
        assertEquals("RFID", matchLabel("rfid"))
        assertEquals("Name", matchLabel("name"))
    }

    @Test fun distinctTagsDedupesPadded() {
        assertEquals(
            listOf("000000000000000000100418"),
            distinctTags(listOf("100418", "000000000000000000100418", "ZZ!")),
        )
    }
}
