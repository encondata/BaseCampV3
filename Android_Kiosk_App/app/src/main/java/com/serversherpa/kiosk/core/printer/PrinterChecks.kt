package com.serversherpa.kiosk.core.printer

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
