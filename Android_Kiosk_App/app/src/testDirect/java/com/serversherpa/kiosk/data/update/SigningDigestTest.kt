package com.serversherpa.kiosk.data.update

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SigningDigestTest {
    @Test fun hexIsLowerCaseSha256() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            SigningDigest.hex("abc".toByteArray()),
        )
    }

    @Test fun ofReturns64HexOrEmpty() {
        val digest = SigningDigest.of(ApplicationProvider.getApplicationContext())
        assertTrue(digest, Regex("^([0-9a-f]{64})?$").matches(digest))
    }
}
