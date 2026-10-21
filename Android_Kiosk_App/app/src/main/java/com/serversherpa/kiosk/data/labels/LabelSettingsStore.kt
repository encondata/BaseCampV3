package com.serversherpa.kiosk.data.labels

import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * The label settings, read from two places: the kind (Top or Front) from the Kiosk Setup
 * selection, and the printer, offsets and peel/tear choice from the `ss.kiosk.labels` key.
 * Both come from the same DataStore, so the first value is the stored one, never the
 * defaults followed by the stored one (which would start a label build for nothing).
 */
class LabelSettingsStore(private val prefs: KioskPrefs) : LabelSettingsSource {
    override val settings: Flow<LabelSettings> =
        combine(prefs.setupSelection, prefs.labels) { selection, options ->
            LabelSettings(
                kind = LabelKind.fromWire(selection?.labelKind),
                printer = options.printer,
                offsetX = options.offsetX,
                offsetY = options.offsetY,
                peel = options.peel,
            )
        }.distinctUntilChanged()

    suspend fun setPrinter(printer: SavedPrinter?) = prefs.updateLabels { it.copy(printer = printer) }
    suspend fun setOffsets(x: Int, y: Int) = prefs.updateLabels { it.copy(offsetX = x, offsetY = y) }
    suspend fun setPeel(peel: Boolean) = prefs.updateLabels { it.copy(peel = peel) }
}
