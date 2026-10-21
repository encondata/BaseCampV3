package com.serversherpa.kiosk.core.labels

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * The label generator's JSON surface (kiosk/src/labelgen/index.ts), store-free: every call takes
 * one JSON object of arguments and answers one JSON object, or `{"error": "..."}`.
 *
 * The generator reads the raw sync bodies, so they are rebuilt from the stored text exactly
 * (number literals intact): the asset payloads in stored order with the move's `label_context`,
 * and the templates in the server's order (template ties depend on it).
 */
object LabelGenArgs {
    /** The /kiosk/sync/assets body: [payloads] are the assets' stored JSON objects and
     *  [labelContext] the stored `label_context` text (`null` when the server sent none). */
    fun assetsBody(initiativeId: String, payloads: List<String>, labelContext: String): String = buildString {
        append("{\"initiative_id\":").append(JsonPrimitive(initiativeId).toString())
        append(",\"assets\":[")
        payloads.forEachIndexed { i, p -> if (i > 0) append(','); append(p) }
        append("],\"label_context\":").append(labelContext.ifBlank { "null" }).append('}')
    }

    /** The /kiosk/sync/label-templates body from the stored template objects, in order. */
    fun templatesBody(templates: List<String>): String = templates.joinToString(",", "{\"templates\":[", "]}")

    /** `buildPlan` arguments. */
    fun plan(assetsJson: String, templatesJson: String, kind: LabelKind, dpi: Int): String =
        buildJsonObject {
            put("assetsJson", assetsJson); put("templatesJson", templatesJson)
            put("kind", kind.wire); put("dpi", dpi)
        }.toString()

    /** `renderLabels` arguments: the labels of [assetIds], in that order. */
    fun render(assetsJson: String, templatesJson: String, kind: LabelKind, dpi: Int, assetIds: List<String>): String =
        buildJsonObject {
            put("assetsJson", assetsJson); put("templatesJson", templatesJson)
            put("kind", kind.wire); put("dpi", dpi)
            put("assetIds", JsonArray(assetIds.map { JsonPrimitive(it) }))
        }.toString()

    /** `applyPrintSettings` arguments: the saved offsets in dots (one copy, always). */
    fun printSettings(zpl: String, offsetX: Int, offsetY: Int): String =
        buildJsonObject { put("zpl", zpl); put("verticalOffset", offsetY); put("horizontalOffset", offsetX) }.toString()

    /** `withPrintMode` arguments: peel-off (`^MMP`) or tear-off (`^MMT`). */
    fun printMode(zpl: String, peel: Boolean): String =
        buildJsonObject { put("zpl", zpl); put("peel", peel) }.toString()
}

/** One asset's job in a plan: its label is current when the stored fingerprint matches. */
@Serializable
data class LabelPlanJob(val assetId: String, val fingerprint: String)

/** What `buildPlan` answers: the picked template (or the DPIs that have one), the fonts it
 *  prints with, and one job per asset. [hasAssetData] false means the body had no usable
 *  asset data, so the empty [jobs] say nothing about the move and no label may be pruned. */
@Serializable
data class LabelPlan(
    val templateId: String? = null,
    val templateFamily: String? = null,
    val notes: List<String> = emptyList(),
    val fonts: List<String> = emptyList(),
    val availableDpis: List<Int> = emptyList(),
    val hasAssetData: Boolean = false,
    val jobs: List<LabelPlanJob> = emptyList(),
)

/** One label from `renderLabels`: [zpl] when [outcome] is `ok`, else null. */
@Serializable
data class RenderedLabel(val assetId: String, val zpl: String? = null, val outcome: String, val fingerprint: String)

@Serializable
private data class RenderedLabels(val results: List<RenderedLabel>)

/** The generator answered `{"error": ...}`, or something that isn't its answer. */
class LabelGenException(message: String) : Exception(message)

private val SurfaceJson = Json { ignoreUnknownKeys = true; explicitNulls = false }

/** The answer as an object, or [LabelGenException] for an error answer or anything malformed. */
private fun answer(json: String): JsonObject {
    val el = try {
        SurfaceJson.parseToJsonElement(json)
    } catch (e: Exception) {
        throw LabelGenException("the label generator's answer is not JSON")
    }
    val obj = el as? JsonObject ?: throw LabelGenException("the label generator's answer is not an object")
    obj["error"]?.let { throw LabelGenException((it as? JsonPrimitive)?.contentOrNull ?: it.toString()) }
    return obj
}

private inline fun <T> decoding(block: () -> T): T = try {
    block()
} catch (e: LabelGenException) {
    throw e
} catch (e: Exception) {
    throw LabelGenException("the label generator's answer is malformed: ${e.message}")
}

fun parsePlan(json: String): LabelPlan = decoding { SurfaceJson.decodeFromJsonElement(LabelPlan.serializer(), answer(json)) }

fun parseRendered(json: String): List<RenderedLabel> =
    decoding { SurfaceJson.decodeFromJsonElement(RenderedLabels.serializer(), answer(json)).results }

/** The `{zpl}` answer of `applyPrintSettings`, `withPrintMode` and `alignmentTestZpl`. */
fun parseZpl(json: String): String = decoding {
    (answer(json)["zpl"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: throw LabelGenException("the label generator's answer has no zpl")
}
