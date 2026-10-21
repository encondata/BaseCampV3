package com.serversherpa.kiosk.data.labels

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.labels.LabelBuildNeed
import com.serversherpa.kiosk.core.labels.LabelBuildPhase
import com.serversherpa.kiosk.core.labels.LabelBuildStatus
import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.NO_TEMPLATE_AT_DPI
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.db.AssetEntity
import com.serversherpa.kiosk.data.db.GeneratedLabelEntity
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.LABEL_CONTEXT_META_KEY
import com.serversherpa.kiosk.data.db.LabelTemplateEntity
import com.serversherpa.kiosk.data.db.MOVE_META_KEY
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.sync.SyncMeta
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.data.sync.SyncStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A generator stand-in that reads the same JSON args the bundle does: one job per asset of
 * the assets body, a fingerprint of the asset's text, the templates, kind and DPI, and a
 * label naming them. An asset whose payload has `"outcome"` gets that outcome and no ZPL.
 */
class FakeLabelEngine : LabelEngine {
    var supported = true
    val calls = ArrayList<Pair<String, JsonObject>>()
    /** Throws from the n-th renderLabels call (1-based). */
    var failRender: Int? = null
    /** Replaces buildPlan's answer. */
    var planAnswer: (() -> String)? = null
    var renderAnswer: (() -> String)? = null
    var onRender: () -> Unit = {}
    var unsupportedOnCall = false
    var renders = 0
        private set

    override fun isSupported(): Boolean = supported

