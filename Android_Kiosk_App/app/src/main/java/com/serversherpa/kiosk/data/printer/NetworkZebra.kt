package com.serversherpa.kiosk.data.printer

import com.serversherpa.kiosk.nettest.InternetTestRoutes // INTERNET-TEST
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.SocketFactory
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A network Zebra's raw port and the laptop edge's limits (kiosk_laptop/edge/src/edge/printers.py). */
object ZebraNetwork {
    const val PORT = 9100
    const val SCAN_CONCURRENCY = 64
    const val PROBE_CONNECT_MS = 500L   // the scan's probe of one address
    const val IDENTIFY_MS = 1_500L      // the scan's `~HI` to a host that answered
    const val IDENTIFY_MAX = 512        // ... read to its ETX, at most this many bytes
    const val SCAN_BUDGET_MS = 10_000L  // the whole scan
    const val CONNECT_MS = 3_000L       // a query or send to a chosen printer
    const val IDLE_MS = 2_000L          // a query ends after this long without new bytes
    const val TOTAL_MS = 5_000L         // ... or this long in all
    const val SEND_MS = 30_000L         // writing a job (a font can be a few MB)
    const val MAX_REPLY = 65_536        // a query's reply, at most
}

/** How long [NetworkZebra] waits; the defaults are [ZebraNetwork]'s. */
data class ZebraTimeouts(
    val connectMs: Long = ZebraNetwork.CONNECT_MS,
    val idleMs: Long = ZebraNetwork.IDLE_MS,
    val totalMs: Long = ZebraNetwork.TOTAL_MS,
    val sendMs: Long = ZebraNetwork.SEND_MS,
)

/** A network printer that couldn't be used; [host] is the address asked. */
sealed class PrinterException(val host: String, message: String, cause: Throwable? = null) : Exception(message, cause)

/** No socket could be opened (its network is gone), nothing accepted a connection on the port in
 *  time, or the connection failed while the command was being written. */
class PrinterUnreachable(host: String, cause: Throwable? = null) :
    PrinterException(host, "No printer answered at $host", cause)

/** The connection didn't take the whole job within its time (the edge's `printer_timeout`). */
class PrinterTimeout(host: String, cause: Throwable? = null) :
    PrinterException(host, "The printer at $host didn't take the job in time", cause)

/** The printer took the query but said nothing before the read gave up. */
class PrinterNoReply(host: String) : PrinterException(host, "The printer at $host didn't reply")

/** The printer replied, but not with the answer the query asks for. */
class PrinterBadReply(host: String, what: String) : PrinterException(host, "The printer at $host sent an unreadable $what reply")

/**
 * A Zebra on the LAN, spoken to over its raw port: one connection per command, as the laptop edge
 * does. Queries read the reply until it is whole (the printer keeps the connection open), the idle
 * wait, the total wait or 64 KB; writes write and close. What is sent and how replies are read is
 * the [ZebraTransport] extensions' (identify, status, fonts, send, installFont and the rest).
 *
 * [socketFactory] opens the socket: pass the Wi-Fi or Ethernet network's own factory
 * ([LocalNetworks.socketFactoryFor]) so traffic reaches the printer even when another network is
 * the device's default.
 */
