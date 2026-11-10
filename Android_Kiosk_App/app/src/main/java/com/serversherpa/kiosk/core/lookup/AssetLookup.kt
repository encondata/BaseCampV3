package com.serversherpa.kiosk.core.lookup

import com.serversherpa.kiosk.core.model.KioskAssetDetail
import com.serversherpa.kiosk.core.model.KioskAssetEnd
import com.serversherpa.kiosk.core.model.KioskAssetFull
import com.serversherpa.kiosk.core.model.KioskAssetMove
import com.serversherpa.kiosk.core.model.KioskAssetRoute
import com.serversherpa.kiosk.core.model.KioskLookupMatch
import com.serversherpa.kiosk.core.model.KioskLookupResult
import com.serversherpa.kiosk.core.scan.padRfid
import com.serversherpa.kiosk.core.text.naturalCompare
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.serialization.Serializable

/** Port of kiosk/src/lib/assetLookup.ts: the offline half of Asset Lookup. */
const val LOOKUP_CAP = 25
const val SCAN_LIMIT = 50

/** The synced asset fields this file reads (decoded from `payload_json`). */
@Serializable
data class LocalAsset(
    val id: String,
    val asset_id: String = "",
    val name: String? = null,
    val rfid: String? = null,
    val serial_number: String? = null,
    val make: String? = null,
    val model: String? = null,
    val make_model: String = "",
    val container_id: String? = null,
    val source_rack: String? = null,
    val source_ru: String? = null,
    val source_position: String? = null,
    val source_pod: String? = null,
    val destination_rack: String? = null,
    val destination_ru: String? = null,
    val destination_position: String? = null,
    val destination_pod: String? = null,
    val asset_status: String? = null,
    val asset_status_label: String? = null,
    val location_detail: String? = null,
)

data class LocalLookupData(
    val assets: List<LocalAsset>,
    val containerNames: Map<String, String>,
    val moveId: String,
    val moveName: String,
    val sourceSite: String?,
    val destinationSite: String?,
)

fun matchLabel(kind: String): String = when (kind) {
    "asset_tag" -> "Asset tag"
    "serial" -> "Serial"
    "rfid" -> "RFID"
    "name" -> "Name"
    else -> kind
}

private val TAG_VALUE = Regex("^[1-9][0-9]*$")

private fun toMatch(a: LocalAsset, matched: List<String>) = KioskLookupMatch(
    id = a.id, name = a.name, asset_tag = a.asset_id, serial_number = a.serial_number, matched = matched,
)

fun matchLocal(assets: List<LocalAsset>, raw: String): KioskLookupResult {
    val value = raw.trim()
    if (value.isEmpty()) return KioskLookupResult(emptyList(), false)
    val wantTag = TAG_VALUE.matches(value) && value.length <= 18
    val rfid = padRfid(value).tag

    val exact = ArrayList<KioskLookupMatch>()
    for (a in assets) {
        val kinds = ArrayList<String>()
        if (wantTag && a.asset_id == value) kinds.add("asset_tag")
        val sn = a.serial_number
        if (!sn.isNullOrEmpty() && sn.trim().equals(value, ignoreCase = true)) kinds.add("serial")
        val ar = a.rfid
        if (rfid != null && !ar.isNullOrEmpty() && padRfid(ar).tag == rfid) kinds.add("rfid")
        if (kinds.isNotEmpty()) exact.add(toMatch(a, kinds))
    }
    if (exact.isNotEmpty()) {
        val sorted = exact.sortedWith { x, y ->
            val c = naturalCompare(x.name, y.name)
            if (c != 0) c else naturalCompare(x.asset_tag, y.asset_tag)
        }
        return KioskLookupResult(sorted.take(LOOKUP_CAP), sorted.size > LOOKUP_CAP)
    }

    val named = assets
        .filter { it.name?.contains(value, ignoreCase = true) == true }
        .sortedWith { x, y -> naturalCompare(x.name, y.name) }
        .map { toMatch(it, listOf("name")) }
    return KioskLookupResult(named.take(LOOKUP_CAP), named.size > LOOKUP_CAP)
}

fun localDetail(asset: LocalAsset, data: LocalLookupData, admin: Boolean): KioskAssetDetail {
    fun end(site: String?, pod: String?, rack: String?, ru: String?, position: String?) =
        KioskAssetEnd(site_name = site, pod = pod, rack = rack, ru = ru, position = position)
    return KioskAssetDetail(
        id = asset.id,
        name = asset.name,
        make = asset.make,
        model = asset.model,
        make_model = asset.make_model,
        asset_tag = asset.asset_id,
        serial_number = asset.serial_number,
        rfid = asset.rfid,
        routes = listOf(
            KioskAssetRoute(
                initiative_id = data.moveId,
                initiative_name = data.moveName,
                source = end(data.sourceSite, asset.source_pod, asset.source_rack, asset.source_ru, asset.source_position),
                destination = end(
                    data.destinationSite, asset.destination_pod, asset.destination_rack,
                    asset.destination_ru, asset.destination_position,
                ),
            ),
        ),
        full = if (admin) {
            KioskAssetFull(
                status = asset.asset_status ?: "",
                status_label = asset.asset_status_label ?: "",
                status_color = "",
                moves = if (data.moveId.isNotEmpty()) {
                    listOf(KioskAssetMove(data.moveId, data.moveName, "", "", ""))
                } else {
                    emptyList()
                },
                container_name = asset.container_id?.let { data.containerNames[it] },
                truck_name = null,
                location_detail = asset.location_detail ?: "",
            )
        } else {
            null
        },
    )
}

/** "<container> · on <truck>", the container alone, else the location text. */
fun placementText(full: KioskAssetFull): String {
    val c = full.container_name
    if (!c.isNullOrEmpty()) {
        val t = full.truck_name
        return if (!t.isNullOrEmpty()) "$c · on $t" else c
    }
    return full.location_detail
}

private val WHEN_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

/** A scan time, 24-hour, in [zone]; the raw value when it doesn't parse. */
fun scanWhenText(iso: String, zone: ZoneId): String {
    val instant = try {
        Instant.parse(iso)
    } catch (_: Exception) {
        try {
            OffsetDateTime.parse(iso).toInstant()
        } catch (_: Exception) {
            return iso
        }
    }
    return WHEN_FORMAT.format(instant.atZone(zone))
}

/** Padded, valid tags only, de-duplicated in first-seen order. */
fun distinctTags(epcs: List<String>): List<String> =
    epcs.mapNotNull { padRfid(it).tag }.distinct()
