package com.serversherpa.kiosk.data.printer

import com.serversherpa.kiosk.core.labels.isResidentFont
import com.serversherpa.kiosk.core.printer.DirectoryEntry
import com.serversherpa.kiosk.core.printer.HostId
import com.serversherpa.kiosk.core.printer.HostStatus
import com.serversherpa.kiosk.core.printer.ZebraCommands
import com.serversherpa.kiosk.core.printer.isDirectoryListing
import com.serversherpa.kiosk.core.printer.parseDirectoryEntries
import com.serversherpa.kiosk.core.printer.parseGetvar
import com.serversherpa.kiosk.core.printer.parseHostStatus
import com.serversherpa.kiosk.core.printer.parseNetworkHostIdentification

/** Hears a write's bytes go out: how many so far, of how many in all. */
typealias WriteProgress = (sent: Long, total: Long) -> Unit

/**
 * How bytes reach one Zebra and its replies come back: a network printer ([NetworkZebra], one TCP
 * connection per command) or a Bluetooth one. Everything the kiosk asks or sends is built once on
 * top of it (the extensions below, the web kiosk's `fromTransport` in kiosk/src/lib/stationPrinter.ts),
 * so both send exactly the same bytes and parse the same replies.
 *
 * A transport sends nothing on its own: each call sends exactly what it is given.
 */
interface ZebraTransport {
    /** The printer's address as its errors carry it ([PrinterException.host]). */
    val address: String

    /** Sends [command] and reads the reply until [complete] says it is whole (or the transport's
     *  quiet and total limits), as Latin-1; throws [PrinterNoReply] when nothing came back. */
    suspend fun query(command: String, complete: (ByteArray) -> Boolean): String

    /** Writes [parts] in order as one job. [progress], when given, hears `(0, total)` once the
     *  bytes start going out (the printer is connected), then the bytes written so far: no report
     *  means nothing was sent ([PrinterGuard] tells a cut font from one that never started by it). */
    suspend fun write(parts: List<ByteArray>, progress: WriteProgress? = null)
}

// The commands and their replies, the same over every transport. Replies are read as Latin-1, ZPL
// is sent as UTF-8 (labels carry `^CI28`), and a font's bytes go raw after its ASCII header.

/** `~HI`: model, firmware, resolution. */
suspend fun ZebraTransport.identify(): HostId =
    parseNetworkHostIdentification(query(ZebraCommands.HOST_IDENTIFICATION) { replyHasFrames(it, 1) })
        ?: throw PrinterBadReply(address, "identification")

/** `~HS`: paper, head, pause and the rest (three frames). */
suspend fun ZebraTransport.status(): HostStatus =
    parseHostStatus(query(ZebraCommands.HOST_STATUS) { replyHasFrames(it, 3) }) ?: throw PrinterBadReply(address, "status")

/** Whether a peeler is fitted; null when the printer doesn't say (an unknown variable, no or an
 *  unreadable answer, or no printer at all). */
suspend fun ZebraTransport.peelerPresent(): Boolean? = when (getvar(ZebraCommands.PEELER_PRESENT)?.lowercase()) {
    "present" -> true
    "not present" -> false
    else -> null
}

/** The printer's serial number; null when it doesn't say. */
suspend fun ZebraTransport.serial(): String? = getvar(ZebraCommands.SERIAL_NUMBER)

/** The object names on E: (fonts and anything else stored there), upper-cased. */
suspend fun ZebraTransport.fonts(): List<String> = fontEntries().map { it.name }

/** The objects on E: with their sizes in bytes, names upper-cased. */
suspend fun ZebraTransport.fontEntries(): List<DirectoryEntry> {
    val reply = query(ZebraCommands.FONT_DIRECTORY) { replyHasFrames(it, 1) }
    if (!isDirectoryListing(reply)) throw PrinterBadReply(address, "font listing")
    return parseDirectoryEntries(reply)
}

/** Sends a job as is: no status checks before or after. */
suspend fun ZebraTransport.send(zpl: String) = write(listOf(zpl.toByteArray(Charsets.UTF_8)))

/** Installs a TrueType font on E: as [name] (upper-cased): `~DYE:NAME,B,T,<len>,,` then the
 *  bytes, [progress] hearing them go out. A resident font is never installed, and a name that
 *  isn't a plain `NAME.TTF` is refused before anything is sent. */
suspend fun ZebraTransport.installFont(name: String, bytes: ByteArray, progress: WriteProgress? = null) {
    val upper = name.uppercase()
    require(FONT_NAME.matches(upper)) { "Not a printer font name: $name" }
    require(!isResidentFont(upper)) { "$upper is built into the printer and is never installed" }
    require(bytes.isNotEmpty()) { "$upper has no bytes" }
    write(listOf(ZebraCommands.downloadFontHeader(upper, bytes.size).toByteArray(Charsets.US_ASCII), bytes), progress)
}

private suspend fun ZebraTransport.getvar(command: String): String? = try {
    parseGetvar(query(command, ::replyHasQuotedValue))
} catch (_: PrinterException) {
    null
}

// When each reply is whole (the edge's REPLY_COMPLETE): ~HS is three STX..ETX frames, ~HI and the
// E: listing one, a getvar one quoted value. Shared by the transports.

/** At least [n] ETX-closed frames. */
fun replyHasFrames(reply: ByteArray, n: Int): Boolean = reply.count { it == 0x03.toByte() } >= n

/** A whole quoted getvar value (two double quotes). */
fun replyHasQuotedValue(reply: ByteArray): Boolean = reply.count { it == '"'.code.toByte() } >= 2

/** `[A-Z0-9_\-]{1,64}\.TTF`, ASCII only. */
private val FONT_NAME = Regex("""[A-Z0-9_\-]{1,64}\.TTF""")

/** A printer this build has no way to reach: every call fails as [PrinterUnreachable] naming
 *  [address], and nothing is sent anywhere. The container gives one for a Bluetooth printer until
 *  its Bluetooth transport is wired in, so such a printer never falls through to TCP. */
class UnreachableZebra(override val address: String) : ZebraTransport {
    override suspend fun query(command: String, complete: (ByteArray) -> Boolean): String = throw PrinterUnreachable(address)
    override suspend fun write(parts: List<ByteArray>, progress: WriteProgress?) = throw PrinterUnreachable(address)
}
