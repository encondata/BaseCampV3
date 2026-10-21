package com.serversherpa.kiosk.core.labels

import kotlinx.serialization.Serializable

/** What labels print on: the top or the front of the device. [wire] is the generator's `kind`. */
enum class LabelKind(val wire: String) {
    TOP("top"), FRONT("front");

    companion object {
        /** Anything unknown (a selection saved before kinds existed) reads as Top. */
        fun fromWire(value: String?): LabelKind = entries.firstOrNull { it.wire == value } ?: TOP
    }
}

/** The network Zebra labels print to; its [dpi] picks the template. */
@Serializable
data class SavedPrinter(val host: String, val model: String, val serial: String, val dpi: Int)

/** The label settings: [kind] picks the template (with the printer's DPI); offsets (dots) and
 *  [peel] are applied only when a label is sent, so they never change a stored label. */
data class LabelSettings(
    val kind: LabelKind = LabelKind.TOP,
    val printer: SavedPrinter? = null,
    val offsetX: Int = 0,
    val offsetY: Int = 0,
    val peel: Boolean = false,
)

/** The label settings that live under the `ss.kiosk.labels` key: everything in [LabelSettings]
 *  except the kind, which is saved with the Kiosk Setup selection. */
@Serializable
data class LabelOptions(
    val printer: SavedPrinter? = null,
    val offsetX: Int = 0,
    val offsetY: Int = 0,
    val peel: Boolean = false,
)