class NetworkZebra(
    val host: String,
    val port: Int = ZebraNetwork.PORT,
    private val timeouts: ZebraTimeouts = ZebraTimeouts(),
    private val socketFactory: SocketFactory = SocketFactory.getDefault(),
) : ZebraTransport {
    override val address: String get() = host

    override suspend fun query(command: String, complete: (ByteArray) -> Boolean): String {
        val reply = zebraSession(socketFactory, host, port, timeouts.connectMs, timeouts.totalMs + WRITE_SLACK_MS) { socket ->
            socket.getOutputStream().apply { write(command.toByteArray(Charsets.UTF_8)); flush() }
            readReply(socket, timeouts.idleMs, timeouts.totalMs, ZebraNetwork.MAX_REPLY, complete)
        }
        if (reply.isEmpty()) throw PrinterNoReply(host)
        return String(reply, Charsets.ISO_8859_1)
    }

    /** One connection for the whole job: each part, then a FIN. [progress] hears 0 once the
     *  connection is open, then each part as the socket takes it. */
    override suspend fun write(parts: List<ByteArray>, progress: WriteProgress?) {
        val total = parts.sumOf { it.size.toLong() }
        zebraSession(socketFactory, host, port, timeouts.connectMs, timeouts.sendMs) { socket ->
            val out = socket.getOutputStream()
            var sent = 0L
            progress?.invoke(sent, total)
            for (part in parts) {
                out.write(part)
                sent += part.size
                progress?.invoke(sent, total)
            }
            out.flush()
            socket.shutdownOutput()
        }
    }

    private companion object {
        const val WRITE_SLACK_MS = 1_000L
    }
}

/**
 * Opens a connection (at most [connectMs]) and runs [block] on it on [dispatcher] (the scan passes
 * its own threads, so it never ties up the app's shared IO pool). The socket is closed when [block]
 * ends, when the coroutine is cancelled, and [deadlineMs] after [connectMs] (a blocking write can't
 * time out by itself), so nothing hangs past the deadline; the watchdog runs on Dispatchers.Default
 * so it still fires when every thread of [dispatcher] is blocked. A socket that can't be created or
 * connected, or an I/O failure in [block], is [PrinterUnreachable]; one cut off at the deadline is
 * [PrinterTimeout]; a cancellation stays one.
 */
internal suspend fun <T> zebraSession(
    socketFactory: SocketFactory,
    host: String,
    port: Int,
    connectMs: Long,
    deadlineMs: Long,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
    block: (Socket) -> T,
): T = withContext(dispatcher) {
    val socket = try {
        socketFactory
            .let(InternetTestRoutes::local) // INTERNET-TEST
            .createSocket()
    } catch (e: IOException) {
        throw PrinterUnreachable(host, e)
    }
    val timedOut = AtomicBoolean(false)
    val watchdog = launch(Dispatchers.Default) {
        try {
            delay(connectMs + deadlineMs)
            timedOut.set(true)
        } finally {
            socket.closeQuietly()
        }
    }
    try {
        socket.connect(InetSocketAddress(host, port), connectMs.toInt())
        block(socket).also { ensureActive() }
    } catch (e: IOException) {
        ensureActive()
        throw if (timedOut.get()) PrinterTimeout(host, e) else PrinterUnreachable(host, e)
    } finally {
        watchdog.cancel()
        socket.closeQuietly()
    }
}

/** Reads a reply: until [complete] says it is whole, EOF, [maxBytes], [idleMs] without new bytes,
 *  or [totalMs] in all. A read error ends it with what arrived. */
internal fun readReply(
    socket: Socket,
    idleMs: Long,
    totalMs: Long,
    maxBytes: Int,
    complete: (ByteArray) -> Boolean,
): ByteArray {
    val input = socket.getInputStream()
    val out = ByteArrayOutputStream()
    val buf = ByteArray(8192)
    val deadline = System.nanoTime() + totalMs * 1_000_000
    while (out.size() < maxBytes) {
        val leftMs = (deadline - System.nanoTime()) / 1_000_000
        if (leftMs <= 0) break
        socket.soTimeout = minOf(idleMs, leftMs).toInt().coerceAtLeast(1)
        val n = try {
            input.read(buf, 0, minOf(buf.size, maxBytes - out.size()))
        } catch (_: SocketTimeoutException) {
            break
        } catch (_: IOException) {
            break
        }
        if (n < 0) break
        out.write(buf, 0, n)
        if (complete(out.toByteArray())) break
    }
    return out.toByteArray()
}

private fun Socket.closeQuietly() {
    try {
        close()
    } catch (_: IOException) {
    }
}
