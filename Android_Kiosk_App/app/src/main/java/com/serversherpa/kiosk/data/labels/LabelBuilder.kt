package com.serversherpa.kiosk.data.labels

import android.util.Log
import androidx.room.withTransaction
import com.serversherpa.kiosk.core.labels.LabelBuildNeed
import com.serversherpa.kiosk.core.labels.LabelBuildPhase
import com.serversherpa.kiosk.core.labels.LabelBuildStatus
import com.serversherpa.kiosk.core.labels.LabelGenArgs
import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.LabelPick
import com.serversherpa.kiosk.core.labels.LabelPlan
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.parsePlan
import com.serversherpa.kiosk.core.labels.parseRendered
import com.serversherpa.kiosk.core.labels.tallyOutcomes
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.db.GeneratedLabelEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.LABEL_CONTEXT_META_KEY
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.data.sync.SyncStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Where the label settings come from (the kind from Kiosk Setup, the printer from Printer Setup). */
interface LabelSettingsSource {
    val settings: Flow<LabelSettings>
}

/**
 * Builds and stores the move's labels on the device, as the laptop's label runner does
 * (kiosk_laptop/edge/src/edge/labels/runner.py): plan every asset with the generator, render
 * only those whose fingerprint differs from the stored label, store each batch as it finishes,
 * then drop the labels of assets no longer on the move. A label stays printable until its new
 * version is stored, and a failed build keeps everything stored so far.
 *
 * `buildPlan` reads the whole move once. Each `renderLabels` call gets an assets body holding
 * only its batch: a label depends on its own asset, the move's `label_context` and the
 * templates, never on another asset, and the generator re-reads the bodies on every call, so a
 * full body per batch would make a large move quadratic.
 *
 * One build at a time: a new request cancels the build in progress (and any request still
 * waiting) before it starts. A build never writes into a move that changed or was cleared
 * while it ran: each write checks the move first, in the same transaction.
 */
