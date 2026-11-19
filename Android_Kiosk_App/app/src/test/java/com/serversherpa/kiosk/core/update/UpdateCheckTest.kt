package com.serversherpa.kiosk.core.update

import com.serversherpa.kiosk.core.ApiError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckTest {
    @Test fun devicesUrlSwapsApiForDevices() {
        assertEquals("https://devices.dev.serversherpa.com", devicesUrlFor("https://api.dev.serversherpa.com"))
        assertEquals("https://devices.serversherpa.com", devicesUrlFor("https://api.serversherpa.com/"))
        assertEquals("https://devices.dev.serversherpa.com:8443", devicesUrlFor("https://API.dev.serversherpa.com:8443"))
    }

    @Test fun devicesUrlIsNullWithoutAnApiHost() {
        listOf(
            "http://10.0.2.2:8010", "https://portal.dev.serversherpa.com",
            "https://myapi.example.com", "not a url",
        ).forEach { assertNull(it, devicesUrlFor(it)) }
    }

    @Test fun upToDate() {
        assertEquals(UpdateAnswer.UpToDate, UpdateAnswerWire("up_to_date").toAnswer())
    }

    @Test fun availableBecomesAnOffer() {
        val wire = UpdateAnswerWire(
            "available", version_name = "0.1.2", build = "3", notes = "Fixes", size = 123,
            install_url = "https://devices.x/dl/t/a.apk",
        )
        assertEquals(
            UpdateAnswer.Available(UpdateOffer("0.1.2", 3, "Fixes", 123, "https://devices.x/dl/t/a.apk")),
            wire.toAnswer(),
        )
    }

    @Test fun availableWithoutVersionNameUsesTheBuild() {
        val a = UpdateAnswerWire("available", build = "3", install_url = "https://d/x").toAnswer()
        assertEquals("3", (a as UpdateAnswer.Available).offer.versionName)
    }

    @Test fun availableMissingLinkOrWithBadBuildIsBad() {
        assertEquals(UpdateAnswer.Blocked(BAD_ANSWER), UpdateAnswerWire("available", build = "3").toAnswer())
        assertEquals(
            UpdateAnswer.Blocked(BAD_ANSWER),
            UpdateAnswerWire("available", build = "x", install_url = "https://d/x").toAnswer(),
        )
        assertEquals(
            UpdateAnswer.Blocked(BAD_ANSWER),
            UpdateAnswerWire("available", install_url = "https://d/x").toAnswer(),
        )
    }

    @Test fun blockedStatusesCarryTheMessage() {
        assertEquals(UpdateAnswer.Blocked("M"), UpdateAnswerWire("reinstall_required", message = "M").toAnswer())
        assertEquals(UpdateAnswer.Blocked("Reg"), UpdateAnswerWire("register_first", message = "Reg").toAnswer())
        assertEquals(UpdateAnswer.Blocked(BAD_ANSWER), UpdateAnswerWire("preparing").toAnswer())
        assertEquals(UpdateAnswer.Blocked(BAD_ANSWER), UpdateAnswerWire("whatever").toAnswer())
    }

    @Test fun failureMessages() {
        assertEquals(
            "Couldn't reach devices.dev.serversherpa.com. Try again later.",
            checkFailureMessage(ApiError(0, "network"), "devices.dev.serversherpa.com"),
        )
        assertEquals(
            "The Devices site answered 502. Try again later.",
            checkFailureMessage(ApiError(502, "x"), "devices.dev.serversherpa.com"),
        )
    }

    @Test fun aRefusedSignInMatchesTheIosCopy() {
        for (status in listOf(401, 403)) {
            assertEquals(
                "The Devices site couldn't confirm this sign-in. Try again later.",
                checkFailureMessage(ApiError(status, "x"), "devices.dev.serversherpa.com"),
            )
        }
    }

    @Test fun recheckAfterAnHour() {
        assertTrue(shouldRecheck(null, 5L))
        assertFalse(shouldRecheck(1_000L, 1_000L + 3_599_999L))
        assertTrue(shouldRecheck(1_000L, 1_000L + 3_600_000L))
    }
}
