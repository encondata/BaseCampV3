package com.serversherpa.kiosk.data.sync

import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.ApiError
import com.serversherpa.kiosk.core.model.KioskLabelFont
import com.serversherpa.kiosk.core.model.KioskLabelFonts
import com.serversherpa.kiosk.data.FakeKioskApi
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.LABEL_CONTEXT_META_KEY
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncLabelsTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var db: KioskDatabase
    private lateinit var fontsDir: File
    private val api = FakeKioskApi()

    @Before fun setUp() {
        db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        fontsDir = File(tmp.root, "label-fonts")
    }
    @After fun tearDown() { db.close() }

    private fun sync() = Sync(api, db, kotlinx.coroutines.GlobalScope, clock = { 1_700_000_000_000L }, fontsDir = fontsDir)

    // Number literals the generator must see exactly as the server sent them.
    private val asset1 = """{"id":"a1","asset_id":"A-1","name":"Café ^~_ 😀","make_model":"X","label":{"asset_id":"A-1"},""" +
        """"raw_ft":{"RU":12.0,"Qty":7,"Tiny":1e-05,"Flag":true,"None":null},"source_ru_raw":"14.50"}"""
    private val asset2 = """{"id":"a2","asset_id":"A-2","make_model":"Y","label":{},"raw_ft":{}}"""
    private val context = """{"move_name":"Move A","move_code":"MA","move_day":"2026-10-05T00:00:00Z","source_site":"Origin",""" +
        """"source_site_code":"OR","destination_site":"Dest","destination_site_code":"DE","catalog_keys":["RU"]}"""
    private fun assetsBody(vararg assets: String, ctx: String? = context) =
        """{"initiative_id":"i1","initiative_name":"Move A","generated_at":"now","assets":[${assets.joinToString(",")}]""" +
            (ctx?.let { ""","label_context":$it""" } ?: "") + "}"

    private val tplA = """{"id":"t1","name":"Top","family":"vegas","label_type":"top","size_key":"4x6","dpi_key":"300",""" +
        """"language_key":"zpl","version":3,"updated_at":"2026-10-01T00:00:00Z","kind":"design","design":{"schema":2.0,"lines":2.0}}"""
    private val tplB = """{"id":"t0","name":"Front","family":"generic","label_type":"front","size_key":"2x1","dpi_key":"203",""" +
        """"language_key":"zpl","version":1,"updated_at":"2026-09-01T00:00:00Z","kind":"code","code":"^XA^XZ","design":null}"""
    private fun templatesBody(vararg t: String) = """{"initiative_id":"i1","generated_at":"now","templates":[${t.joinToString(",")}]}"""

    private val fontBytes = byteArrayOf(1, 2, 3, 4)

    private fun SyncStatus.part(name: String) = parts.first { it.name == name }

    @Test fun storesRawPayloadsContextTemplatesAndFontsWithProgress() = runBlocking {
        val s = sync()
        assertEquals(listOf("assets", "people", "containers", "trucks", "templates", "fonts"), s.status.value.parts.map { it.name })
        assertTrue(s.status.value.parts.all { it.state == PartState.WAITING })
        val seen = ArrayList<SyncStatus>()
        api.assetsRaw = { seen += s.status.value; assetsBody(asset1, asset2) }
        api.templatesRaw = { seen += s.status.value; templatesBody(tplA, tplB) }
        api.fonts = {
            seen += s.status.value
            KioskLabelFonts(listOf(KioskLabelFont("f1", "ROBOTO.TTF", 4), KioskLabelFont("f2", "TT0003M_.TTF", 100, resident = true)), listOf("NOPE.TTF"))
        }
        api.fontContent = { id -> assertEquals("f1", id); fontBytes }

        s.runNow("i1", "Move A")

        // While the move tables download, each fetch is RUNNING and fonts still WAITING.
        assertEquals(PartState.RUNNING, seen[0].part("assets").state)
        assertEquals(PartState.WAITING, seen[0].part("fonts").state)
        assertEquals(PartState.RUNNING, seen[1].part("templates").state)
        // Fonts run after the move is stored.
        val atFonts = seen[2]
        assertEquals(PartState.RUNNING, atFonts.part("fonts").state)
        for (n in listOf("assets", "people", "containers", "trucks", "templates")) assertEquals(n, PartState.DONE, atFonts.part(n).state)

        val st = s.status.value
        assertEquals(SyncPhase.DONE, st.phase); assertNull(st.error); assertNull(st.labelsError)
        assertTrue(st.parts.all { it.state == PartState.DONE })
        assertEquals(mapOf("assets" to 2, "people" to 0, "containers" to 0, "trucks" to 0, "templates" to 2, "fonts" to 2),
            st.parts.associate { it.name to it.count })

        // Every asset's raw JSON text, byte for byte, beside the typed columns.
        val assets = db.assets().all().associateBy { it.id }
        assertEquals(asset1, assets.getValue("a1").payloadJson)
        assertEquals(asset2, assets.getValue("a2").payloadJson)
        assertTrue(assets.getValue("a1").payloadJson.contains(""""RU":12.0,"Qty":7,"Tiny":1e-05"""))
        assertEquals("A-1", assets.getValue("a1").label()["asset_id"])
        assertEquals("X", assets.getValue("a1").makeModel)
        assertEquals(context, db.meta().get(LABEL_CONTEXT_META_KEY)?.value)

        // Templates as received, in the server's order.
        val templates = db.labelTemplates().all()
        assertEquals(listOf("t1", "t0"), templates.map { it.id })
        assertEquals(listOf(tplA, tplB), templates.map { it.json })

        // Font metadata; only the non-resident font is downloaded, to a file.
        val fonts = db.labelFonts().all().associateBy { it.id }
        assertEquals("ROBOTO.TTF", fonts.getValue("f1").name); assertEquals(4, fonts.getValue("f1").size)
        assertEquals("f1.ttf", fonts.getValue("f1").fileName); assertFalse(fonts.getValue("f1").resident)
        assertTrue(fonts.getValue("f2").resident); assertNull(fonts.getValue("f2").fileName)
        assertArrayEquals(fontBytes, File(fontsDir, "f1.ttf").readBytes())
        assertEquals(listOf("fontContent:f1"), api.calls.filter { it.startsWith("fontContent") })
    }

    @Test fun aMissingLabelContextIsStoredAsNull() = runBlocking {
        api.assetsRaw = { assetsBody(asset2, ctx = null) }
        sync().runNow("i1", "Move A")
        assertEquals("null", db.meta().get(LABEL_CONTEXT_META_KEY)?.value)
    }

    @Test fun aTemplatesFailureKeepsOldTemplatesAndFinishesTheMove() = runBlocking {
        api.assetsRaw = { assetsBody(asset1) }
        api.templatesRaw = { templatesBody(tplA, tplB) }
        val s = sync(); s.runNow("i1", "Move A")

        api.assetsRaw = { assetsBody(asset2) }
        api.templatesRaw = { throw ApiError(500, "unknown_error") }
        s.runNow("i1", "Move A")

        val st = s.status.value
        assertEquals(SyncPhase.DONE, st.phase); assertNull(st.error)
        assertEquals("unknown_error", st.labelsError)
        assertEquals(PartState.FAILED, st.part("templates").state)
        assertEquals(PartState.DONE, st.part("assets").state); assertEquals(PartState.DONE, st.part("fonts").state)
        assertEquals(listOf("a2"), db.assets().all().map { it.id })
        assertEquals(listOf(tplA, tplB), db.labelTemplates().all().map { it.json })
    }

    @Test fun aFontFailureKeepsOldFontsAndFinishesTheMove() = runBlocking {
        api.fonts = { KioskLabelFonts(listOf(KioskLabelFont("f1", "ROBOTO.TTF", 4))) }
        api.fontContent = { fontBytes }
        val s = sync(); s.runNow("i1", "Move A")
        assertEquals(1, api.calls.count { it.startsWith("fontContent") })

        // An unchanged font already on disk is not downloaded again.
        s.runNow("i1", "Move A")
        assertEquals(1, api.calls.count { it.startsWith("fontContent") })

        // A new font that fails to download fails only the fonts part.
        api.fonts = { KioskLabelFonts(listOf(KioskLabelFont("f1", "ROBOTO.TTF", 4), KioskLabelFont("f3", "OPEN.TTF", 9))) }
        api.fontContent = { throw ApiError(0, "network") }
        s.runNow("i1", "Move A")
        val st = s.status.value
        assertEquals(SyncPhase.DONE, st.phase); assertNull(st.error); assertEquals("network", st.labelsError)
        assertEquals(PartState.FAILED, st.part("fonts").state); assertEquals(PartState.DONE, st.part("templates").state)
        assertEquals(listOf("f1"), db.labelFonts().all().map { it.id })
        assertTrue(File(fontsDir, "f1.ttf").isFile)

        // A font dropped from the move loses its row and its file.
        api.fonts = { KioskLabelFonts(emptyList()) }
        s.runNow("i1", "Move A")
        assertEquals(0, db.labelFonts().all().size)
        assertFalse(File(fontsDir, "f1.ttf").exists())
    }

    @Test fun aMoveFailureMarksItsPartAndKeepsEverything() = runBlocking {
        api.assetsRaw = { assetsBody(asset1) }
        api.templatesRaw = { templatesBody(tplA) }
        val s = sync(); s.runNow("i1", "Move A")
        api.trucks = { throw ApiError(0, "network") }
        api.templatesRaw = { templatesBody(tplB) }
        s.runNow("i1", "Move A")
        val st = s.status.value
        assertEquals(SyncPhase.ERROR, st.phase); assertEquals("network", st.error)
        assertEquals(PartState.FAILED, st.part("trucks").state)
        assertFalse(st.parts.any { it.state == PartState.RUNNING })
        assertEquals(listOf(tplA), db.labelTemplates().all().map { it.json })
        assertEquals(1, db.assets().count())
    }

    @Test fun hydrateAndClearCoverTheLabelData() = runBlocking {
        api.assetsRaw = { assetsBody(asset1) }
        api.templatesRaw = { templatesBody(tplA) }
        api.fonts = { KioskLabelFonts(listOf(KioskLabelFont("f1", "ROBOTO.TTF", 4))) }
        api.fontContent = { fontBytes }
        sync().runNow("i1", "Move A")
        db.generatedLabels().upsert(listOf(com.serversherpa.kiosk.data.db.GeneratedLabelEntity("a1", "^XA^XZ", "ok", "fp", "t1")))

        val fresh = sync(); fresh.hydrate()
        assertEquals(1, fresh.status.value.part("templates").count)
        assertEquals(1, fresh.status.value.part("fonts").count)
        assertTrue(fresh.status.value.parts.all { it.state == PartState.DONE })

        fresh.clearLocalData()
        assertEquals(0, db.labelTemplates().count()); assertEquals(0, db.labelFonts().all().size)
        assertNull(db.generatedLabels().get("a1")); assertNull(db.meta().get(LABEL_CONTEXT_META_KEY))
        assertFalse(File(fontsDir, "f1.ttf").exists())
        assertTrue(fresh.status.value.parts.all { it.state == PartState.WAITING })
    }
}
