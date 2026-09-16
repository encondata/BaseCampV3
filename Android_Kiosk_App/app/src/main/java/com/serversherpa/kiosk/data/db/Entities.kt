package com.serversherpa.kiosk.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import com.serversherpa.kiosk.core.model.KioskAssetRow
import com.serversherpa.kiosk.core.model.KioskContainerRow
import com.serversherpa.kiosk.core.model.KioskPersonRow
import com.serversherpa.kiosk.core.model.KioskTruckRow
import com.serversherpa.kiosk.core.outbox.OutboxAsset
import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.core.outbox.OutboxStatus
import com.serversherpa.kiosk.core.people.MatchPerson
import com.serversherpa.kiosk.core.scan.ScanAsset
import com.serversherpa.kiosk.data.api.KioskJson
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

@Entity(tableName = "assets", indices = [Index("rfid"), Index("asset_id"), Index("serial_number")])
data class AssetEntity(
    @PrimaryKey override val id: String,
    @ColumnInfo(name = "asset_id") override val assetId: String,
    override val name: String?,
    override val rfid: String?,
    @ColumnInfo(name = "serial_number") override val serialNumber: String?,
    val make: String?,
    val model: String?,
    @ColumnInfo(name = "make_model") override val makeModel: String,
    @ColumnInfo(name = "container_id") val containerId: String?,
    @ColumnInfo(name = "label_json") val labelJson: String,
) : ScanAsset {
    fun label(): Map<String, String> = try {
        KioskJson.decodeFromString(MapSerializer(String.serializer(), String.serializer()), labelJson)
    } catch (e: Exception) { emptyMap() }

    fun toOutboxAsset() = OutboxAsset(id, assetId, name, rfid, serialNumber, makeModel)
}

fun KioskAssetRow.toEntity() = AssetEntity(
    id, asset_id, name, rfid, serial_number, make, model, make_model, container_id,
    KioskJson.encodeToString(MapSerializer(String.serializer(), String.serializer()), label),
)

@Entity(tableName = "people", indices = [Index("rfid_tag")])
data class PersonEntity(
    @PrimaryKey override val id: String,
    @ColumnInfo(name = "display_name") override val displayName: String,
    @ColumnInfo(name = "first_name") override val firstName: String?,
    @ColumnInfo(name = "last_name") override val lastName: String?,
    @ColumnInfo(name = "preferred_name") override val preferredName: String?,
    @ColumnInfo(name = "rfid_tag") override val rfidTag: String?,
    @ColumnInfo(name = "is_worker") override val isWorker: Boolean,
    @ColumnInfo(name = "has_account") override val hasAccount: Boolean,
) : MatchPerson

fun KioskPersonRow.toEntity() = PersonEntity(id, display_name, first_name, last_name, preferred_name, rfid_tag, is_worker, has_account)

@Entity(tableName = "containers", indices = [Index("rfid_tag"), Index("name")])
data class ContainerEntity(
    @PrimaryKey val id: String, val name: String, @ColumnInfo(name = "rfid_tag") val rfidTag: String?,
    @ColumnInfo(name = "label_tag") val labelTag: String?, @ColumnInfo(name = "container_type") val containerType: String?,
    val status: String, @ColumnInfo(name = "status_label") val statusLabel: String,
    @ColumnInfo(name = "site_id") val siteId: String?, @ColumnInfo(name = "site_name") val siteName: String?,
    @ColumnInfo(name = "asset_count") val assetCount: Int,
)

fun KioskContainerRow.toEntity() = ContainerEntity(id, name, rfid_tag, label_tag, container_type, status, status_label, site_id, site_name, asset_count)

@Entity(tableName = "trucks", indices = [Index("name"), Index("load_number")])
data class TruckEntity(
    @PrimaryKey val id: String, val name: String, @ColumnInfo(name = "load_number") val loadNumber: String?,
    val status: String, @ColumnInfo(name = "status_label") val statusLabel: String, @ColumnInfo(name = "driver_name") val driverName: String?,
    @ColumnInfo(name = "start_site_id") val startSiteId: String?, @ColumnInfo(name = "start_site_name") val startSiteName: String?,
    @ColumnInfo(name = "end_site_id") val endSiteId: String?, @ColumnInfo(name = "end_site_name") val endSiteName: String?,
    @ColumnInfo(name = "container_count") val containerCount: Int,
)

fun KioskTruckRow.toEntity() = TruckEntity(id, name, load_number, status, status_label, driver_name, start_site_id, start_site_name, end_site_id, end_site_name, container_count)

@Entity(tableName = "meta")
data class MetaEntity(@PrimaryKey val key: String, val value: String)

@Entity(tableName = "outbox", indices = [Index("status"), Index("seq")])
data class OutboxEntity(
    @PrimaryKey @ColumnInfo(name = "client_scan_id") val clientScanId: String,
    val seq: Long,
    @ColumnInfo(name = "scanned_value") val scannedValue: String,
    @ColumnInfo(name = "scan_type") val scanType: String,
    @ColumnInfo(name = "scanned_at") val scannedAt: String,
    @ColumnInfo(name = "asset_id") val assetId: String?,
    @ColumnInfo(name = "asset_tag") val assetTag: String?,
    @ColumnInfo(name = "asset_name") val assetName: String?,
    @ColumnInfo(name = "asset_rfid") val assetRfid: String?,
    @ColumnInfo(name = "asset_serial") val assetSerial: String?,
    @ColumnInfo(name = "asset_make_model") val assetMakeModel: String?,
    val matched: Boolean,
    val status: String,
    val attempts: Int,
    @ColumnInfo(name = "next_attempt_at") val nextAttemptAt: Long?,
    @ColumnInfo(name = "last_error") val lastError: String?,
    @ColumnInfo(name = "site_id") val siteId: String,
    @ColumnInfo(name = "initiative_id") val initiativeId: String,
    @ColumnInfo(name = "scan_status") val scanStatus: String,
) {
    fun toRow() = OutboxRow(
        clientScanId, seq, scannedValue, scanType, scannedAt,
        asset = assetId?.let { OutboxAsset(it, assetTag ?: "", assetName, assetRfid, assetSerial, assetMakeModel ?: "") },
        matched = matched, status = OutboxStatus.fromWire(status), attempts = attempts, nextAttemptAt = nextAttemptAt,
        lastError = lastError, siteId = siteId, initiativeId = initiativeId, scanStatus = scanStatus,
    )
}

fun OutboxRow.toEntity() = OutboxEntity(
    clientScanId, seq, scannedValue, scanType, scannedAt,
    asset?.id, asset?.assetId, asset?.name, asset?.rfid, asset?.serialNumber, asset?.makeModel,
    matched, status.wire, attempts, nextAttemptAt, lastError, siteId, initiativeId, scanStatus,
)
