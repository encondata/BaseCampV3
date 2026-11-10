package com.serversherpa.kiosk.data.lookup

import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.lookup.LocalAsset
import com.serversherpa.kiosk.core.lookup.LocalLookupData
import com.serversherpa.kiosk.core.lookup.SCAN_LIMIT
import com.serversherpa.kiosk.core.lookup.localDetail
import com.serversherpa.kiosk.core.lookup.matchLocal
import com.serversherpa.kiosk.core.model.AssetScanRow
import com.serversherpa.kiosk.core.model.KioskAssetDetail
import com.serversherpa.kiosk.core.model.KioskLookupResult
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.LABEL_CONTEXT_META_KEY
import com.serversherpa.kiosk.data.sync.Sync
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

data class Found(val offline: Boolean, val result: KioskLookupResult)
data class Opened(val offline: Boolean, val detail: KioskAssetDetail?)

/**
 * Asset Lookup data: ask the API first; when the network is unreachable fall back to the
 * move's synced assets in Room. Only a network failure (or `edge_offline`) falls back;
 * every other error propagates. Nothing here writes anything (no Outbox).
 * Port of kiosk/src/lib/assetLookup.ts.
 */
class AssetLookupRepository(private val api: KioskApi, private val db: KioskDatabase) {

    private fun isOffline(e: ApiError) = e.isNetwork || e.code == "edge_offline"

    suspend fun find(serial: String, value: String): Found =
        try {
            Found(false, api.lookupAssets(serial, value))
        } catch (e: ApiError) {
            if (!isOffline(e)) throw e
            Found(true, matchLocal(loadLocal().assets, value))
        }

    suspend fun open(serial: String, id: String, offline: Boolean, admin: Boolean): Opened {
        if (!offline) {
            try {
                return Opened(false, api.assetDetail(serial, id))
            } catch (e: ApiError) {
                if (!isOffline(e)) throw e
            }
        }
        val data = loadLocal()
        val asset = data.assets.firstOrNull { it.id == id }
        return Opened(true, asset?.let { localDetail(it, data, admin) })
    }

    suspend fun scans(serial: String, id: String): List<AssetScanRow> = api.assetScans(serial, id, SCAN_LIMIT)

    suspend fun loadLocal(): LocalLookupData {
        val assets = db.assets().all().mapNotNull {
            try { KioskJson.decodeFromString(LocalAsset.serializer(), it.payloadJson) } catch (e: Exception) { null }
        }
        val containerNames = db.containers().all().associate { it.id to it.name }
        val meta = Sync.readMeta(db)
        val ctx: JsonObject? = db.meta().get(LABEL_CONTEXT_META_KEY)?.value?.let {
            try { KioskJson.parseToJsonElement(it).jsonObject } catch (e: Exception) { null }
        }
        fun text(key: String): String? =
            (ctx?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
        return LocalLookupData(
            assets = assets,
            containerNames = containerNames,
            moveId = meta?.initiativeId ?: "",
            moveName = meta?.initiativeName ?: "",
            sourceSite = text("source_site"),
            destinationSite = text("destination_site"),
        )
    }
}
