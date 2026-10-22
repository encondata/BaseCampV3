package com.serversherpa.kiosk.core.labels

/** Zebra's resident fonts: built into the printer, so never downloaded or pushed to it (the
 *  kiosk font route refuses them). Mirrors RESIDENT_FONTS in kiosk/src/lib/stationPrinter.ts. */
val RESIDENT_FONTS: List<String> = listOf("TT0003M_.TTF")

/** A resident font, by the library's `resident` flag or by its printer object name. */
fun isResidentFont(name: String, residentFlag: Boolean = false): Boolean =
    residentFlag || name.uppercase() in RESIDENT_FONTS
