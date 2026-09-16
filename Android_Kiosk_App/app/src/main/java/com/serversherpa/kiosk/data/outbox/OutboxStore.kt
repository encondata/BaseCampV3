package com.serversherpa.kiosk.data.outbox

import com.serversherpa.kiosk.core.outbox.OutboxRow
import com.serversherpa.kiosk.data.db.OutboxDao
import com.serversherpa.kiosk.data.db.toEntity

interface OutboxStore {
    suspend fun all(): List<OutboxRow>
    suspend fun upsert(rows: List<OutboxRow>)
    suspend fun delete(ids: List<String>)
}

class RoomOutboxStore(private val dao: OutboxDao) : OutboxStore {
    override suspend fun all(): List<OutboxRow> = dao.all().map { it.toRow() }
    override suspend fun upsert(rows: List<OutboxRow>) { if (rows.isNotEmpty()) dao.upsert(rows.map { it.toEntity() }) }
    override suspend fun delete(ids: List<String>) { if (ids.isNotEmpty()) dao.delete(ids) }
}

class MemoryOutboxStore : OutboxStore {
    private val rows = LinkedHashMap<String, OutboxRow>()
    override suspend fun all(): List<OutboxRow> = rows.values.toList()
    override suspend fun upsert(rows: List<OutboxRow>) { rows.forEach { this.rows[it.clientScanId] = it } }
    override suspend fun delete(ids: List<String>) { ids.forEach { rows.remove(it) } }
}
