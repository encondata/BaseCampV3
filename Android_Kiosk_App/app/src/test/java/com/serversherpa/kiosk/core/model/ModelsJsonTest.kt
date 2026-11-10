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

    @Test fun lookupModelsDecodeTheApiShape() {
        val res = json.decodeFromString<KioskLookupResult>("""{"matches":[{"id":"a1","name":"Core","asset_tag":"T-1","serial_number":"S1","matched":["asset_tag","rfid"]},{"id":"a2","name":null,"asset_tag":"T-2","serial_number":null,"matched":["name"]}],"truncated":true}""")
        assertEquals(2, res.matches.size); assertEquals(listOf("asset_tag", "rfid"), res.matches[0].matched)
        assertNull(res.matches[1].name); assertEquals(true, res.truncated)

        val full = json.decodeFromString<KioskAssetDetail>("""{"id":"a1","name":"Core","make":"Dell","model":"R740","make_model":"Dell R740","asset_tag":"T-1","serial_number":"S1","rfid":"E200",
          "routes":[{"initiative_id":"i1","initiative_name":"Move A","source":{"site_name":"Origin","rack":"R1","ru":"12"},"destination":{"site_name":"Dest","pod":"P2","position":"3"}}],
          "full":{"status":"staged","status_label":"Staged","status_color":"#abc","moves":[{"initiative_id":"i1","initiative_name":"Move A","status":"staged","status_label":"Staged","status_color":"#abc"}],"container_name":"C-9","truck_name":null,"location_detail":"Dock"}}""")
        assertEquals("Dell R740", full.make_model); assertEquals("E200", full.rfid)
        assertEquals("Origin", full.routes[0].source.site_name); assertEquals("R1", full.routes[0].source.rack); assertNull(full.routes[0].source.pod)
        assertEquals("3", full.routes[0].destination.position)
        assertEquals("Staged", full.full?.status_label); assertEquals("C-9", full.full?.container_name); assertEquals(1, full.full?.moves?.size)
        val bare = json.decodeFromString<KioskAssetDetail>("""{"id":"a1","asset_tag":"T-1","routes":[],"full":null}""")
        assertNull(bare.full); assertEquals("", bare.make_model)

        val scans = json.decodeFromString<List<AssetScanRow>>("""[{"id":"s1","scanned_value":"T-1","scan_type":"pre_stage","scan_type_label":"Pre-stage","scan_type_color":"#abc","status":null,"scanned_at":"2026-11-10T09:00:00Z","device_id":"d1","operator_name":"Tina","site_name":"Origin","location_detail":"R1","off_move":true,"extra":"x"},
          {"id":"s2","scanned_at":"2026-11-10T08:00:00Z"}]""")
        assertEquals(true, scans[0].off_move); assertEquals("Pre-stage", scans[0].scan_type_label); assertEquals("Tina", scans[0].operator_name)
        assertEquals(false, scans[1].off_move); assertEquals("", scans[1].device_id)
    }
}
