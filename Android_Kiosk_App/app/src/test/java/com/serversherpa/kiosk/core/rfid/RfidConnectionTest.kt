package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Test

class RfidConnectionTest {
    @Test fun eachStateReadsAsASentenceAnOperatorCanAct0n() {
        assertEquals("Off. Turn the reader on to use the sled.", connectionLine(RfidConnection.Disabled))
        assertEquals("Not connected.", connectionLine(RfidConnection.Disconnected))
        assertEquals("Connecting…", connectionLine(RfidConnection.Connecting))
        assertEquals("Connected to RFD4030 · battery 74%", connectionLine(RfidConnection.Connected("RFD4030", 74)))
        assertEquals("Connected to RFD4030", connectionLine(RfidConnection.Connected("RFD4030", null)))
        assertEquals("No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first.",
            connectionLine(RfidConnection.Failed("No RFID reader found. Pair the RFD40 in Android's Bluetooth settings first.")))
    }
}
