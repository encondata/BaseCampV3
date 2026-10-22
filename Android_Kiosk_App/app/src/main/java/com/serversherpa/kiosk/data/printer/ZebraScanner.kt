package com.serversherpa.kiosk.data.printer

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import com.serversherpa.kiosk.core.printer.ZebraCommands
import com.serversherpa.kiosk.core.printer.parseGetvar
import com.serversherpa.kiosk.core.printer.parseNetworkHostIdentification
import java.io.IOException
import java.net.Inet4Address
import java.net.Socket
import java.util.Collections
import javax.net.SocketFactory
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** A host that took a connection on the printer port. [model], [serial] and [dpi] are null when it
 *  wouldn't say what it is (it is still listed, as the laptop edge lists it). */
data class FoundPrinter(val host: String, val model: String?, val serial: String?, val dpi: Int?)

/** The addresses to probe on one local network, and how to open a socket on that network. */
data class ScanSubnet(val hosts: List<String>, val socketFactory: SocketFactory = SocketFactory.getDefault())

/**
 * Finds network Zebras on the device's Wi-Fi or Ethernet subnet: every address is probed on the
 * printer port (64 at once, 0.5 s each), and each one that answers is asked `~HI` (1.5 s, read to
 * its ETX) and, when that names a Zebra, its serial number. The whole scan ends within ~10 s with
 * whatever it found, sorted by address. Sending `~HI` to everything on the port is the laptop
 * edge's own scan (kiosk_laptop/edge/src/edge/printers.py). A host that fails in any way is just
 * left out (one that took the connection stays listed), never the whole scan.
 *
 * Probes block their threads (socket connects and reads), so they run on [dispatcher]: by default
 * the scan's own view of the IO pool, whose threads don't count against Dispatchers.IO's 64.
 */
