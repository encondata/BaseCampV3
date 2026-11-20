package com.serversherpa.kiosk.core.environment

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EnvironmentsTest {
    private fun body(entries: String, version: String = "1") = """{"version": $version, "environments": [$entries]}"""
    private fun entry(id: String, name: String, domain: String) = """{"id":"$id","name":"$name","domain":"$domain"}"""
    private val good = entry("rc1", "RC1", "rc1.serversherpa.com") + "," + entry("qa", "QA", "qa.serversherpa.com")

    @Test fun builtInOrderAndUrls() {
        assertEquals(listOf("prod", "rc1", "uat", "beta", "alpha", "dev"), Environments.BUILT_IN.map { it.id })
        assertEquals("https://api.serversherpa.com", Environments.BUILT_IN[0].apiUrl)
        assertEquals("https://portal.uat.serversherpa.com", Environments.BUILT_IN[2].portalUrl)
        assertEquals("UAT", Environments.byId("uat")?.name)
        assertNull(Environments.byId("nope"))
        assertEquals(listOf("prod"), Environments.BUILT_IN.map { SavedEnvironment.Named(it.id, it.name, it.domain) }
            .filter { it.isProd }.map { it.id })
    }

    @Test fun parseDropsBadEntriesKeepsGood() {
        val raw = body(listOf(
            entry("x", "X", "evil.com"),
            entry("y", "Y", "api.serversherpa.com:443"),
            entry("z", "Z", "serversherpa.com/p"),
            entry("Bad", "B", "b.serversherpa.com"),
            entry("rc1", "RC1", "rc1.serversherpa.com"),
            entry("rc1", "dup", "x.serversherpa.com"),
            entry("n", "  ", "n.serversherpa.com"),
        ).joinToString(","))
        val envs = Environments.parseList(raw)!!
        assertEquals(listOf(Env("rc1", "RC1", "rc1.serversherpa.com")), envs)
    }

    @Test fun parseKeepsFileOrderAndTrimsName() {
        val envs = Environments.parseList(body(entry("qa", " QA ", "qa.serversherpa.com") + "," + entry("ab", "AB", "serversherpa.com")))!!
        assertEquals(listOf("qa", "ab"), envs.map { it.id })
        assertEquals("QA", envs[0].name)
    }

    @Test fun parseRejectsWrongVersionEmptyAndBadJson() {
        assertNull(Environments.parseList(body(good, version = "2")))
        assertNull(Environments.parseList(body("")))
        assertNull(Environments.parseList("{not json"))
        assertNull(Environments.parseList("[]"))
        assertNull(Environments.parseList(body(entry("a".repeat(30), "X".repeat(70000), "a.serversherpa.com"))))
    }

    @Test fun parseIdRules() {
        for (bad in listOf("a", "ab-", "1ab", "a".repeat(33))) {
            assertNull(bad, Environments.parseList(body(entry(bad, "N", "n.serversherpa.com"))))
        }
    }

    @Test fun migrateNamedFromTypedApi() {
        val uat = SavedEnvironment.Named("uat", "UAT", "uat.serversherpa.com")
        assertEquals(uat, Environments.migrate("https://api.uat.serversherpa.com/", null, "https://portal.x"))
        assertEquals(uat, Environments.migrate(" HTTPS://API.UAT.serversherpa.com:443 ", "http://other", "https://portal.x"))
        assertEquals(SavedEnvironment.Named("prod", "Prod", "serversherpa.com"),
            Environments.migrate("https://api.serversherpa.com", null, "https://portal.x"))
    }

    @Test fun migrateCustom() {
        assertEquals(SavedEnvironment.Custom("http://10.10.48.103:8000", "http://10.10.48.103:5173"),
            Environments.migrate("http://10.10.48.103:8000", "http://10.10.48.103:5173/", "https://portal.x"))
        assertEquals(SavedEnvironment.Custom("http://10.10.48.103:8000", "https://portal.x"),
            Environments.migrate("http://10.10.48.103:8000", null, "https://portal.x"))
        // http, another port or a path is not the built-in address
        assertTrue(Environments.migrate("http://api.uat.serversherpa.com", null, "p") is SavedEnvironment.Custom)
        assertTrue(Environments.migrate("https://api.uat.serversherpa.com:8443", null, "p") is SavedEnvironment.Custom)
        assertTrue(Environments.migrate("https://api.uat.serversherpa.com/v1", null, "p") is SavedEnvironment.Custom)
    }

    @Test fun migrateNothingSaved() {
        assertNull(Environments.migrate(null, null, "https://portal.x"))
        assertNull(Environments.migrate("  ", "http://p", "https://portal.x"))
        assertNull(Environments.migrate("ftp://nope", null, "https://portal.x"))
    }

    @Test fun serializationRoundTrip() {
        val named: SavedEnvironment = SavedEnvironment.Named("uat", "UAT", "uat.serversherpa.com")
        val custom: SavedEnvironment = SavedEnvironment.Custom("http://a:1", "http://p:2")
        val namedJson = Json.encodeToString(SavedEnvironment.serializer(), named)
        val customJson = Json.encodeToString(SavedEnvironment.serializer(), custom)
        assertEquals("""{"kind":"named","id":"uat","name":"UAT","domain":"uat.serversherpa.com"}""", namedJson)
        assertEquals("""{"kind":"custom","api_url":"http://a:1","portal_url":"http://p:2"}""", customJson)
        assertEquals(named, Json.decodeFromString(SavedEnvironment.serializer(), namedJson))
        assertEquals(custom, Json.decodeFromString(SavedEnvironment.serializer(), customJson))
    }

    @Test fun savedEnvironmentProperties() {
        val prod = SavedEnvironment.Named("prod", "Prod", "serversherpa.com")
        val rc = SavedEnvironment.Named("rc1", "RC1", "rc1.serversherpa.com")
        val custom = SavedEnvironment.Custom("http://a:1", "http://p:2")
        assertTrue(prod.isProd); assertTrue(!rc.isProd); assertTrue(!custom.isProd)
        assertEquals("https://api.rc1.serversherpa.com", rc.apiUrl)
        assertEquals("https://portal.serversherpa.com", prod.portalUrl)
        assertEquals("http://a:1", custom.apiUrl); assertEquals("http://p:2", custom.portalUrl)
        assertEquals("RC1", rc.label); assertEquals("Custom", custom.label)
    }
}
