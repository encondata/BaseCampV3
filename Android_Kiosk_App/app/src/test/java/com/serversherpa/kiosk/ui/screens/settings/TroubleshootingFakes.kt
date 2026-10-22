package com.serversherpa.kiosk.ui.screens.settings

import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.printer.DirectoryEntry
import com.serversherpa.kiosk.core.printer.HostId
import com.serversherpa.kiosk.core.printer.HostStatus
import com.serversherpa.kiosk.core.printer.ZebraCommands
import com.serversherpa.kiosk.core.printer.parseDirectoryEntries
import com.serversherpa.kiosk.core.printer.parseGetvar
import com.serversherpa.kiosk.core.printer.parseHostStatus
import com.serversherpa.kiosk.data.labels.LabelSettingsSource
import com.serversherpa.kiosk.data.printer.PrinterBadReply
import com.serversherpa.kiosk.data.printer.PrinterNoReply
import com.serversherpa.kiosk.data.printer.SetupZebra
import com.serversherpa.kiosk.data.printer.WriteProgress
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow

// Settings › Troubleshooting's test printer, port and settings (the model's and the panel's tests).

/** The printer's port: every write or query that reached it, in the order they began, and how many
 *  were open at once. One whose text contains [hold] stays open while [hold] is set. */
internal class TroubleLine {
    val started: MutableList<String> = Collections.synchronizedList(ArrayList())
    private val open = AtomicInteger(0)
    val maxOpen = AtomicInteger(0)
    @Volatile var hold: String? = null
    @Volatile var held = false

    suspend fun connect(what: String) {
        started += what
        maxOpen.accumulateAndGet(open.incrementAndGet(), ::maxOf)
        try {
            while (hold?.let { what.contains(it) } == true) {
                held = true
                delay(2)
            }
        } finally {
            open.decrementAndGet()
        }
    }
}

/** A Zebra that records what reached it, in order (each send's text; each query as `?command`),
 *  answers queries from [replies] (no entry: no reply), and goes through [line] when one is set.
 *  [failNext] is thrown by the next call instead (once). */
internal class TroubleZebra : SetupZebra {
    @Volatile var replies: Map<String, String> = emptyMap()
    @Volatile var line: TroubleLine? = null
    @Volatile var failNext: Exception? = null
    val events: MutableList<String> = Collections.synchronizedList(ArrayList())

    private suspend fun reach(what: String) {
        failNext?.let { failNext = null; throw it }
        events += what
        line?.connect(what)
    }

    private suspend fun answer(command: String): String {
        reach("?$command")
        return replies[command] ?: throw PrinterNoReply(HOST)
    }

    override suspend fun identify(): HostId {
        reach("?${ZebraCommands.HOST_IDENTIFICATION}")
        return HostId("ZD421-300dpi", "V93.21.38Z", 12, "8176KB", 300)
    }
    override suspend fun serial(): String? = parseGetvar(answer(ZebraCommands.SERIAL_NUMBER))
    override suspend fun status(): HostStatus = parseHostStatus(answer(ZebraCommands.HOST_STATUS)) ?: throw PrinterBadReply(HOST, "status")
    override suspend fun peelerPresent(): Boolean? = parseGetvar(answer(ZebraCommands.PEELER_PRESENT)) == "Present"
    override suspend fun fonts(): List<String> = fontEntries().map { it.name }
    override suspend fun fontEntries(): List<DirectoryEntry> = parseDirectoryEntries(answer(ZebraCommands.FONT_DIRECTORY))
    override suspend fun send(zpl: String) = reach(zpl)
    override suspend fun installFont(name: String, bytes: ByteArray, progress: WriteProgress?) = reach("font $name")
    override suspend fun query(command: String, complete: (ByteArray) -> Boolean): String = answer(command)

    companion object { const val HOST = "10.0.0.5" }
}

/** The label settings, read only: Troubleshooting can't save a printer. */
internal class FixedSettings(printer: SavedPrinter?, kind: LabelKind = LabelKind.TOP) : LabelSettingsSource {
    override val settings = MutableStateFlow(LabelSettings(kind = kind, printer = printer))
}

// A ZD421-300dpi's replies (2026-10-19 over port 9100, 2026-10-22 over Bluetooth).
internal const val HS_REPLY = "\u0002030,0,0,0612,000,0,0,0,000,0,0,0\u0003\r\n\u0002000,0,0,0,0,1,6,0,00000000,1,000\u0003\r\n\u00020000,0\u0003\r\n"
internal const val HQES_REPLY = "\u0002\r\n\r\n  PRINTER STATUS                            \r\n   ERRORS:         0 00000000 00000000   \r\n" +
    "   WARNINGS:       0 00000000 00000000   \r\n\u0003"
internal const val HW_REPLY = "\u0002\r\n- DIR E:*.* \r\n* E:TT0003M_.TTF    169188       K  \r\n\r\n-  63311872 bytes free E: ONBOARD FLASH \r\n\u0003"
internal const val DPI_COMMAND = "! U1 getvar \"head.resolution.in_dpi\"\r\n"
internal const val ZD421_SERIAL = "D8J224508535"
internal const val SAVED_ADDRESS = "AC:3F:A4:00:00:01"
internal const val FOUND_ADDRESS = "AC:3F:A4:00:00:02"
internal const val DEVICE_TEXT = "Device: Google Pixel 10 Pro XL, Android 16 (API 36)\nApp: version 0.1.0 (build 1)"
