package com.serversherpa.kiosk.core.labels

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The JSON the generator's surface takes and returns (kiosk/src/labelgen/index.ts), without Android. */
class LabelGenArgsTest {
    // Number literals and text the generator must see exactly as stored.
    private val p1 = """{"id":"a1","raw_ft":{"RU":12.0,"Qty":7,"Tiny":1e-05},"name":"Café ^~_ 😀 \"q\" \\"}"""
    private val p2 = """{"id":"a2","raw_ft":{}}"""
    private val context = """{"move_name":"Move A","catalog_keys":["RU"]}"""

    @Test fun assetsBodyIsTheSyncBodyRebuiltFromStoredText() {
        val body = LabelGenArgs.assetsBody("i\"1", listOf(p1, p2), context)
        assertEquals("""{"initiative_id":"i\"1","assets":[$p1,$p2],"label_context":$context}""", body)
        // Valid JSON, with the stored payloads intact.
        val parsed = Json.parseToJsonElement(body).jsonObject
        assertEquals(2, parsed["assets"]!!.jsonArray.size)
        assertEquals("""{"initiative_id":"i1","assets":[],"label_context":null}""", LabelGenArgs.assetsBody("i1", emptyList(), "null"))
        assertEquals("""{"initiative_id":"i1","assets":[],"label_context":null}""", LabelGenArgs.assetsBody("i1", emptyList(), " "))
    }

    @Test fun templatesBodyKeepsTheStoredOrder() {
        val t1 = """{"id":"t1","design":{"schema":2.0}}"""
        val t0 = """{"id":"t0","version":1}"""
        assertEquals("""{"templates":[$t1,$t0]}""", LabelGenArgs.templatesBody(listOf(t1, t0)))
        assertEquals("""{"templates":[]}""", LabelGenArgs.templatesBody(emptyList()))
    }

    @Test fun planAndRenderArgsCarryTheBodiesAsText() {
        val assets = LabelGenArgs.assetsBody("i1", listOf(p1, p2), context)
        val templates = LabelGenArgs.templatesBody(listOf("""{"id":"t1"}"""))
        val plan = Json.parseToJsonElement(LabelGenArgs.plan(assets, templates, LabelKind.FRONT, 300)).jsonObject
        assertEquals(setOf("assetsJson", "templatesJson", "kind", "dpi"), plan.keys)
        // The bodies come back byte for byte once the surface's JSON.parse reads the args.
        assertEquals(assets, plan["assetsJson"]!!.jsonPrimitive.content)
        assertEquals(templates, plan["templatesJson"]!!.jsonPrimitive.content)
        assertEquals("front", plan["kind"]!!.jsonPrimitive.content)
        assertEquals(300, plan["dpi"]!!.jsonPrimitive.int)

        val render = Json.parseToJsonElement(LabelGenArgs.render(assets, templates, LabelKind.TOP, 203, listOf("a2", "a1"))).jsonObject
        assertEquals("top", render["kind"]!!.jsonPrimitive.content)
        assertEquals(listOf("a2", "a1"), (render["assetIds"] as JsonArray).map { it.jsonPrimitive.content })
        assertEquals(assets, render["assetsJson"]!!.jsonPrimitive.content)
    }

    @Test fun parsesAPlan() {
        val plan = parsePlan(
            """{"templateId":"t1","templateFamily":"vegas","notes":["n1"],"fonts":["ROBOTO.TTF"],"availableDpis":[],""" +
                """"hasAssetData":true,"jobs":[{"assetId":"a1","fingerprint":"00abc"},{"assetId":"a2","fingerprint":"00def"}]}""",
        )
        assertEquals("t1", plan.templateId)
        assertEquals(listOf("n1"), plan.notes)
        assertEquals(listOf("ROBOTO.TTF"), plan.fonts)
        assertTrue(plan.hasAssetData)
        assertEquals(listOf(LabelPlanJob("a1", "00abc"), LabelPlanJob("a2", "00def")), plan.jobs)

        val none = parsePlan("""{"templateId":null,"templateFamily":null,"notes":[],"fonts":[],"availableDpis":[203,600],"hasAssetData":false,"jobs":[]}""")
        assertNull(none.templateId)
        assertEquals(listOf(203, 600), none.availableDpis)
        assertFalse(none.hasAssetData)
    }

    @Test fun parsesRenderedLabelsWithTheirZplIntact() {
        val zpl = "^XA^FO10,10^FH^FDCaf_c3_a9 \\& \"x\"^FS^XZ"
        // The label as JSON.stringify writes it: quotes and backslashes escaped.
        val json = """{"results":[{"assetId":"a1","zpl":${JsonPrimitive(zpl)},"outcome":"ok","fingerprint":"f1"},""" +
            """{"assetId":"a2","zpl":null,"outcome":"no_template_at_dpi","fingerprint":"f2"}]}"""
        val results = parseRendered(json)
        assertEquals(listOf(RenderedLabel("a1", zpl, "ok", "f1"), RenderedLabel("a2", null, NO_TEMPLATE_AT_DPI, "f2")), results)
    }

    @Test fun anErrorResultThrows() {
        val e = assertThrows(LabelGenException::class.java) { parsePlan("""{"error":"bad printer DPI: 0"}""") }
        assertEquals("bad printer DPI: 0", e.message)
        assertThrows(LabelGenException::class.java) { parseRendered("""{"error":"assetIds must be a list of strings"}""") }
        assertThrows(LabelGenException::class.java) { parseRendered("not json") }
        assertThrows(LabelGenException::class.java) { parsePlan("[]") }
    }
}
