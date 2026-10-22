package com.serversherpa.kiosk.core.labels

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/** What labels print on: the top or the front of the device. [wire] is the generator's `kind`. */
enum class LabelKind(val wire: String) {
    TOP("top"), FRONT("front");

    companion object {
        /** Anything unknown (a selection saved before kinds existed) reads as Top. */
        fun fromWire(value: String?): LabelKind = entries.firstOrNull { it.wire == value } ?: TOP
    }
}

/** How the handheld reaches its printer: a network host (TCP port 9100), or Bluetooth LE by the
 *  printer's [serial] (its Bluetooth name) plus the MAC [address] Android handed out when the
 *  printer was found (null until then). */
@Serializable
sealed interface PrinterConnection {
    @Serializable @SerialName("network")
    data class Network(val host: String) : PrinterConnection

    @Serializable @SerialName("bluetooth")
    data class Bluetooth(val serial: String, val address: String? = null) : PrinterConnection
}

/** Which printer a connection reaches, whatever the way: the network host, or the Bluetooth serial
 *  (in any case). The address Android hands out for a Bluetooth printer only finds it, and can
 *  change, so it isn't part of it (iOS Ruling 7). Saved as `{"type":"network","host":…}` or
 *  `{"type":"bluetooth","serial":…}` (the printer stops, `PrinterStopsStore`). */
@Serializable
sealed interface PrinterIdentity {
    @Serializable @SerialName("network")
    data class Network(val host: String) : PrinterIdentity

    @Serializable @SerialName("bluetooth")
    data class Bluetooth(val serial: String) : PrinterIdentity

    /** A stable order for saving ("bluetooth:…" before "network:…"). */
    val sortKey: String get() = when (this) {
        is Network -> "network:$host"
        is Bluetooth -> "bluetooth:$serial"
    }
}

val PrinterConnection.identity: PrinterIdentity get() = when (this) {
    is PrinterConnection.Network -> PrinterIdentity.Network(host)
    is PrinterConnection.Bluetooth -> PrinterIdentity.Bluetooth(serial.uppercase())
}

/** The Zebra labels print to; its [dpi] picks the template.
 *
 *  Saved as JSON with `connection` and, for a build from before Bluetooth, the old `host` beside
 *  it (the network host, or `""` for a Bluetooth printer). A printer saved before Bluetooth has
 *  only `host`, and reads back as a network printer. See [SavedPrinterSerializer]. */
@Serializable(with = SavedPrinterSerializer::class)
data class SavedPrinter(val connection: PrinterConnection, val model: String, val serial: String, val dpi: Int) {
    /** A network printer at [host]. */
    constructor(host: String, model: String, serial: String, dpi: Int) :
        this(PrinterConnection.Network(host), model, serial, dpi)

    /** The network host; null for a Bluetooth printer. */
    val host: String? get() = (connection as? PrinterConnection.Network)?.host

    val isBluetooth: Boolean get() = connection is PrinterConnection.Bluetooth
}

/** The saved printer's JSON. `host` has no default, so it is written even when blank (an older
 *  build requires it); `connection` is optional on the way in, so a printer saved before Bluetooth
 *  still reads. */
@Serializable
@SerialName("SavedPrinter")
private class SavedPrinterJson(
    val connection: PrinterConnection? = null,
    val host: String? = null,
    val model: String,
    val serial: String,
    val dpi: Int,
)

object SavedPrinterSerializer : KSerializer<SavedPrinter> {
    override val descriptor: SerialDescriptor = SavedPrinterJson.serializer().descriptor

    override fun serialize(encoder: Encoder, value: SavedPrinter) {
        encoder.encodeSerializableValue(
            SavedPrinterJson.serializer(),
            SavedPrinterJson(value.connection, value.host.orEmpty(), value.model, value.serial, value.dpi),
        )
    }

    /** The `connection` wins over the `host` it travels with; with no `connection`, `host` is a network printer. */
    override fun deserialize(decoder: Decoder): SavedPrinter {
        val json = decoder.decodeSerializableValue(SavedPrinterJson.serializer())
        val connection = json.connection
            ?: PrinterConnection.Network(json.host ?: throw SerializationException("a saved printer needs a connection or a host"))
        return SavedPrinter(connection, json.model, json.serial, json.dpi)
    }
}

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
