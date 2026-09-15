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
