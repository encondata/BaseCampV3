package com.serversherpa.kiosk.data.sync

import androidx.room.withTransaction
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.MOVE_META_KEY
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.db.toEntity
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

enum class SyncPhase { IDLE, RUNNING, DONE, ERROR }

data class SyncStatus(
    val phase: SyncPhase = SyncPhase.IDLE,
    val assets: Int? = null, val people: Int? = null, val containers: Int? = null, val trucks: Int? = null,
    val syncedAt: String? = null, val error: String? = null,
)

@Serializable
data class SyncMeta(
    val initiativeId: String, val initiativeName: String,
    val assets: Int, val people: Int, val containers: Int, val trucks: Int, val syncedAt: String,
)

/**
 * kiosk/src/lib/sync.ts: fetch all four endpoints in parallel, then
 * replace all four tables and the meta row in ONE transaction. A failed
 * fetch leaves the cached rows untouched. Sync never touches setup state.
 */
class Sync(
    private val api: KioskApi,
    private val db: KioskDatabase,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status
    private var currentRun = 0
    private var hydrated = false

    /** Reads the persisted meta row once so a relaunch shows DONE with counts. */
    suspend fun hydrate() {
        if (hydrated) return
        hydrated = true
        val meta = readMeta(db) ?: return
        if (_status.value.phase != SyncPhase.IDLE) return
        _status.value = SyncStatus(SyncPhase.DONE, meta.assets, meta.people, meta.containers, meta.trucks, meta.syncedAt)
    }

    fun run(initiativeId: String, initiativeName: String) { scope.launch { runNow(initiativeId, initiativeName) } }

    suspend fun runNow(initiativeId: String, initiativeName: String) {
        val myRun = ++currentRun
        val previous = _status.value
        _status.value = previous.copy(phase = SyncPhase.RUNNING, error = null)
        val fetched = try {
            coroutineScope {
                val a = async { api.syncAssets(initiativeId) }
                val p = async { api.syncPeople() }
                val c = async { api.syncContainers(initiativeId) }
                val t = async { api.syncTrucks(initiativeId) }
                Fetched(a.await(), p.await(), c.await(), t.await())
            }
        } catch (e: Exception) {
            if (myRun != currentRun) return
            _status.value = previous.copy(phase = SyncPhase.ERROR, error = if (e is ApiError) e.code else "unknown_error")
            return
        }
        if (myRun != currentRun) return
        try {
            val syncedAt = Instant.ofEpochMilli(clock()).toString()
            db.withTransaction {
                db.assets().deleteAll(); db.assets().insertAll(fetched.assets.assets.map { it.toEntity() })
                db.people().deleteAll(); db.people().insertAll(fetched.people.people.map { it.toEntity() })
                db.containers().deleteAll(); db.containers().insertAll(fetched.containers.containers.map { it.toEntity() })
                db.trucks().deleteAll(); db.trucks().insertAll(fetched.trucks.trucks.map { it.toEntity() })
                val meta = SyncMeta(
                    initiativeId, initiativeName, fetched.assets.assets.size, fetched.people.people.size,
                    fetched.containers.containers.size, fetched.trucks.trucks.size, syncedAt,
                )
                db.meta().put(MetaEntity(MOVE_META_KEY, KioskJson.encodeToString(SyncMeta.serializer(), meta)))
            }
            if (myRun != currentRun) return
            hydrated = true
            _status.value = SyncStatus(
                SyncPhase.DONE, db.assets().count(), db.people().count(), db.containers().count(), db.trucks().count(), syncedAt,
            )
        } catch (e: Exception) {
            if (myRun != currentRun) return
            _status.value = previous.copy(phase = SyncPhase.ERROR, error = "storage")
        }
    }

    /** "Clear local data": the move tables and the meta row — never the outbox. */
    suspend fun clearLocalData() {
        db.withTransaction {
            db.assets().deleteAll(); db.people().deleteAll(); db.containers().deleteAll(); db.trucks().deleteAll()
            db.meta().delete(MOVE_META_KEY)
        }
        hydrated = false
        _status.value = SyncStatus()
    }

    private class Fetched(
        val assets: com.serversherpa.kiosk.core.model.KioskAssetsSync,
        val people: com.serversherpa.kiosk.core.model.KioskPeopleSync,
        val containers: com.serversherpa.kiosk.core.model.KioskContainersSync,
        val trucks: com.serversherpa.kiosk.core.model.KioskTrucksSync,
    )

    companion object {
        suspend fun readMeta(db: KioskDatabase): SyncMeta? = db.meta().get(MOVE_META_KEY)?.let {
            try { KioskJson.decodeFromString(SyncMeta.serializer(), it.value) } catch (e: Exception) { null }
        }

        /** "2:14 PM" — the time alone; the kiosk syncs per shift. */
        fun formatSyncedAt(iso: String): String = try {
            DateTimeFormatter.ofPattern("h:mm a").format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
        } catch (e: Exception) { iso }
    }
}