class ZebraScanner(
    private val subnets: suspend () -> List<ScanSubnet>,
    private val port: Int = ZebraNetwork.PORT,
    private val probeConnectMs: Long = ZebraNetwork.PROBE_CONNECT_MS,
    private val identifyMs: Long = ZebraNetwork.IDENTIFY_MS,
    private val budgetMs: Long = ZebraNetwork.SCAN_BUDGET_MS,
    private val concurrency: Int = ZebraNetwork.SCAN_CONCURRENCY,
    private val dispatcher: CoroutineDispatcher = SCAN_DISPATCHER,
    probe: (suspend (host: String, subnet: ScanSubnet) -> FoundPrinter?)? = null,
) {
    /** Scans the device's own Wi-Fi and Ethernet networks ([LocalNetworks.subnets]). */
    constructor(context: Context) : this(subnets = { LocalNetworks.subnets(context.applicationContext) })

    private val probe = probe ?: ::identifyAt

    suspend fun scan(): List<FoundPrinter> {
        val targets = withContext(Dispatchers.IO) { subnets() }
        val found = Collections.synchronizedList(ArrayList<FoundPrinter>())
        val seen = HashSet<String>()
        val gate = Semaphore(concurrency)
        withTimeoutOrNull(budgetMs) {
            coroutineScope {
                for (subnet in targets) {
                    for (host in subnet.hosts) {
                        if (!seen.add(host)) continue
                        launch(dispatcher) {
                            gate.withPermit {
                                val printer = try {
                                    probe(host, subnet)
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (_: Exception) {
                                    null // a network that vanished, a bad host: skip it, keep scanning
                                }
                                printer?.let { found += it }
                            }
                        }
                    }
                }
            }
        }
        return synchronized(found) { found.toList() }.sortedBy { ipv4Key(it.host) }
    }

    /** One connection: the probe, then `~HI` and the serial on it. Null when nothing listens; a
     *  host that took the connection is listed even if it won't say what it is. */
    private suspend fun identifyAt(host: String, subnet: ScanSubnet): FoundPrinter? = try {
        zebraSession(subnet.socketFactory, host, port, probeConnectMs, 2 * identifyMs + 500, dispatcher) { socket ->
            try {
                val id = ask(socket, ZebraCommands.HOST_IDENTIFICATION) { r -> r.contains(0x03.toByte()) }
                    ?.let(::parseNetworkHostIdentification)
                val serial = if (id == null) null else {
                    ask(socket, ZebraCommands.SERIAL_NUMBER) { r -> r.count { it == '"'.code.toByte() } >= 2 }
                        ?.let(::parseGetvar)
                }
                FoundPrinter(host, id?.model, serial, id?.dpi)
            } catch (_: Exception) {
                FoundPrinter(host, null, null, null)
            }
        }
    } catch (_: PrinterException) {
        null
    }

    private companion object {
        val SCAN_DISPATCHER: CoroutineDispatcher = Dispatchers.IO.limitedParallelism(ZebraNetwork.SCAN_CONCURRENCY)
    }

    /** A short query on an open connection; null when it can't be written. */
    private fun ask(socket: Socket, command: String, complete: (ByteArray) -> Boolean): String? = try {
        socket.getOutputStream().apply { write(command.toByteArray(Charsets.US_ASCII)); flush() }
        String(readReply(socket, identifyMs, identifyMs, ZebraNetwork.IDENTIFY_MAX, complete), Charsets.ISO_8859_1)
    } catch (_: IOException) {
        null
    }
}

/** The device's Wi-Fi and Ethernet networks, from ConnectivityManager's link properties (needs
 *  only ACCESS_NETWORK_STATE). Every such network is used, not just the default one: a printer
 *  Wi-Fi without internet is often not the default network. A VPN is never scanned. */
object LocalNetworks {
    /** Each LAN network's scan targets ([scanTargets]) with that network's socket factory. */
    fun subnets(context: Context): List<ScanSubnet> {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return emptyList()
        return lanNetworks(cm).flatMap { network ->
            ipv4Addresses(cm, network).map { (address, prefix) -> ScanSubnet(scanTargets(address, prefix), network.socketFactory) }
        }.filter { it.hosts.isNotEmpty() }
    }

    /** The socket factory of the LAN network whose subnet holds [host]; the default one when none does. */
    fun socketFactoryFor(context: Context, host: String): SocketFactory {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return SocketFactory.getDefault()
        val network = lanNetworks(cm).firstOrNull { n ->
            ipv4Addresses(cm, n).any { (address, prefix) -> sameSubnet(address, host, prefix) }
        }
        return network?.socketFactory ?: SocketFactory.getDefault()
    }

    private fun lanNetworks(cm: ConnectivityManager): List<Network> {
        @Suppress("DEPRECATION") // still the only synchronous list of every connected network
        val all = cm.allNetworks.toList()
        return (listOfNotNull(cm.activeNetwork) + all).distinct().filter { n ->
            val caps = cm.getNetworkCapabilities(n) ?: return@filter false
            !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        }
    }

    private fun ipv4Addresses(cm: ConnectivityManager, network: Network): List<Pair<String, Int>> =
        cm.getLinkProperties(network)?.linkAddresses.orEmpty()
            .filter { it.address is Inet4Address }
            .mapNotNull { la -> la.address.hostAddress?.let { it to la.prefixLength } }
}

/** The addresses a scan probes from the device's [address]: its subnet when that is a /24 or
 *  smaller, else just the device's /24; never the network, broadcast or device's own address. Only
 *  private (RFC 1918) addresses are scanned, as on the laptop. */
fun scanTargets(address: String, prefixLength: Int): List<String> {
    val ip = parseIpv4(address) ?: return emptyList()
    if (!isPrivateIpv4(ip) || prefixLength > 30) return emptyList()
    val prefix = prefixLength.coerceAtLeast(24)
    val mask = (0xFFFFFFFFL shl (32 - prefix)) and 0xFFFFFFFFL
    val network = ip and mask
    val broadcast = network or (mask.inv() and 0xFFFFFFFFL)
    return ((network + 1) until broadcast).filter { it != ip }.map(::formatIpv4)
}

internal fun sameSubnet(a: String, b: String, prefixLength: Int): Boolean {
    val x = parseIpv4(a) ?: return false
    val y = parseIpv4(b) ?: return false
    val mask = (0xFFFFFFFFL shl (32 - prefixLength.coerceIn(1, 32))) and 0xFFFFFFFFL
    return (x and mask) == (y and mask)
}

private val IPV4 = Regex("""(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})""")

private fun parseIpv4(text: String): Long? {
    val m = IPV4.matchEntire(text) ?: return null
    val octets = m.groupValues.drop(1).map { it.toInt() }
    if (octets.any { it > 255 }) return null
    return octets.fold(0L) { acc, o -> (acc shl 8) or o.toLong() }
}

private fun formatIpv4(ip: Long): String = (3 downTo 0).joinToString(".") { ((ip shr (8 * it)) and 0xFF).toString() }

private fun isPrivateIpv4(ip: Long): Boolean {
    val a = (ip shr 24) and 0xFF
    val b = (ip shr 16) and 0xFF
    return a == 10L || (a == 172L && b in 16L..31L) || (a == 192L && b == 168L)
}

private fun ipv4Key(host: String): Long = parseIpv4(host) ?: Long.MAX_VALUE
