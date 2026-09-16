package com.serversherpa.kiosk.core.devices

import org.junit.Assert.assertEquals
import org.junit.Test

class RegistrationTest {
    private val now = 1_700_000_000_000L

    @Test fun thresholds() {
        assertEquals(RegistrationState.NONE, tokenExpiryState(null, now))
        assertEquals(RegistrationState.NONE, tokenExpiryState("garbage", now))
        assertEquals(RegistrationState.EXPIRED, tokenExpiryState(java.time.Instant.ofEpochMilli(now - 1).toString(), now))
        assertEquals(RegistrationState.SOON, tokenExpiryState(java.time.Instant.ofEpochMilli(now + SOON_MS).toString(), now))
        assertEquals(RegistrationState.OK, tokenExpiryState(java.time.Instant.ofEpochMilli(now + SOON_MS + 1).toString(), now))
    }

    @Test fun labels() {
        assertEquals("Registered", RegistrationState.OK.label)
        assertEquals("Unregistered", RegistrationState.fromWire("bogus").label)
        assertEquals("Expires soon", registrationLabel(RegistrationState.SOON))
    }
}