    override suspend fun call(fn: String, argsJson: String): String {
        if (unsupportedOnCall) throw LabelEngineUnsupportedException()
        val args = KioskJson.parseToJsonElement(argsJson).jsonObject
        calls += fn to args
        val body = KioskJson.parseToJsonElement(args["assetsJson"]!!.jsonPrimitive.content).jsonObject
        val templates = args["templatesJson"]!!.jsonPrimitive.content
        val kind = args["kind"]!!.jsonPrimitive.content
        val dpi = args["dpi"]!!.jsonPrimitive.int
        val hasData = body["label_context"] is JsonObject && body["assets"] is JsonArray
        val rows = if (hasData) body["assets"]!!.jsonArray.map { it.jsonObject } else emptyList()
        fun id(row: JsonObject) = row["id"]!!.jsonPrimitive.content
        fun fp(row: JsonObject) = "${row.toString().hashCode()}:${templates.hashCode()}:$kind:$dpi"
        return when (fn) {
            "buildPlan" -> planAnswer?.invoke() ?: buildJsonObject {
                put("templateId", "t1"); put("templateFamily", "vegas")
                put("notes", buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive("a pick note")) })
                put("fonts", buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive("ROBOTO.TTF")) })
                put("availableDpis", JsonArray(emptyList()))
                put("hasAssetData", hasData)
                put("jobs", JsonArray(rows.map { r -> buildJsonObject { put("assetId", id(r)); put("fingerprint", fp(r)) } }))
            }.toString()
            "renderLabels" -> {
                renders++
                onRender()
                if (renders == failRender) throw IllegalStateException("isolate died")
                renderAnswer?.let { return it() }
                val ids = args["assetIds"]!!.jsonArray.map { it.jsonPrimitive.content }
                val byId = rows.associateBy(::id)
                buildJsonObject {
                    put("results", JsonArray(ids.mapNotNull { byId[it] }.map { r ->
                        val outcome = r["outcome"]?.jsonPrimitive?.content
                        buildJsonObject {
                            put("assetId", id(r))
                            put("zpl", if (outcome == null) "^XA^FD${id(r)} $kind $dpi^FS^XZ" else null)
                            put("outcome", outcome ?: "ok")
                            put("fingerprint", fp(r))
                        }
                    }))
                }.toString()
            }
            else -> error("unexpected $fn")
        }
    }

    fun count(fn: String) = calls.count { it.first == fn }
    fun renderedIds() = calls.filter { it.first == "renderLabels" }.flatMap { c -> c.second["assetIds"]!!.jsonArray.map { it.jsonPrimitive.content } }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LabelBuilderTest {
    private lateinit var db: KioskDatabase
    private val engine = FakeLabelEngine()
    private val printer = SavedPrinter("10.0.0.5", "ZD421", "XYZ1", 203)
    private val settings = MutableStateFlow(LabelSettings(LabelKind.TOP, printer))
    private val source = object : LabelSettingsSource { override val settings = this@LabelBuilderTest.settings }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val context = """{"move_name":"Move A","catalog_keys":["RU"]}"""

    @Before fun setUp() { db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext()) }
    @After fun tearDown() { scope.cancel(); db.close() }

    private fun builder(batch: Int = 2) = LabelBuilder(db, engine, source, scope, batchSize = batch)

    private fun payload(id: String, extra: String = "") = """{"id":"$id","asset_id":"A-$id","raw_ft":{"RU":12.0}$extra}"""

    private fun asset(id: String, payload: String = payload(id)) =
        AssetEntity(id, "A-$id", null, null, null, null, null, "", null, "{}", payload)

    private suspend fun seed(ids: List<String>, context: String? = this.context, payloads: Map<String, String> = emptyMap()) {
        db.assets().deleteAll()
        db.assets().insertAll(ids.map { asset(it, payloads[it] ?: payload(it)) })
        val meta = SyncMeta("i1", "Move A", ids.size, 0, 0, 0, "2026-10-21T00:00:00Z")
        db.meta().put(MetaEntity(MOVE_META_KEY, KioskJson.encodeToString(SyncMeta.serializer(), meta)))
        if (context != null) db.meta().put(MetaEntity(LABEL_CONTEXT_META_KEY, context)) else db.meta().delete(LABEL_CONTEXT_META_KEY)
        db.labelTemplates().deleteAll()
        db.labelTemplates().insertAll(listOf(LabelTemplateEntity("t1", """{"id":"t1","design":{"schema":2.0}}"""), LabelTemplateEntity("t0", """{"id":"t0"}""")))
    }

    private suspend fun stored() = db.generatedLabels().all().associateBy { it.assetId }

    @Test fun firstBuildRendersAllInBatchesStoresThemAndReportsProgress() = runBlocking<Unit> {
        seed(listOf("a1", "a2", "a3", "a4", "a5"), payloads = mapOf("a4" to payload("a4", ""","outcome":"no_template_at_dpi"""")))
        val b = builder(batch = 2)
        val seen = ArrayList<LabelBuildStatus>()
        engine.onRender = { seen += b.status.value }

        b.buildNow("sync")

        assertEquals(listOf("buildPlan", "renderLabels", "renderLabels", "renderLabels"), engine.calls.map { it.first })
        // Progress as each batch starts, then complete.
        assertEquals(listOf(0, 2, 4), seen.map { it.done })
        assertTrue(seen.all { it.phase == LabelBuildPhase.RUNNING && it.total == 5 })
        val s = b.status.value
        assertEquals(LabelBuildPhase.DONE, s.phase)
        assertEquals(5, s.done); assertEquals(5, s.total)
        assertEquals(4, s.ready)
        assertEquals(mapOf(NO_TEMPLATE_AT_DPI to 1), s.problems)
        assertEquals(listOf("a pick note"), s.notes)
        assertEquals("t1", s.templateId)
        assertEquals(listOf("ROBOTO.TTF"), s.fonts)
        assertNull(s.needs)

        val rows = stored()
        assertEquals(setOf("a1", "a2", "a3", "a4", "a5"), rows.keys)
        assertEquals("^XA^FDa1 top 203^FS^XZ", rows["a1"]!!.zpl)
        assertEquals("ok", rows["a1"]!!.outcome)
        assertEquals("t1", rows["a1"]!!.templateId)
        assertNull(rows["a4"]!!.zpl)
        assertEquals(NO_TEMPLATE_AT_DPI, rows["a4"]!!.outcome)
        // Stored fingerprints are the plan's.
        val plan = engine.calls.first().second
        assertEquals("top", plan["kind"]!!.jsonPrimitive.content)
        assertEquals(203, plan["dpi"]!!.jsonPrimitive.int)
    }

    @Test fun theBodiesAreRebuiltFromStoredRowsAndEachBatchCarriesOnlyItsAssets() = runBlocking<Unit> {
        seed(listOf("a1", "a2", "a3"))
        builder(batch = 2).buildNow("sync")

        val (_, planArgs) = engine.calls[0]
        assertEquals(
            """{"initiative_id":"i1","assets":[${payload("a1")},${payload("a2")},${payload("a3")}],"label_context":$context}""",
            planArgs["assetsJson"]!!.jsonPrimitive.content,
        )
        assertEquals(
            """{"templates":[{"id":"t1","design":{"schema":2.0}},{"id":"t0"}]}""",
            planArgs["templatesJson"]!!.jsonPrimitive.content,
        )
        val (_, second) = engine.calls[2]
        assertEquals(listOf("a3"), second["assetIds"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(
            """{"initiative_id":"i1","assets":[${payload("a3")}],"label_context":$context}""",
            second["assetsJson"]!!.jsonPrimitive.content,
        )
    }

    @Test fun anUnchangedSecondBuildRendersNothing() = runBlocking<Unit> {
        seed(listOf("a1", "a2", "a3"))
        val b = builder()
        b.buildNow("sync")
        engine.calls.clear()

        b.buildNow("sync")

        assertEquals(listOf("buildPlan"), engine.calls.map { it.first })
        val s = b.status.value
        assertEquals(LabelBuildPhase.DONE, s.phase)
        assertEquals(0, s.total); assertEquals(0, s.done)
        assertEquals(3, s.ready)
    }

    @Test fun onlyChangedAssetsRenderAndGoneAssetsArePruned() = runBlocking<Unit> {
        seed(listOf("a1", "a2", "a3"))
        val b = builder()
        b.buildNow("sync")
        engine.calls.clear()

        seed(listOf("a1", "a2", "a4"), payloads = mapOf("a2" to payload("a2", ""","name":"renamed"""")))
        b.buildNow("sync")

        assertEquals(listOf("a2", "a4"), engine.renderedIds())
        assertEquals(setOf("a1", "a2", "a4"), stored().keys)
        assertEquals(2, b.status.value.total)
        assertEquals(3, b.status.value.ready)
    }

    @Test fun aKindChangeRendersEverythingAgain() = runBlocking<Unit> {
        seed(listOf("a1", "a2", "a3"))
        val b = builder()
        b.buildNow("sync")
        engine.calls.clear()

        settings.value = settings.value.copy(kind = LabelKind.FRONT)
        b.buildNow("setup")

        assertEquals(listOf("a1", "a2", "a3"), engine.renderedIds())
        assertEquals("^XA^FDa1 front 203^FS^XZ", stored()["a1"]!!.zpl)
        assertEquals(3, b.status.value.total)
    }

    @Test fun aDpiChangeRendersEverythingAgain() = runBlocking<Unit> {
        seed(listOf("a1", "a2"))
        val b = builder()
        b.buildNow("sync")
        engine.calls.clear()

        settings.value = settings.value.copy(printer = printer.copy(dpi = 300))
        b.buildNow("printer")

        assertEquals(listOf("a1", "a2"), engine.renderedIds())
        assertEquals("^XA^FDa1 top 300^FS^XZ", stored()["a1"]!!.zpl)
    }

    @Test fun noPrinterSavedIsDoneWithNothingToBuildAndSaysAPrinterIsNeeded() = runBlocking<Unit> {
        seed(listOf("a1", "a2"))
        db.generatedLabels().upsert(listOf(GeneratedLabelEntity("a1", "^XA^XZ", "ok", "old", "t1")))
        settings.value = LabelSettings(LabelKind.TOP, printer = null)
        val b = builder()

        b.buildNow("sync")

        val s = b.status.value
        assertEquals(LabelBuildPhase.DONE, s.phase)
        assertEquals(0, s.total)
        assertEquals(LabelBuildNeed.PRINTER, s.needs)
        assertTrue(engine.calls.isEmpty())
        assertEquals(setOf("a1"), stored().keys)
    }

    @Test fun unsupportedDevice() = runBlocking<Unit> {
        seed(listOf("a1"))
        engine.supported = false
        val b = builder()
        b.buildNow("start")
        assertEquals(LabelBuildPhase.UNSUPPORTED_DEVICE, b.status.value.phase)
        assertTrue(engine.calls.isEmpty())

        // The engine may also find out only when it connects.
        engine.supported = true
        engine.unsupportedOnCall = true
        b.buildNow("start")
        assertEquals(LabelBuildPhase.UNSUPPORTED_DEVICE, b.status.value.phase)
    }

    @Test fun aBatchThrowingIsAnErrorAndKeepsEarlierLabels() = runBlocking<Unit> {
        seed(listOf("a0"))
        val b = builder(batch = 2)
        b.buildNow("sync")
        engine.calls.clear()

        seed(listOf("a1", "a2", "a3", "a4", "a5"))
        engine.failRender = engine.renders + 2
        b.buildNow("sync")

        val s = b.status.value
        assertEquals(LabelBuildPhase.ERROR, s.phase)
        assertEquals(2, s.done); assertEquals(5, s.total); assertEquals(2, s.ready)
        assertEquals("isolate died", s.error)
        // The first batch's labels are stored; nothing was pruned (a0 left the move but stays until a good build).
        assertEquals(setOf("a0", "a1", "a2"), stored().keys)
    }

    @Test fun aPlanErrorIsAnErrorAndKeepsStoredLabels() = runBlocking<Unit> {
        seed(listOf("a1"))
        db.generatedLabels().upsert(listOf(GeneratedLabelEntity("gone", "^XA^XZ", "ok", "old", "t1")))
        engine.planAnswer = { """{"error":"bad printer DPI: 0"}""" }
        val b = builder()

        b.buildNow("sync")

        assertEquals(LabelBuildPhase.ERROR, b.status.value.phase)
        assertEquals("bad printer DPI: 0", b.status.value.error)
        assertEquals(setOf("gone"), stored().keys)
        assertEquals(0, engine.count("renderLabels"))
    }

    @Test fun aRenderErrorAnswerIsAnError() = runBlocking<Unit> {
        seed(listOf("a1"))
        engine.renderAnswer = { """{"error":"assetIds must be a list of strings"}""" }
        val b = builder()
        b.buildNow("sync")
        assertEquals(LabelBuildPhase.ERROR, b.status.value.phase)
        assertTrue(stored().isEmpty())
    }

    @Test fun withoutAssetDataNothingIsPrunedAndASyncIsNeeded() = runBlocking<Unit> {
        // Right after the version 2 upgrade: payloads are {} and there is no label_context row.
        seed(listOf("a1", "a2"), context = null, payloads = mapOf("a1" to "{}", "a2" to "{}"))
        db.generatedLabels().upsert(listOf(GeneratedLabelEntity("a1", "^XA^XZ", "ok", "old", "t1")))
        val b = builder()

        b.buildNow("start")

        assertEquals(LabelBuildPhase.DONE, b.status.value.phase)
        assertEquals(LabelBuildNeed.SYNC, b.status.value.needs)
        assertEquals(setOf("a1"), stored().keys)
        assertEquals(0, engine.count("renderLabels"))

        // A context the server sent as null: the plan says it has no asset data.
        seed(listOf("a1", "a2"), context = "null")
        b.buildNow("sync")
        assertEquals(1, engine.count("buildPlan"))
        assertEquals(LabelBuildPhase.DONE, b.status.value.phase)
        assertEquals(LabelBuildNeed.SYNC, b.status.value.needs)
        assertEquals(setOf("a1"), stored().keys)
        assertEquals(0, engine.count("renderLabels"))
    }

    @Test fun neverSyncedNeedsASync() = runBlocking<Unit> {
        val b = builder()
        b.buildNow("start")
        assertEquals(LabelBuildPhase.DONE, b.status.value.phase)
        assertEquals(LabelBuildNeed.SYNC, b.status.value.needs)
        assertTrue(engine.calls.isEmpty())
    }

    @Test fun aFinishedSyncTriggersABuildAndClearingResetsTheStatus() = runBlocking<Unit> {
        seed(listOf("a1", "a2"))
        val b = builder()
        val sync = MutableStateFlow(SyncStatus(phase = SyncPhase.RUNNING))
        b.start(sync)

        sync.value = SyncStatus(phase = SyncPhase.DONE)
        withTimeout(5_000) { b.status.first { it.phase == LabelBuildPhase.DONE } }
        assertEquals(2, b.status.value.ready)
        assertEquals(setOf("a1", "a2"), stored().keys)

        // "Clear local data" puts the sync back to IDLE.
        sync.value = SyncStatus()
        withTimeout(5_000) { b.status.first { it.phase == LabelBuildPhase.IDLE } }
    }

    @Test fun rebuildRunsInTheBackgroundAndALaterRequestWins() = runBlocking<Unit> {
        seed(listOf("a1", "a2", "a3"))
        val b = builder(batch = 1)
        b.rebuild("sync")
        settings.value = settings.value.copy(kind = LabelKind.FRONT)
        b.rebuild("setup")
        withTimeout(5_000) {
            while (true) {
                val s = b.status.value
                if (s.phase == LabelBuildPhase.DONE && stored().values.all { it.zpl!!.contains("front") } && stored().size == 3) break
                kotlinx.coroutines.delay(20)
            }
        }
    }
}
