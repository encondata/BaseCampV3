package com.serversherpa.kiosk.data.sync

import androidx.room.withTransaction
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.labels.isResidentFont
import com.serversherpa.kiosk.core.model.KioskAssetsSync
import com.serversherpa.kiosk.core.model.KioskContainersSync
import com.serversherpa.kiosk.core.model.KioskPeopleSync
import com.serversherpa.kiosk.core.model.KioskTrucksSync
import com.serversherpa.kiosk.data.api.KioskApi
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.LABEL_CONTEXT_META_KEY
import com.serversherpa.kiosk.data.db.LabelFontEntity
import com.serversherpa.kiosk.data.db.LabelTemplateEntity
import com.serversherpa.kiosk.data.db.MOVE_META_KEY
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.db.toEntity
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

enum class SyncPhase { IDLE, RUNNING, DONE, ERROR }

enum class PartState { WAITING, RUNNING, DONE, FAILED }

/** One download of a sync: assets|people|containers|trucks|templates|fonts. [count] once DONE. */
data class SyncPart(val name: String, val state: PartState, val count: Int? = null)

/** The parts in display order. The first four are the move (all or nothing); templates and
 *  fonts are soft: a failure sets [SyncStatus.labelsError] and keeps their previous rows when
 *  the move is unchanged (a move change clears them instead). */
val SYNC_PARTS = listOf("assets", "people", "containers", "trucks", "templates", "fonts")
private val MOVE_PARTS = SYNC_PARTS.take(4)

private fun waitingParts() = SYNC_PARTS.map { SyncPart(it, PartState.WAITING) }

