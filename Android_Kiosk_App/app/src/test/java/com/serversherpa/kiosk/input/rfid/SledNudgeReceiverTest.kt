package com.serversherpa.kiosk.input.rfid

import android.Manifest
import android.app.Application
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.rfid.SledNudge
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The app's nudge receiver: Bluetooth coming on, or the sled's link appearing, nudges the
 *  controller; device names and addresses are read only with Nearby devices granted. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SledNudgeReceiverTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val nudges = mutableListOf<Triple<SledNudge, String?, String?>>()
    private var known: String? = null
    private var canRead = true
    private val receiver = SledNudgeReceiver(
        nudge = { r, a, n -> nudges += Triple(r, a, n) },
        lastSledAddress = { known },
        canReadDevices = { canRead },
    )

    @Before fun grant() {
        shadowOf(app).grantPermissions(Manifest.permission.BLUETOOTH_CONNECT)
    }

    private fun device(address: String, name: String?): BluetoothDevice {
        val adapter = app.getSystemService(BluetoothManager::class.java).adapter
        return adapter.getRemoteDevice(address).also { shadowOf(it).setName(name) }
    }

    private fun stateChanged(state: Int) = Intent(BluetoothAdapter.ACTION_STATE_CHANGED).putExtra(BluetoothAdapter.EXTRA_STATE, state)

    private fun aclConnected(device: BluetoothDevice) =
        Intent(BluetoothDevice.ACTION_ACL_CONNECTED).putExtra(BluetoothDevice.EXTRA_DEVICE, device)

    private fun receive(intent: Intent, context: Context = app) = receiver.onReceive(context, intent)

    @Test fun bluetoothTurningOnNudges() {
        receive(stateChanged(BluetoothAdapter.STATE_TURNING_ON))
        receive(stateChanged(BluetoothAdapter.STATE_OFF))
        receive(stateChanged(BluetoothAdapter.STATE_TURNING_OFF))
        assertEquals(emptyList<Any>(), nudges)
        receive(stateChanged(BluetoothAdapter.STATE_ON))
        assertEquals(listOf(Triple(SledNudge.BLUETOOTH_ON, null, null)), nudges)
    }

    @Test fun aclConnectedForTheLastSledNudgesWithItsAddress() {
        // Saved in lower case; Android reports upper case.
        known = "84:c6:92:00:00:01"
        // Another device: nothing, even one named like a sled.
        receive(aclConnected(device("84:C6:92:00:00:02", "RFD4031-G10B700-WR")))
        assertEquals(emptyList<Any>(), nudges)
        // The last sled.
        receive(aclConnected(device("84:C6:92:00:00:01", "RFD4031-G10B700-WR")))
        assertEquals(listOf(Triple(SledNudge.LINK_APPEARED, "84:C6:92:00:00:01", "RFD4031-G10B700-WR")), nudges)

        // No sled known yet: a device named like a sled counts.
        nudges.clear()
        known = null
        receive(aclConnected(device("84:C6:92:00:00:03", "RFD4031-G10B700-WR")))
        assertEquals(listOf(Triple(SledNudge.LINK_APPEARED, "84:C6:92:00:00:03", "RFD4031-G10B700-WR")), nudges)
    }

    @Test fun aclConnectedForANonSledDeviceWithNoKnownSledDoesNothing() {
        known = null
        receive(aclConnected(device("00:11:22:33:44:55", "Jabra Elite")))
        receive(aclConnected(device("00:11:22:33:44:56", null)))
        receive(Intent(BluetoothDevice.ACTION_ACL_CONNECTED))
        assertEquals(emptyList<Any>(), nudges)
    }

    @Test fun deviceNamesAreReadOnlyWithConnectPermission() {
        canRead = false
        known = "84:C6:92:00:00:01"
        receive(aclConnected(device("84:C6:92:00:00:01", "RFD4031-G10B700-WR")))
        known = null
        receive(aclConnected(device("84:C6:92:00:00:03", "RFD4031-G10B700-WR")))
        assertEquals(emptyList<Any>(), nudges)
        // Bluetooth coming on needs no device.
        receive(stateChanged(BluetoothAdapter.STATE_ON))
        assertEquals(listOf(Triple(SledNudge.BLUETOOTH_ON, null, null)), nudges)
    }

    @Test fun registerAndUnregisterAreIdempotent() {
        receiver.unregister(app)
        receiver.register(app)
        receiver.register(app)
        assertEquals(1, shadowOf(app).registeredReceivers.count { it.broadcastReceiver === receiver })
        receiver.unregister(app)
        receiver.unregister(app)
        assertEquals(0, shadowOf(app).registeredReceivers.count { it.broadcastReceiver === receiver })
    }
}
