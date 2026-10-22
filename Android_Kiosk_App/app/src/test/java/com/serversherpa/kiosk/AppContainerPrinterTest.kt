package com.serversherpa.kiosk

import androidx.lifecycle.ProcessLifecycleOwner
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.data.printer.BluetoothAvailability
import com.serversherpa.kiosk.data.printer.BluetoothZebra
import com.serversherpa.kiosk.data.printer.FakeBluetoothLe
import com.serversherpa.kiosk.data.printer.FakeGatt
import com.serversherpa.kiosk.data.printer.WriteProgress
import com.serversherpa.kiosk.data.printer.ZebraBluetooth
import com.serversherpa.kiosk.data.printer.ZebraTransport
import com.serversherpa.kiosk.data.printer.transportFor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The container's printer wiring: the transport each saved printer gets, and the one Bluetooth
 *  link closing when the app goes to the background, on sign-out, when the session ends, and when
 *  another printer is saved (D4). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppContainerPrinterTest {
    private val address = "AC:3F:A4:00:00:01"
    private val serial = FakeBluetoothLe.SERIAL
    private val bluetoothPrinter = SavedPrinter(PrinterConnection.Bluetooth(serial, address), "ZD421", serial, 300)
    private val networkPrinter = SavedPrinter("10.0.0.5", "ZD421", "S1", 203)

    private class Named(override val address: String) : ZebraTransport {
        override suspend fun query(command: String, complete: (ByteArray) -> Boolean): String = error("not used")
        override suspend fun write(parts: List<ByteArray>, progress: WriteProgress?) = error("not used")
    }

    @Test fun containerPicksTransportByConnection() {
        val hosts = mutableListOf<String>()
        val bluetooth = mutableListOf<SavedPrinter>()
        val net = Named("net")
        val ble = Named("ble")
        fun pick(p: SavedPrinter) = transportFor(p, network = { host -> hosts += host; net }, bluetooth = { b -> bluetooth += b; ble })

        assertSame(net, pick(networkPrinter))
        assertEquals(listOf("10.0.0.5"), hosts)
        assertTrue(bluetooth.isEmpty())
        assertSame(ble, pick(bluetoothPrinter))
        assertEquals(listOf(bluetoothPrinter), bluetooth)
        assertEquals(1, hosts.size)

        // With the real link: the saved serial and the address it was saved with; never TCP.
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val link = ZebraBluetooth(FakeBluetoothLe(), scope)
            val t = transportFor(bluetoothPrinter, network = { error("a Bluetooth printer never goes over TCP") }, bluetooth = link::transport)
            t as BluetoothZebra
            assertEquals(serial, t.serial)
            assertEquals(address, t.bluetoothAddress)
            assertEquals(serial, t.address)
        } finally {
            scope.cancel()
        }
    }

    private suspend fun eventually(what: String, cond: () -> Boolean) {
        try {
            withTimeout(8_000) { while (!cond()) delay(20) }
        } catch (e: Exception) {
            throw AssertionError("never: $what", e)
        }
    }

    /** Cancels the container's scope and waits for everything in it (the Bluetooth link's event
     *  loop included) before the database closes: nothing started by [AppContainer.start] may still
     *  be opening it. */
    private suspend fun AppContainer.shutDown() {
        withTimeout(10_000) { scope.coroutineContext[Job]!!.cancelAndJoin() }
        db.close()
    }

    /** The link up to the office ZD421. */
    private suspend fun AppContainer.linkUp(fake: FakeBluetoothLe): FakeGatt {
        zebraBluetooth.connect(address, serial)
        assertTrue(zebraBluetooth.link.value.connected)
        return fake.links.last()
    }

    @Test fun linkClosesOnBackgroundAndSignOut() = runBlocking<Unit> {
        val fake = FakeBluetoothLe()
        fake.printer(address)
        val c = testContainer(bluetooth = fake)
        try {
            c.start()
            val owner = ProcessLifecycleOwner.get()

            var gatt = c.linkUp(fake)
            c.processLifecycle.onStop(owner)
            eventually("closed in the background") { gatt.closed && !c.zebraBluetooth.link.value.connected }

            // Back in front: Bluetooth's state is read again (Android says nothing when a
            // permission is granted in Settings).
            fake.state = BluetoothAvailability.UNAUTHORIZED
            c.processLifecycle.onStart(owner)
            eventually("read again") { c.zebraBluetooth.availability.value == BluetoothAvailability.UNAUTHORIZED }
            fake.state = BluetoothAvailability.READY
            c.zebraBluetooth.refreshAvailability()
            eventually("ready") { c.zebraBluetooth.availability.value == BluetoothAvailability.READY }

            gatt = c.linkUp(fake)
            c.logout()
            eventually("closed on sign-out") { gatt.closed && !c.zebraBluetooth.link.value.connected }

            gatt = c.linkUp(fake)
            c.session.notifySessionEnded()
            eventually("closed when the session ended") { gatt.closed && !c.zebraBluetooth.link.value.connected }
        } finally {
            c.shutDown()
        }
    }

    /** The link's scope is the container's child: cancelling the container's scope stops it (a call
     *  after that is cancelled, and never reaches the adapter). */
    @Test fun linkStopsWithTheContainersScope() = runBlocking<Unit> {
        val fake = FakeBluetoothLe()
        fake.printer(address)
        val c = testContainer(bluetooth = fake)
        c.linkUp(fake)
        val connects = fake.connects.size
        c.shutDown()
        val after = runCatching { c.zebraBluetooth.connect("AC:3F:A4:00:00:09", "XXJ224508599") }
        assertTrue("$after", after.exceptionOrNull() is CancellationException)
        assertEquals(connects, fake.connects.size)
    }

    /** Saving the printer the link is already up to (Printer Setup brought it up to choose it)
     *  keeps the link; saving another printer, or none, closes it. */
    @Test fun linkClosesWhenAnotherPrinterIsSaved() = runBlocking<Unit> {
        val fake = FakeBluetoothLe()
        fake.printer(address)
        val c = testContainer(bluetooth = fake)
        try {
            var gatt = c.linkUp(fake)
            c.labelSettings.setPrinter(bluetoothPrinter)
            delay(300)
            assertFalse(gatt.closed)
            assertTrue(c.zebraBluetooth.link.value.connected)

            c.labelSettings.setPrinter(networkPrinter)
            eventually("closed for a network printer") { gatt.closed && !c.zebraBluetooth.link.value.connected }

            gatt = c.linkUp(fake)
            c.labelSettings.setPrinter(SavedPrinter(PrinterConnection.Bluetooth("XXJ224508599", "AC:3F:A4:00:00:09"), "ZD421", "XXJ224508599", 203))
            eventually("closed for another Bluetooth printer") { gatt.closed }

            gatt = c.linkUp(fake)
            c.labelSettings.setPrinter(bluetoothPrinter)
            delay(300)
            assertFalse(gatt.closed)
            c.resetApp(clearLocalData = {})
            eventually("closed when no printer is saved") { gatt.closed }
        } finally {
            c.shutDown()
        }
    }
}