class LabelBuilder(
    private val db: KioskDatabase,
    private val engine: LabelEngine,
    private val settingsSource: LabelSettingsSource,
    private val scope: CoroutineScope,
    private val batchSize: Int = BATCH_SIZE,
) {
    private val _status = MutableStateFlow(LabelBuildStatus())
    val status: StateFlow<LabelBuildStatus> = _status
    private val _pick = MutableStateFlow<LabelPick?>(null)
    /** The latest build's template pick (null before the first build with a printer, and after a
     *  stop); read-only, for Printer Setup. */
    val pick: StateFlow<LabelPick?> = _pick
    private val lock = Mutex()
    private var job: Job? = null

    /** Builds in the background. [start] calls it after a sync and a kind or printer DPI change. */
    fun rebuild(reason: String) = replace { buildNow(reason) }

    /** Stops any build and resets the status ("Clear local data" emptied the labels). */
    fun stop() = replace { lock.withLock { _pick.value = null; _status.value = LabelBuildStatus() } }

    /** Cancels the running or waiting request at once, then runs [block] after it has finished. */
    private fun replace(block: suspend () -> Unit) {
        synchronized(this) {
            val previous = job
            previous?.cancel()
            job = scope.launch {
                previous?.join()
                block()
            }
        }
    }

    /**
     * Follows the sync and the settings: each finished sync (and the relaunch's restored one)
     * builds; a cleared sync (IDLE) stops; a change of label kind or printer DPI builds again.
     */
    fun start(syncStatus: Flow<SyncStatus>): Job = scope.launch {
        launch {
            syncStatus.map { it.phase }.distinctUntilChanged().collect { phase ->
                when (phase) {
                    SyncPhase.DONE -> rebuild("sync")
                    SyncPhase.IDLE -> stop()
                    else -> Unit
                }
            }
        }
        launch {
            settingsSource.settings.map { it.kind to it.printer?.dpi }.distinctUntilChanged().drop(1).collect {
                rebuild("settings")
            }
        }
    }

    suspend fun buildNow(reason: String) = lock.withLock {
        Log.i(TAG, "label build ($reason)")
        _status.value = LabelBuildStatus(LabelBuildPhase.RUNNING)
        try {
            build()
        } catch (e: CancellationException) {
            throw e
        } catch (e: MoveChanged) {
            // The labels belong to a move that is gone; the sync that changed it starts over.
            Log.i(TAG, "label build stopped: the move changed or was cleared")
            _status.value = LabelBuildStatus()
        } catch (e: LabelEngineUnsupportedException) {
            _status.value = LabelBuildStatus(LabelBuildPhase.UNSUPPORTED_DEVICE)
        } catch (e: Exception) {
            Log.w(TAG, "label build failed", e)
            _status.update { it.copy(phase = LabelBuildPhase.ERROR, error = e.message ?: e.javaClass.simpleName) }
        }
    }

    private suspend fun build() {
        if (!engine.isSupported()) {
            _status.value = LabelBuildStatus(LabelBuildPhase.UNSUPPORTED_DEVICE)
            return
        }
        val settings = settingsSource.settings.first()
        val printer = settings.printer
        val meta = Sync.readMeta(db)
        val labelContext = db.meta().get(LABEL_CONTEXT_META_KEY)?.value
        if (meta == null || labelContext == null) {
            // Never synced, or not since the version 2 upgrade: keep whatever is stored.
            _pick.value = printer?.let { LabelPick(settings.kind, it.dpi, synced = false) }
            _status.value = LabelBuildStatus(LabelBuildPhase.DONE, needs = LabelBuildNeed.SYNC)
            return
        }
        if (printer == null) {
            _status.value = LabelBuildStatus(LabelBuildPhase.DONE, needs = LabelBuildNeed.PRINTER)
            return
        }
        val kind = settings.kind
        val dpi = printer.dpi

        val payloads = db.assets().payloads()
        val templates = db.labelTemplates().all()
        val templatesJson = LabelGenArgs.templatesBody(templates.map { it.json })
        val fullBody = LabelGenArgs.assetsBody(meta.initiativeId, payloads.map { it.payloadJson }, labelContext)
        val plan = try {
            parsePlan(engine.call("buildPlan", LabelGenArgs.plan(fullBody, templatesJson, kind, dpi)))
        } catch (e: CancellationException) {
            throw e
        } catch (e: LabelEngineUnsupportedException) {
            throw e
        } catch (e: Exception) {
            // Printer Setup's checks stop waiting for this kind and DPI's pick.
            _pick.value = LabelPick(kind, dpi, synced = true, failed = true)
            throw e
        }
        _pick.value = pickOf(kind, dpi, plan.templateId?.let { id -> templates.firstOrNull { it.id == id }?.json }, plan)
        val planned = LabelBuildStatus(
            LabelBuildPhase.RUNNING, notes = plan.notes, templateId = plan.templateId, fonts = plan.fonts,
            availableDpis = plan.availableDpis,
        )
        if (!plan.hasAssetData) {
            // Jobs are empty for want of data, not because the move is empty: prune nothing.
            _status.value = planned.copy(phase = LabelBuildPhase.DONE, needs = LabelBuildNeed.SYNC)
            return
        }

        // One job per asset; a repeated id keeps its last row, as the store does.
        val jobs = LinkedHashMap<String, String>()
        plan.jobs.forEach { jobs[it.assetId] = it.fingerprint }
        val stored = db.generatedLabels().states().associateBy { it.assetId }
        val changed = jobs.filter { (id, fp) -> stored[id]?.fingerprint != fp }.keys.toList()
        // The current outcome of every asset whose label is up to date.
        val outcomes = HashMap<String, String>()
        jobs.forEach { (id, fp) -> stored[id]?.takeIf { it.fingerprint == fp }?.let { outcomes[id] = it.outcome } }

        fun progress(done: Int) = tallyOutcomes(outcomes.values).let { t ->
            planned.copy(done = done, total = changed.size, ready = t.ready, problems = t.problems)
        }
        _status.value = progress(0)

        val payloadById = payloads.associate { it.id to it.payloadJson }
        val perCall = minOf(batchSize, engine.maxBatch()).coerceAtLeast(1)
        var done = 0
        var missing = 0
        var mismatched = 0
        for (batch in changed.chunked(perCall)) {
            currentCoroutineContext().ensureActive()
            val body = LabelGenArgs.assetsBody(meta.initiativeId, batch.mapNotNull { payloadById[it] }, labelContext)
            val results = parseRendered(engine.call("renderLabels", LabelGenArgs.render(body, templatesJson, kind, dpi, batch)))
            val returned = results.mapTo(HashSet()) { it.assetId }
            missing += batch.count { it !in returned }
            mismatched += results.count { jobs[it.assetId] != it.fingerprint }
            inSameMove(meta.initiativeId) {
                db.generatedLabels().upsert(results.map { GeneratedLabelEntity(it.assetId, it.zpl, it.outcome, it.fingerprint, plan.templateId) })
            }
            results.forEach { outcomes[it.assetId] = it.outcome }
            done += batch.size
            _status.value = progress(done)
        }
        if (missing > 0 || mismatched > 0) {
            // Never expected: a missing label renders again next build; a fingerprint unlike the
            // plan's means the batch body changed what the generator saw (renders every build).
            Log.w(TAG, "label build: $missing labels missing from their batch, $mismatched with a fingerprint unlike the plan's")
        }

        val gone = stored.keys.filter { it !in jobs }
        inSameMove(meta.initiativeId) { gone.chunked(DELETE_CHUNK).forEach { db.generatedLabels().delete(it) } }
        _status.value = progress(done).copy(phase = LabelBuildPhase.DONE)
    }

    /** Runs [write] only while the stored move is still [initiativeId] (not changed, not cleared). */
    private suspend fun inSameMove(initiativeId: String, write: suspend () -> Unit) {
        db.withTransaction {
            if (Sync.readMeta(db)?.initiativeId != initiativeId) throw MoveChanged()
            write()
        }
    }

    private class MoveChanged : Exception()

    /** The pick with the picked template's name and size read off its synced JSON. */
    private fun pickOf(kind: LabelKind, dpi: Int, templateJson: String?, plan: LabelPlan): LabelPick {
        val t = templateJson?.let { runCatching { KioskJson.parseToJsonElement(it).jsonObject }.getOrNull() }
        fun num(key: String) = (t?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it > 0 }
        return LabelPick(
            kind, dpi, synced = true, templateId = plan.templateId,
            templateName = (t?.get("name") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull,
            notes = plan.notes, fonts = plan.fonts, availableDpis = plan.availableDpis,
            widthIn = num("width_in"), heightIn = num("height_in"),
        )
    }

    companion object {
        private const val TAG = "LabelBuilder"

        /**
         * Assets per `renderLabels` call (the engine may ask for fewer). Each call carries its
         * batch's payloads and the templates, and returns the batch's ZPL: 200 assets is about
         * 0.4 MB each way and about 60 ms of generator work on a laptop, so the progress bar
         * moves and a print waits little behind a batch.
         */
        const val BATCH_SIZE = 200

        /** Under SQLite's 999 bound parameters on older Android. */
        private const val DELETE_CHUNK = 500
    }
}