data class SyncStatus(
    val phase: SyncPhase = SyncPhase.IDLE,
    val assets: Int? = null, val people: Int? = null, val containers: Int? = null, val trucks: Int? = null,
    val syncedAt: String? = null, val error: String? = null,
    val parts: List<SyncPart> = waitingParts(),
    /** The code of the first failed label download (templates, then fonts); the move sync still finishes. */
    val labelsError: String? = null,
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
 *
 * Labels ride along: the label templates are fetched beside the move and stored in the same
 * transaction when they arrived; the fonts follow once the move is stored, each non-resident
 * font downloaded to [fontsDir] (skipped when the file is already there at the listed size).
 * Neither can fail the move sync. A null [fontsDir] keeps font metadata only.
 */
class Sync(
    private val api: KioskApi,
    private val db: KioskDatabase,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val fontsDir: File? = null,
) {
    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status
    @Volatile private var currentRun = 0
    private var hydrated = false

    /** Reads the persisted meta row once so a relaunch shows DONE with counts. */
    suspend fun hydrate() {
        if (hydrated) return
        hydrated = true
        val meta = readMeta(db) ?: return
        // No label_context row: the labels were never synced (e.g. right after the version 2
        // upgrade), so templates and fonts read WAITING and the UI can prompt a sync.
        val labelsSynced = db.meta().get(LABEL_CONTEXT_META_KEY) != null
        val templates = db.labelTemplates().count()
        val fonts = db.labelFonts().count()
        if (_status.value.phase != SyncPhase.IDLE) return
        val counts = listOf(meta.assets, meta.people, meta.containers, meta.trucks, templates, fonts)
        _status.value = SyncStatus(
            SyncPhase.DONE, meta.assets, meta.people, meta.containers, meta.trucks, meta.syncedAt,
            parts = SYNC_PARTS.zip(counts) { name, n ->
                if (labelsSynced || name in MOVE_PARTS) SyncPart(name, PartState.DONE, n) else SyncPart(name, PartState.WAITING)
            },
        )
    }

    fun run(initiativeId: String, initiativeName: String) { scope.launch { runNow(initiativeId, initiativeName) } }

    suspend fun runNow(initiativeId: String, initiativeName: String) {
        val myRun = ++currentRun
        val previous = _status.value
        _status.value = previous.copy(phase = SyncPhase.RUNNING, error = null, labelsError = null, parts = waitingParts())
        var templatesError: String? = null
        val fetched = try {
            coroutineScope {
                val a = async { part(myRun, "assets") { parseAssets(api.assetsSyncRaw(initiativeId)) } }
                val p = async { part(myRun, "people") { api.syncPeople() } }
                val c = async { part(myRun, "containers") { api.syncContainers(initiativeId) } }
                val t = async { part(myRun, "trucks") { api.syncTrucks(initiativeId) } }
                val l = async {
                    try {
                        part(myRun, "templates") { parseTemplates(api.labelTemplatesRaw(initiativeId)) }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        templatesError = codeOf(e); null
                    }
                }
                Fetched(a.await(), p.await(), c.await(), t.await(), l.await())
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (myRun != currentRun) return
            // Downloads cut short by the failure never finished: back to WAITING.
            _status.update { s ->
                s.copy(
                    phase = SyncPhase.ERROR, error = codeOf(e),
                    parts = s.parts.map { if (it.state == PartState.RUNNING) it.copy(state = PartState.WAITING) else it },
                )
            }
            return
        }
        if (myRun != currentRun) return
        val syncedAt = Instant.ofEpochMilli(clock()).toString()
        var moveChanged = false
        try {
            db.withTransaction {
                moveChanged = readMeta(db)?.initiativeId != initiativeId
                db.assets().deleteAll(); db.assets().insertAll(fetched.assets.rows)
                db.people().deleteAll(); db.people().insertAll(fetched.people.people.map { it.toEntity() })
                db.containers().deleteAll(); db.containers().insertAll(fetched.containers.containers.map { it.toEntity() })
                db.trucks().deleteAll(); db.trucks().insertAll(fetched.trucks.trucks.map { it.toEntity() })
                db.meta().put(MetaEntity(LABEL_CONTEXT_META_KEY, fetched.assets.labelContext))
                if (fetched.templates != null) {
                    db.labelTemplates().deleteAll(); db.labelTemplates().insertAll(fetched.templates)
                } else if (moveChanged) {
                    // Another move's templates must never pick labels for this one.
                    db.labelTemplates().deleteAll()
                }
                val meta = SyncMeta(
                    initiativeId, initiativeName, fetched.assets.rows.size, fetched.people.people.size,
                    fetched.containers.containers.size, fetched.trucks.trucks.size, syncedAt,
                )
                db.meta().put(MetaEntity(MOVE_META_KEY, KioskJson.encodeToString(SyncMeta.serializer(), meta)))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (myRun != currentRun) return
            _status.update { s ->
                s.copy(
                    phase = SyncPhase.ERROR, error = "storage",
                    parts = s.parts.map { if (it.state == PartState.RUNNING) it.copy(state = PartState.FAILED) else it },
                )
            }
            return
        }
        if (myRun != currentRun) return
        hydrated = true
        // The move is stored; whatever happens from here must still end the sync in a terminal
        // phase. A sync left RUNNING makes Print Labels refuse until the app restarts.
        try {
            val assets = db.assets().count(); val people = db.people().count()
            val containers = db.containers().count(); val trucks = db.trucks().count()
            setPart(myRun, "assets", PartState.DONE, assets)
            setPart(myRun, "people", PartState.DONE, people)
            setPart(myRun, "containers", PartState.DONE, containers)
            setPart(myRun, "trucks", PartState.DONE, trucks)
            if (fetched.templates != null) setPart(myRun, "templates", PartState.DONE, db.labelTemplates().count())

            val fontsError = syncFonts(myRun, initiativeId, moveChanged)
            if (myRun != currentRun) return
            _status.update { s ->
                s.copy(
                    phase = SyncPhase.DONE, assets = assets, people = people, containers = containers, trucks = trucks,
                    syncedAt = syncedAt, error = null, labelsError = templatesError ?: fontsError,
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (myRun != currentRun) return
            _status.update { s ->
                s.copy(
                    phase = SyncPhase.ERROR, error = "storage",
                    parts = s.parts.map { if (it.state == PartState.RUNNING) it.copy(state = PartState.FAILED) else it },
                )
            }
        }
    }

    /** The fonts part: list, download what is missing, then swap the rows and drop unused files.
     *  Returns the failure code, or null. A failure leaves the previous rows and files in place
     *  for the same move; on a move change it clears them (they belonged to the other move). */
    private suspend fun syncFonts(myRun: Int, initiativeId: String, moveChanged: Boolean): String? {
        setPart(myRun, "fonts", PartState.RUNNING)
        return try {
            val listed = api.labelFonts(initiativeId)
            val rows = listed.fonts.map { f ->
                val resident = isResidentFont(f.name, f.resident)
                if (resident || fontsDir == null) return@map LabelFontEntity(f.id, f.name, f.size, resident, null)
                // The id names the file: only plain UUID-like ids, never a path.
                if (!SAFE_FONT_ID.matches(f.id)) throw IllegalStateException("bad font id")
                val fileName = "${f.id}.ttf"
                val file = File(fontsDir, fileName)
                if (!(file.isFile && file.length() == f.size.toLong())) {
                    val bytes = try {
                        api.labelFontContent(f.id, initiativeId)
                    } catch (e: ApiError) {
                        // The server's own resident rule (flag or object name) refused it: built in.
                        if (e.status == 403 && e.code == "font_not_servable") return@map LabelFontEntity(f.id, f.name, f.size, true, null)
                        throw e
                    }
                    writeAtomically(file, bytes)
                }
                LabelFontEntity(f.id, f.name, f.size, false, fileName)
            }
            if (myRun != currentRun) return null
            db.withTransaction { db.labelFonts().deleteAll(); db.labelFonts().insertAll(rows) }
            fontsDir?.let { dir -> deleteUnused(dir, rows.mapNotNull { it.fileName }.toSet()) }
            setPart(myRun, "fonts", PartState.DONE, rows.size)
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (moveChanged && myRun == currentRun) {
                // Best effort: a cleanup that throws too must not hide the original failure.
                try {
                    db.labelFonts().deleteAll()
                    fontsDir?.let { deleteUnused(it, emptySet()) }
                } catch (c: CancellationException) {
                    throw c
                } catch (_: Exception) {
                }
            }
            setPart(myRun, "fonts", PartState.FAILED)
            codeOf(e)
        }
    }

    /** "Clear local data": the move tables, label data and the meta rows — never the outbox. */
    suspend fun clearLocalData() {
        db.withTransaction {
            db.assets().deleteAll(); db.people().deleteAll(); db.containers().deleteAll(); db.trucks().deleteAll()
            db.labelTemplates().deleteAll(); db.labelFonts().deleteAll(); db.generatedLabels().deleteAll()
            db.meta().delete(MOVE_META_KEY); db.meta().delete(LABEL_CONTEXT_META_KEY)
        }
        fontsDir?.let { deleteUnused(it, emptySet()) }
        hydrated = false
        _status.value = SyncStatus()
    }

    /** Runs one download with its part RUNNING; a failure marks it FAILED and rethrows. */
    private suspend fun <T> part(myRun: Int, name: String, block: suspend () -> T): T {
        setPart(myRun, name, PartState.RUNNING)
        return try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            setPart(myRun, name, PartState.FAILED)
            throw e
        }
    }

    private fun setPart(myRun: Int, name: String, state: PartState, count: Int? = null) {
        if (myRun != currentRun) return
        _status.update { s -> s.copy(parts = s.parts.map { if (it.name == name) SyncPart(name, state, count) else it }) }
    }

    private class ParsedAssets(val rows: List<AssetEntity>, val labelContext: String)

    private class Fetched(
        val assets: ParsedAssets,
        val people: KioskPeopleSync,
        val containers: KioskContainersSync,
        val trucks: KioskTrucksSync,
        /** Null when the templates download failed: the stored ones stay. */
        val templates: List<LabelTemplateEntity>?,
    )

    companion object {
        private val SAFE_FONT_ID = Regex("^[A-Za-z0-9-]{1,64}$")

        suspend fun readMeta(db: KioskDatabase): SyncMeta? = db.meta().get(MOVE_META_KEY)?.let {
            try { KioskJson.decodeFromString(SyncMeta.serializer(), it.value) } catch (e: Exception) { null }
        }

        /** "2:14 PM" — the time alone; the kiosk syncs per shift. */
        fun formatSyncedAt(iso: String): String = try {
            DateTimeFormatter.ofPattern("h:mm a").format(Instant.parse(iso).atZone(ZoneId.systemDefault()))
        } catch (e: Exception) { iso }

        private fun codeOf(e: Exception) = if (e is ApiError) e.code else "unknown_error"

        /**
         * One parse of the /kiosk/sync/assets body: the typed rows as before, plus each asset's
         * JSON object text. kotlinx keeps a number's literal text (`12.0`, `1e-05`) in its
         * JsonPrimitive, so re-serializing an element gives back what the server sent.
         */
        private fun parseAssets(raw: String): ParsedAssets {
            val body = KioskJson.parseToJsonElement(raw).jsonObject
            val typed = KioskJson.decodeFromJsonElement(KioskAssetsSync.serializer(), body)
            val elements = body["assets"] as? JsonArray ?: JsonArray(emptyList())
            val rows = typed.assets.zip(elements) { row, el -> row.toEntity(el.toString()) }
            return ParsedAssets(rows, body["label_context"]?.toString() ?: "null")
        }

        /** Each template's JSON object text, keyed by its id, in the server's order. */
        private fun parseTemplates(raw: String): List<LabelTemplateEntity> {
            val body = KioskJson.parseToJsonElement(raw).jsonObject
            val list = body["templates"] as? JsonArray ?: JsonArray(emptyList())
            return list.mapNotNull { el ->
                val id = ((el as? JsonObject)?.get("id") as? JsonPrimitive)?.takeIf { it.isString }?.content
                id?.let { LabelTemplateEntity(it, el.toString()) }
            }
        }

        private suspend fun writeAtomically(file: File, bytes: ByteArray) = withContext(Dispatchers.IO) {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".part")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(file)) { tmp.delete(); throw IllegalStateException("font write failed") }
        }

        private suspend fun deleteUnused(dir: File, keep: Set<String>) = withContext(Dispatchers.IO) {
            dir.listFiles()?.forEach { if (it.name !in keep) it.delete() }
        }
    }
}
