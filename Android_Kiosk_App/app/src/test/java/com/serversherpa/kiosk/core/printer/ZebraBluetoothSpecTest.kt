package com.serversherpa.kiosk.core.printer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Bluetooth limits, UUIDs and copy the GATT link is built on. */
class ZebraBluetoothSpecTest {
    @Test fun zebraSerialNames() {
        assertTrue(ZebraBluetoothSpec.looksLikeZebraSerial("D8J224508535"))
        assertTrue(ZebraBluetoothSpec.looksLikeZebraSerial("50J123456789"))
        assertFalse(ZebraBluetoothSpec.looksLikeZebraSerial("d8j224508535"))
        assertFalse(ZebraBluetoothSpec.looksLikeZebraSerial("D8J22450853"))
        assertFalse(ZebraBluetoothSpec.looksLikeZebraSerial("D8J2245085355"))
        assertFalse(ZebraBluetoothSpec.looksLikeZebraSerial("Jimmy's Pixel"))
        assertFalse(ZebraBluetoothSpec.looksLikeZebraSerial("N017E"))
        assertFalse(ZebraBluetoothSpec.looksLikeZebraSerial(""))
        // a line break after a good name is not part of the name
        assertFalse(ZebraBluetoothSpec.looksLikeZebraSerial("D8J224508535\n"))
    }

    @Test fun sendBudgetGrowsWithSize() {
        assertEquals(15_000L, ZebraBluetoothSpec.sendBudgetMs(0))
        assertEquals(16_000L, ZebraBluetoothSpec.sendBudgetMs(2_048))
        assertEquals(98_007.0, ZebraBluetoothSpec.sendBudgetMs(170_000).toDouble(), 1.0)
    }

    @Test fun chunkFromMtu() {
        assertEquals(244, ZebraBluetoothSpec.chunkBytes(247))
        assertEquals(20, ZebraBluetoothSpec.chunkBytes(null))
        assertEquals(20, ZebraBluetoothSpec.chunkBytes(23))
        // below the ATT minimum is no MTU at all
        assertEquals(20, ZebraBluetoothSpec.chunkBytes(22))
        assertEquals(20, ZebraBluetoothSpec.chunkBytes(0))
        assertEquals(21, ZebraBluetoothSpec.chunkBytes(24))
    }

    @Test fun theLimitsAreTheSpecifiedOnes() {
        assertEquals(247, ZebraBluetoothSpec.REQUESTED_MTU)
        assertEquals(10_000L, ZebraBluetoothSpec.CONNECT_READY_MS)
        assertEquals(2_000L, ZebraBluetoothSpec.QUERY_IDLE_MS)
        assertEquals(5_000L, ZebraBluetoothSpec.QUERY_TOTAL_MS)
        assertEquals(300L, ZebraBluetoothSpec.DRAIN_QUIET_MS)
        assertEquals(1_000L, ZebraBluetoothSpec.DRAIN_MAX_MS)
        assertEquals(3, ZebraBluetoothSpec.RECONNECT_TRIES)
        assertEquals(3_000L, ZebraBluetoothSpec.RECONNECT_SPACING_MS)
        assertEquals(30_000L, ZebraBluetoothSpec.SCAN_MS)
    }

    @Test fun theUuidsAreZebrasAndTheStandardDeviceInformationOnes() {
        assertEquals("38EB4A80-C570-11E3-9507-0002A5D5C51B", ZebraBluetoothSpec.SERVICE_UUID)
        assertEquals("38EB4A81-C570-11E3-9507-0002A5D5C51B", ZebraBluetoothSpec.FROM_PRINTER_UUID)
        assertEquals("38EB4A82-C570-11E3-9507-0002A5D5C51B", ZebraBluetoothSpec.TO_PRINTER_UUID)
        assertEquals("FE79", ZebraBluetoothSpec.ZEBRA_MEMBER_UUID)
        assertEquals("180A", ZebraBluetoothSpec.DEVICE_INFO_UUID)
        assertEquals("2A29", ZebraBluetoothSpec.MANUFACTURER_UUID)
        assertEquals("2A24", ZebraBluetoothSpec.MODEL_UUID)
        assertEquals("2A25", ZebraBluetoothSpec.SERIAL_UUID)
        assertEquals("2A26", ZebraBluetoothSpec.FIRMWARE_UUID)
        assertEquals("2A28", ZebraBluetoothSpec.LINK_OS_UUID)
        assertEquals("00002902-0000-1000-8000-00805f9b34fb", ZebraBluetoothSpec.CCCD_UUID)
    }

    @Test fun theCopyIsTheAgreedWording() {
        assertEquals("Turn on Bluetooth to reach the printer.", BLUETOOTH_OFF_TEXT)
        assertEquals("Allow Bluetooth for ServerSherpa Kiosk in Settings to reach the printer.", BLUETOOTH_DENIED_TEXT)
        assertEquals("Turn on Location to find Bluetooth printers on this device.", LOCATION_OFF_TEXT)
        assertEquals(
            "Don't see the printer? Hold FEED on the printer for 5 seconds (the middle light blinks), then scan again. " +
                "A Zebra's Bluetooth name is its serial number, like D8J224508535.",
            BLUETOOTH_SCAN_HINT_TEXT,
        )
        assertEquals("The font install was cut off. Turn the printer off and on, then tap Check again.", FONT_INSTALL_CUT_TEXT)
        assertEquals(
            "The printer forgot this device. Open Android Settings › Connected devices, forget D8J224508535, " +
                "then come back and tap Connect.",
            pairingLostText("D8J224508535"),
        )
    }

    @Test fun theClearCommandIsCancelPartialFormat() {
        assertEquals("~JX", ZebraCommands.CANCEL_PARTIAL_FORMAT)
    }
}
