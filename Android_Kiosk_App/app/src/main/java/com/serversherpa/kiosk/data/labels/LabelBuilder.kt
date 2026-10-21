package com.serversherpa.kiosk.data.labels

import android.util.Log
import com.serversherpa.kiosk.core.labels.LabelBuildNeed
import com.serversherpa.kiosk.core.labels.LabelBuildPhase
import com.serversherpa.kiosk.core.labels.LabelBuildStatus
import com.serversherpa.kiosk.core.labels.LabelGenArgs
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.parsePlan
import com.serversherpa.kiosk.core.labels.parseRendered
import com.serversherpa.kiosk.core.labels.tallyOutcomes
import com.serversherpa.kiosk.data.db.GeneratedLabelEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.LABEL_CONTEXT_META_KEY
import com.serversherpa.kiosk.data.sync.Sync
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.data.sync.SyncStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
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
 * Builds run one at a time; [rebuild] cancels a build in progress and starts over (what it
 * stored is current for its own inputs, so nothing is lost).
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
    private val lock = Mutex()
    private var job: Job? = null

    /** Builds in the background: after a sync, a Kiosk Setup save (kind) or a printer DPI change. */
    fun rebuild(reason: String) {
        synchronized(this) {
            val previous = job
            job = scope.launch {
                previous?.cancelAndJoin()
                buildNow(reason)
            }
        }
    }

    /** Follows the sync: each finished sync (and the relaunch's restored one) builds; a cleared
     *  sync (IDLE: "Clear local data" emptied the labels) stops any build and resets the status. */
    fun start(syncStatus: Flow<SyncStatus>): Job = scope.launch {
        syncStatus.map { it.phase }.distinctUntilChanged().collect { phase ->
            when (phase) {
                SyncPhase.DONE -> rebuild("sync")
                SyncPhase.IDLE -> stop()
                else -> Unit
            }
        }
    }

    private suspend fun stop() {
        val running = synchronized(this) { job.also { job = null } }
        running?.cancelAndJoin()
        _status.value = LabelBuildStatus()
    }

    suspend fun buildNow(reason: String) = lock.withLock {
        Log.i(TAG, "label build ($reason)")
        _status.value = LabelBuildStatus(LabelBuildPhase.RUNNING)
        try {
            build()
        } catch (e: CancellationException) {
            throw e
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
        val meta = Sync.readMeta(db)
        val labelContext = db.meta().get(LABEL_CONTEXT_META_KEY)?.value
        if (meta == null || labelContext == null) {
            // Never synced, or not since the version 2 upgrade: keep whatever is stored.
            _status.value = LabelBuildStatus(LabelBuildPhase.DONE, needs = LabelBuildNeed.SYNC)
            return
        }
        val settings = settingsSource.settings.first()
        val printer = settings.printer
        if (printer == null) {
            _status.value = LabelBuildStatus(LabelBuildPhase.DONE, needs = LabelBuildNeed.PRINTER)
            return
        }
        val kind = settings.kind
        val dpi = printer.dpi

        val payloads = db.assets().payloads()
        val templatesJson = LabelGenArgs.templatesBody(db.labelTemplates().all().map { it.json })
        val fullBody = LabelGenArgs.assetsBody(meta.initiativeId, payloads.map { it.payloadJson }, labelContext)
        val plan = parsePlan(engine.call("buildPlan", LabelGenArgs.plan(fullBody, templatesJson, kind, dpi)))
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
        val stored = db.generatedLabels().all().associateBy { it.assetId }
        val changed = jobs.filter { (id, fp) -> stored[id]?.fingerprint != fp }.keys.toList()
        // The current outcome of every asset whose label is up to date.
        val outcomes = HashMap<String, String>()
        jobs.forEach { (id, fp) -> stored[id]?.takeIf { it.fingerprint == fp }?.let { outcomes[id] = it.outcome } }

        fun progress(done: Int) = tallyOutcomes(outcomes.values).let { t ->
            planned.copy(done = done, total = changed.size, ready = t.ready, problems = t.problems)
        }
        _status.value = progress(0)

        val payloadById = payloads.associate { it.id to it.payloadJson }
        var done = 0
        for (batch in changed.chunked(batchSize)) {
            currentCoroutineContext().ensureActive()
            val body = LabelGenArgs.assetsBody(meta.initiativeId, batch.mapNotNull { payloadById[it] }, labelContext)
            val results = parseRendered(engine.call("renderLabels", LabelGenArgs.render(body, templatesJson, kind, dpi, batch)))
            db.generatedLabels().upsert(results.map { GeneratedLabelEntity(it.assetId, it.zpl, it.outcome, it.fingerprint, plan.templateId) })
            results.forEach { outcomes[it.assetId] = it.outcome }
            done += batch.size
            _status.value = progress(done)
        }

        val gone = stored.keys.filter { it !in jobs }
        gone.chunked(DELETE_CHUNK).forEach { db.generatedLabels().delete(it) }
        _status.value = progress(done).copy(phase = LabelBuildPhase.DONE)
    }

    companion object {
        private const val TAG = "LabelBuilder"

        /**
         * Assets per `renderLabels` call. Each call carries its batch's payloads and the
         * templates, and returns the batch's ZPL: 200 assets is about 0.4 MB each way (under the
         * Binder limit without EVALUATE_WITHOUT_TRANSACTION_LIMIT) and about 60 ms of generator
         * work on a laptop, so the progress bar moves and a print waits little behind a batch.
         */
        const val BATCH_SIZE = 200

        /** Under SQLite's 999 bound parameters on older Android. */
        private const val DELETE_CHUNK = 500
    }
}
