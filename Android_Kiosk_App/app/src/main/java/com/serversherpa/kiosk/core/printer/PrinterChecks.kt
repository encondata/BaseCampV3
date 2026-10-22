package com.serversherpa.kiosk.core.printer

import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.isResidentFont
import com.serversherpa.kiosk.core.model.KioskLabelFont

/** What a `~HS` reply says to fix before printing: paper, head, pause. The words are the web
 *  kiosk's (statusProblems in kiosk/src/lib/stationPrinter.ts). */
fun statusProblems(status: HostStatus): List<String> = buildList {
    if (status.paperOut) add("Paper out: load labels.")
    if (status.headOpen) add("Head open: close the print head.")
    if (status.paused) add("Paused: press Pause on the printer to resume.")
}

/** The [needed] fonts (upper-case printer object names) that aren't among the printer's [onPrinter]
 *  objects, in [needed]'s order. A resident font counts too: it must be there, it is just never
 *  installed (see [fontFixFor]). */
fun missingFonts(needed: List<String>, onPrinter: List<String>): List<String> {
    val present = onPrinter.mapTo(HashSet()) { it.uppercase() }
    return needed.filter { it.uppercase() !in present }
}

/** What to do about the fonts missing from the printer: install the library's (never a resident
 *  one), say a built-in one is missing, and name the rest as not in the library. */
data class FontFix(val installable: List<KioskLabelFont>, val builtIn: List<String>, val notInLibrary: List<String>)

/** Mirrors fontFixFor in kiosk/src/lib/stationPrinter.ts: [missing] holds upper-case names, and
 *  [library] is the move's synced font rows. A font is resident by its name or by a library row's
 *  `resident` flag. */
fun fontFixFor(missing: List<String>, library: List<KioskLabelFont>): FontFix {
    fun resident(name: String): Boolean {
        val upper = name.uppercase()
        return isResidentFont(upper) || library.any { it.resident && it.name.uppercase() == upper }
    }
    val builtIn = missing.filter(::resident)
    val rest = missing.filter { it !in builtIn }
    val installable = library.filter { it.name.uppercase() in rest }
    val inLibrary = installable.mapTo(HashSet()) { it.name.uppercase() }
    return FontFix(installable, builtIn, rest.filter { it !in inLibrary })
}

/** The Top fallback template every move has (kiosk/src/lib/stationPrinter.ts GENERIC_TEMPLATE_NAME). */
const val GENERIC_TEMPLATE_NAME = "Generic Rack and RU"

private fun kindLabel(kind: LabelKind) = if (kind == LabelKind.FRONT) "Front" else "Top"

/** "a", "a and b", "a, b and c" ([word] "or": "a, b or c"). */
private fun joinWords(items: List<String>, word: String): String =
    if (items.size <= 1) items.joinToString("") else items.dropLast(1).joinToString(", ") + " $word " + items.last()

/** What the DPI check says when the move has no [kind] template at [printerDpi]: activate one, or
 *  the DPIs the move's template does print at ([available], the plan's `availableDpis`). The web
 *  kiosk's noTemplateText, with "sync this kiosk" for the laptop's "pick the move again". */
fun noTemplateText(kind: LabelKind, printerDpi: Int, available: List<Int>): String {
    val k = kindLabel(kind)
    val dpis = available.distinct().filter { it != printerDpi }.sorted().map { it.toString() }
    if (dpis.isEmpty()) {
        val fallback = if (kind == LabelKind.TOP) " ($GENERIC_TEMPLATE_NAME covers every move)" else ""
        return "No active $k template for this move. Someone with label access needs to activate one on " +
            "Labels › Templates in the portal$fallback, then sync this kiosk."
    }
    return "This move's $k template prints at ${joinWords(dpis, "and")} DPI only; this printer is $printerDpi DPI. " +
        "Activate a $printerDpi DPI version on Labels › Templates, or use a ${joinWords(dpis, "or")} DPI printer."
}

/** A resident font the printer lacks (stationPrinter.ts builtInFontText). */
fun builtInFontText(names: List<String>): String =
    if (names.size == 1) "Printer is missing its built-in font ${names[0]}."
    else "Printer is missing its built-in fonts ${names.joinToString(", ")}."

private val IPV4 = Regex("""(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})""")

/** A dotted IPv4 address, each part 0..255 without leading zeros (`010` could be read as octal). */
fun isIpv4(text: String): Boolean = IPV4.matchEntire(text)?.groupValues?.drop(1)
    ?.all { it.toInt() <= 255 && (it.length == 1 || !it.startsWith('0')) } == true
