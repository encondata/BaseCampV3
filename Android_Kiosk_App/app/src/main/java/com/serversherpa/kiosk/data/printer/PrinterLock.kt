package com.serversherpa.kiosk.data.printer

import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.printer.DirectoryEntry
import com.serversherpa.kiosk.core.printer.HostId
import com.serversherpa.kiosk.core.printer.HostStatus
import com.serversherpa.kiosk.core.printer.ZebraCommands
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * One connection to the saved printer at a time, app-wide (the container owns the one lock).
 * Print Labels' queue sends through it ([lockedSender]) and so does Printer Setup ([LockedZebra]):
 * labels already scanned keep printing after Print Labels closes, so without it a test label, a
 * check or a font install could open a second connection while an asset label is going out. Both
 * apply the container's [PrinterGuard] inside it.
 *
 * It only serializes: no check, poll or wait of its own. Callers go in the order they asked (the
 * coroutine [Mutex] is fair), and a caller canceled while it waits leaves the queue without ever
 * holding the lock.
 */
class PrinterLock {
    private val mutex = Mutex()

    /** Runs [block] once every earlier caller's block has finished. */
    suspend fun <T> withLock(block: suspend () -> T): T = mutex.withLock { block() }
}

/** Sends ZPL to the saved printer, the way its connection reaches it (a [ZebraTransport]'s `send`
 *  on the device). */
fun interface LabelSender {
    suspend fun send(printer: SavedPrinter, zpl: String)
}

/** [send] with each label sent under [lock] and [guard]'s rules for its printer (a `~JX` first
 *  after a failed send, nothing while a font install is cut): the container's Print Labels sender. */
fun lockedSender(lock: PrinterLock, guard: PrinterGuard, send: LabelSender): LabelSender = LabelSender { printer, zpl ->
    lock.withLock {
        guard.sending(printer.connection, clear = { send.send(printer, ZebraCommands.CANCEL_PARTIAL_FORMAT) }) {
            send.send(printer, zpl)
        }
    }
}

/** One Zebra, as Printer Setup and Settings › Troubleshooting talk to it: a [ZebraTransport] on the
 *  device ([TransportSetupZebra]). */
interface SetupZebra {
    suspend fun identify(): HostId
    suspend fun serial(): String?
    suspend fun status(): HostStatus
    suspend fun peelerPresent(): Boolean?
    suspend fun fonts(): List<String>
    suspend fun fontEntries(): List<DirectoryEntry>
    suspend fun send(zpl: String)
    suspend fun installFont(name: String, bytes: ByteArray, progress: WriteProgress? = null)

    /** Sends [command] and returns the reply as the printer sent it (Latin-1), read until
     *  [complete] says it is whole or the transport's quiet and total limits: Troubleshooting's ask
     *  buttons and command box, which show the raw reply. */
    suspend fun query(command: String, complete: (ByteArray) -> Boolean): String
}

/** [transport] as a [SetupZebra]: the shared commands, byte for byte. */
class TransportSetupZebra(val transport: ZebraTransport) : SetupZebra {
    override suspend fun identify(): HostId = transport.identify()
    override suspend fun serial(): String? = transport.serial()
    override suspend fun status(): HostStatus = transport.status()
    override suspend fun peelerPresent(): Boolean? = transport.peelerPresent()
    override suspend fun fonts(): List<String> = transport.fonts()
    override suspend fun fontEntries(): List<DirectoryEntry> = transport.fontEntries()
    override suspend fun send(zpl: String) = transport.send(zpl)
    override suspend fun installFont(name: String, bytes: ByteArray, progress: WriteProgress?) =
        transport.installFont(name, bytes, progress)
    override suspend fun query(command: String, complete: (ByteArray) -> Boolean): String = transport.query(command, complete)
}

/**
 * [inner], the printer at [connection], with every call made under [lock] (one connection to the
 * printer at a time) and [guard]'s rules for that printer: a pending `~JX` before any call, and no
 * send or font install while a font is cut. An answered [identify] lifts that stop unless
 * [liftsStop] is off (Printer Setup's probe of a printer being chosen, before it is saved).
 *
 * A send or font install whose caller is canceled (its screen closed) while it waits for the lock
 * never starts; once it holds the lock it finishes, its `~JX` included, bounded by the transport's
 * own deadline: cut off, the printer would hold half a label, or wait for the rest of a font (D8).
 */
class LockedZebra(
    private val inner: SetupZebra,
    private val connection: PrinterConnection,
    private val lock: PrinterLock,
    private val guard: PrinterGuard,
    private val liftsStop: Boolean = true,
) : SetupZebra {
    override suspend fun identify(): HostId = lock.withLock {
        val id = guard.asking(connection, ::clear) { inner.identify() }
        if (liftsStop) guard.printerAnswered(connection)
        id
    }

    override suspend fun serial(): String? = ask { inner.serial() }
    override suspend fun status(): HostStatus = ask { inner.status() }
    override suspend fun peelerPresent(): Boolean? = ask { inner.peelerPresent() }
    override suspend fun fonts(): List<String> = ask { inner.fonts() }
    override suspend fun fontEntries(): List<DirectoryEntry> = ask { inner.fontEntries() }

    override suspend fun query(command: String, complete: (ByteArray) -> Boolean): String = ask { inner.query(command, complete) }

    override suspend fun send(zpl: String) = lock.withLock {
        withContext(NonCancellable) { guard.sending(connection, ::clear) { inner.send(zpl) } }
    }

    /** Troubleshooting's Cut-send test (D16): sends [zpl] (the first half of a label) as [send]
     *  does, then marks the printer as if that send had been cut off, both in one turn of the lock,
     *  so a label queued behind it can't reach the printer before the mark and merge into the half.
     *  It calls [inner] directly: the lock isn't reentrant. */
    suspend fun sendCut(zpl: String) = lock.withLock {
        withContext(NonCancellable) {
            guard.sending(connection, ::clear) { inner.send(zpl) }
            guard.markSendFailed(connection)
        }
    }

    override suspend fun installFont(name: String, bytes: ByteArray, progress: WriteProgress?) = lock.withLock {
        withContext(NonCancellable) {
            guard.installing(connection, ::clear, progress) { tracked -> inner.installFont(name, bytes, tracked) }
        }
    }

    private suspend fun <T> ask(query: suspend () -> T): T = lock.withLock { guard.asking(connection, ::clear, query) }

    private suspend fun clear() = inner.send(ZebraCommands.CANCEL_PARTIAL_FORMAT)
}
