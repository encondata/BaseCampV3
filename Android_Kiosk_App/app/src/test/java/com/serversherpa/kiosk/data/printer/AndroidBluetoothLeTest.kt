package com.serversherpa.kiosk.data.printer

import android.Manifest
import android.app.Application
import android.bluetooth.BluetoothAdapter
import android.bluetooth.le.ScanRecord
import android.bluetooth.le.ScanResult
import android.content.pm.PackageManager
import android.location.LocationManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** How the real adapter reads an advertisement (Android types, so Robolectric). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidBluetoothLeTest {
    private val address = "AC:3F:A4:00:00:01"

    /** A scan result whose device Android calls [deviceName] and whose advertisement is [payload]. */
    @Suppress("DEPRECATION")
    private fun result(payload: ByteArray, deviceName: String? = "Pixel 10 Pro XL"): ScanResult {
        val device = BluetoothAdapter.getDefaultAdapter().getRemoteDevice(address)
        shadowOf(device).setName(deviceName)
        // ScanRecord.parseFromBytes is hidden from apps; Android builds every ScanRecord with it.
        val record = ScanRecord::class.java.getDeclaredMethod("parseFromBytes", ByteArray::class.java)
            .invoke(null, payload) as ScanRecord
        return ScanResult(device, record, -61, 0L)
    }

    private fun localName(name: String): ByteArray = byteArrayOf((name.length + 1).toByte(), 0x09) + name.toByteArray()

    private val flags = byteArrayOf(0x02, 0x01, 0x06)

    @Test fun scanResultNameComesFromTheScanRecord() {
        val advertised = advertisedFrom(result(flags + localName("D8J224508535")))
        assertEquals("D8J224508535", advertised.name)
        assertEquals(address, advertised.address)
        assertEquals(-61, advertised.rssi)
        assertFalse(advertised.advertisesZebra)

        // No name in the advertisement: none, even though Android knows the device by one.
        assertNull(advertisedFrom(result(flags)).name)
    }

    @Test fun zebraServiceUuidsFlagTheAdvertisement() {
        // Zebra's member UUID FE79 in the 16-bit service list (little-endian).
        val member = byteArrayOf(0x03, 0x03, 0x79, 0xFE.toByte())
        assertTrue(advertisedFrom(result(flags + member + localName("Printer"))).advertisesZebra)
        // Another 16-bit service (Battery, 180F) isn't Zebra.
        val battery = byteArrayOf(0x03, 0x03, 0x0F, 0x18)
        assertFalse(advertisedFrom(result(flags + battery)).advertisesZebra)
    }

    /** Location off stops scans at every API level (here API 34): the manifest's BLUETOOTH_SCAN
     *  doesn't disavow location, so Android drops scan results while it's off. */
    @Test fun locationOffStopsScansOnApi31AndUp() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        shadowOf(app).grantPermissions(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        shadowOf(app.packageManager).setSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE, true)
        @Suppress("DEPRECATION")
        shadowOf(BluetoothAdapter.getDefaultAdapter()).setState(BluetoothAdapter.STATE_ON)
        val location = shadowOf(app.getSystemService(LocationManager::class.java))
        location.setLocationEnabled(false)
        val client = AndroidBluetoothLe(app)
        assertEquals(BluetoothAvailability.LOCATION_OFF, client.availability())
        location.setLocationEnabled(true)
        assertEquals(BluetoothAvailability.READY, client.availability())
    }
}
