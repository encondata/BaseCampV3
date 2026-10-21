package com.serversherpa.kiosk.core.printer

import kotlin.math.floor

/** The commands the kiosk sends a Zebra, byte for byte as the web kiosk and the laptop edge send
 *  them (portal/src/labels/zebraCommands.ts, kiosk/src/lib/stationPrinter.ts). */
object ZebraCommands {
    const val HOST_IDENTIFICATION = "~HI"
    const val HOST_STATUS = "~HS"
    /** The E: drive listing: the fonts installed on the printer. */
    const val FONT_DIRECTORY = "^XA^HWE:*.*^XZ"
    /** Whether a peeler is fitted: `"Present"`, `"Not Present"`, or `"?"` when unknown. */
    const val PEELER_PRESENT = "! U1 getvar \"sensor.peeler_present\"\r\n"
    /** The printer's serial number (`~HI` doesn't carry one). */
    const val SERIAL_NUMBER = "! U1 getvar \"device.unique_id\"\r\n"

    /** `~DYE:NAME,B,T,<bytes>,,`: a binary TrueType download to E:; the font's bytes follow. */
    fun downloadFontHeader(name: String, totalBytes: Int): String = "~DYE:$name,B,T,$totalBytes,,"
}

/** `~HI`'s answer; [dpi] is the nominal value for [dotsPerMm]. */
data class HostId(val model: String, val firmware: String, val dotsPerMm: Int, val memory: String, val dpi: Int)

/** `~HS`'s answer (ZPL manual field order). */
data class HostStatus(
    val paperOut: Boolean,
    val paused: Boolean,
    val labelLength: Int,
    val formatsQueued: Int,
    val bufferFull: Boolean,
    val partialFormat: Boolean,
    val corruptRam: Boolean,
    val underTemp: Boolean,
    val overTemp: Boolean,
    val headOpen: Boolean,
    val ribbonOut: Boolean,
    val thermalTransfer: Boolean,
    val printMode: String,
    val labelWaiting: Boolean,
    val labelsRemaining: Int,
)

private const val STX = '\u0002'
private const val ETX = '\u0003'
private val NOMINAL_DPI = mapOf(6 to 150, 8 to 203, 12 to 300, 24 to 600)

/** The DPI a dots-per-mm resolution is sold as; anything else is converted and rounded. */
fun dpiFromDotsPerMm(dotsPerMm: Int): Int = NOMINAL_DPI[dotsPerMm] ?: floor(dotsPerMm * 25.4 + 0.5).toInt()

private fun strip(text: String): String = text.replace("\u0002", "").replace("\u0003", "")

/** JavaScript's `parseInt(v, 10)`: leading whitespace, an optional sign, then the leading digits;
 *  null when there are none. */
private fun jsParseInt(value: String): Int? {
    val m = Regex("""^\s*([+-]?\d+)""").find(value) ?: return null
    return m.groupValues[1].toBigInteger().coerceIn(Int.MIN_VALUE.toBigInteger(), Int.MAX_VALUE.toBigInteger()).toInt()
}

/** `~HI` → `<STX>model,firmware,dotsPerMm,memory[,x]<ETX>`. A leftover frame from a prior query
 *  can precede the real response, so the LAST `<STX>…<ETX>` frame is parsed; without an STX,
 *  the whole stripped text. Mirrors parseHostIdentification in portal/src/labels/zebraUsb.ts. */
fun parseHostIdentification(text: String): HostId? {
    val frames = text.split(STX).drop(1)
    val body = if (frames.isNotEmpty()) frames.last().split(ETX)[0].trim() else strip(text).trim()
    val parts = body.split(',').map { it.trim() }
    if (parts.size < 4) return null
    val dotsPerMm = jsParseInt(parts[2])
    if (parts[0].isEmpty() || dotsPerMm == null) return null
    return HostId(parts[0], parts[1], dotsPerMm, parts[3], dpiFromDotsPerMm(dotsPerMm))
}

/** `~HS` string 1 `aaa,b,c,dddd,eee,f,g,h,iii,j,k,l` and string 2 `mmm,n,o,p,q,r,s,t,uuuuuuuu,v,www`
 *  (string 3 is the password and isn't read). Both strings are required, and the last full pair
 *  wins over leftover frames. Mirrors parseHostStatus in portal/src/labels/zebraUsb.ts. */
fun parseHostStatus(text: String): HostStatus? {
    val frames = text.split(STX).drop(1).map { it.split(ETX)[0].split(',') }
    val i = frames.indices.lastOrNull { k -> frames[k].size >= 12 && (frames.getOrNull(k + 1)?.size ?: 0) >= 9 }
        ?: return null
    val s1 = frames[i]
    val s2 = frames[i + 1]
    fun flag(v: String?) = v?.trim() == "1"
    fun int(v: String?) = jsParseInt(v ?: "") ?: 0
    return HostStatus(
        paperOut = flag(s1[1]), paused = flag(s1[2]), labelLength = int(s1[3]), formatsQueued = int(s1[4]),
        bufferFull = flag(s1[5]), partialFormat = flag(s1[7]), corruptRam = flag(s1[9]),
        underTemp = flag(s1[10]), overTemp = flag(s1[11]),
        headOpen = flag(s2[2]), ribbonOut = flag(s2[3]), thermalTransfer = flag(s2[4]),
        printMode = s2[5].trim(), labelWaiting = flag(s2[7]), labelsRemaining = int(s2[8]),
    )
}

private val DIR_HEADER = Regex("""DIR\s+\w:""", RegexOption.IGNORE_CASE)

// A size may be followed by attribute columns: a ZT220 lists a stored font as
// `E:TT0003M_.TTF  160676  K`, and a ZD421 lists a ROM font as `Z:0.TTF    125904  P    0`.
private val DIR_ROW = Regex(
    """^\s*\*?\s*(?:[A-Z]:)?([A-Z0-9_]{1,8}\.[A-Z0-9]{1,3})\s+(\d+)(?:\s+[A-Z0-9]+)*\s*$""",
    RegexOption.IGNORE_CASE,
)

/** Whether a reply is a `^HW` listing at all (a `DIR x:` header), so an unreadable reply isn't
 *  taken for an empty drive. */
fun isDirectoryListing(text: String): Boolean = DIR_HEADER.containsMatchIn(strip(text))

/** `^HW` → `- DIR E:*.*` header, `* NAME.EXT <bytes>` rows, `-<n> bytes free` trailer: the object
 *  names, upper-cased; empty when the reply isn't a listing (see [isDirectoryListing]). A straggling
 *  earlier listing can precede the fresh one, so only the last `DIR x:` block counts, and a repeated
 *  name keeps its last row's place. Mirrors parseDirectory in portal/src/labels/zebraUsb.ts. */
fun parseDirectory(text: String): List<String> {
    val full = strip(text)
    val header = DIR_HEADER.findAll(full).lastOrNull() ?: return emptyList()
    val names = LinkedHashSet<String>()
    for (line in full.substring(header.range.first).split(Regex("\r?\n"))) {
        val row = DIR_ROW.matchEntire(line) ?: continue
        val name = row.groupValues[1].uppercase()
        names.remove(name)
        names.add(name)
    }
    return names.toList()
}

/** An SGD getvar reply's value: surrounding whitespace and double quotes stripped; `"?"` (unknown
 *  variable) and an empty reply are null. Mirrors parseGetvar in kiosk/src/lib/stationPrinter.ts. */
fun parseGetvar(text: String): String? {
    var v = text.trim()
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.substring(1, v.length - 1).trim()
    return if (v.isEmpty() || v == "?") null else v
}
