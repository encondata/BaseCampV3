package com.serversherpa.kiosk.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface AssetDao {
    @Query("SELECT * FROM assets") suspend fun all(): List<AssetEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<AssetEntity>)
    @Query("DELETE FROM assets") suspend fun deleteAll()
    @Query("SELECT COUNT(*) FROM assets") suspend fun count(): Int
    @Query("UPDATE assets SET rfid = :rfid WHERE id = :id") suspend fun updateRfid(id: String, rfid: String)
}

@Dao
interface PersonDao {
    @Query("SELECT * FROM people") suspend fun all(): List<PersonEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<PersonEntity>)
    @Query("DELETE FROM people") suspend fun deleteAll()
    @Query("SELECT COUNT(*) FROM people") suspend fun count(): Int
}

@Dao
interface ContainerDao {
    @Query("SELECT * FROM containers") suspend fun all(): List<ContainerEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<ContainerEntity>)
    @Query("DELETE FROM containers") suspend fun deleteAll()
    @Query("SELECT COUNT(*) FROM containers") suspend fun count(): Int
}

@Dao
interface TruckDao {
    @Query("SELECT * FROM trucks") suspend fun all(): List<TruckEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<TruckEntity>)
    @Query("DELETE FROM trucks") suspend fun deleteAll()
    @Query("SELECT COUNT(*) FROM trucks") suspend fun count(): Int
}

@Dao
interface MetaDao {
    @Query("SELECT * FROM meta WHERE `key` = :key") suspend fun get(key: String): MetaEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun put(row: MetaEntity)
    @Query("DELETE FROM meta WHERE `key` = :key") suspend fun delete(key: String)
}

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox") suspend fun all(): List<OutboxEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsert(rows: List<OutboxEntity>)
    @Query("DELETE FROM outbox WHERE client_scan_id IN (:ids)") suspend fun delete(ids: List<String>)
}

@Dao
interface LabelTemplateDao {
    /** In insertion order: the server's order, which template ties depend on. */
    @Query("SELECT * FROM label_templates ORDER BY rowid") suspend fun all(): List<LabelTemplateEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<LabelTemplateEntity>)
    @Query("DELETE FROM label_templates") suspend fun deleteAll()
    @Query("SELECT COUNT(*) FROM label_templates") suspend fun count(): Int
}

@Dao
interface LabelFontDao {
    @Query("SELECT * FROM label_fonts") suspend fun all(): List<LabelFontEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<LabelFontEntity>)
    @Query("DELETE FROM label_fonts") suspend fun deleteAll()
    @Query("SELECT COUNT(*) FROM label_fonts") suspend fun count(): Int
}

@Dao
interface GeneratedLabelDao {
    @Query("SELECT * FROM generated_labels") suspend fun all(): List<GeneratedLabelEntity>
    @Query("SELECT * FROM generated_labels WHERE asset_id = :assetId") suspend fun get(assetId: String): GeneratedLabelEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsert(rows: List<GeneratedLabelEntity>)
    @Query("DELETE FROM generated_labels WHERE asset_id IN (:assetIds)") suspend fun delete(assetIds: List<String>)
    @Query("DELETE FROM generated_labels") suspend fun deleteAll()
}
