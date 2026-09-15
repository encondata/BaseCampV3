package com.serversherpa.kiosk.core.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.roundToInt

data class Hsl(val h: Double, val s: Double, val l: Double)

/** The three scan flashes and their duration — kiosk-local. */
data class Appearance(val goodScan: Hsl, val notFoundScan: Hsl, val duplicateScan: Hsl, val flashMs: Int)

const val FLASH_MS_MIN = 100
const val FLASH_MS_MAX = 2000
const val FLASH_MS_STEP = 50

val DEFAULT_APPEARANCE = Appearance(
    goodScan = Hsl(150.0, 60.0, 45.0),
    notFoundScan = Hsl(0.0, 70.0, 50.0),
    duplicateScan = Hsl(38.0, 92.0, 50.0),
    flashMs = 350,
)

fun clampFlashMs(value: Int?): Int = value?.coerceIn(FLASH_MS_MIN, FLASH_MS_MAX) ?: DEFAULT_APPEARANCE.flashMs

private val json = Json { ignoreUnknownKeys = true }

private fun hslOf(obj: JsonObject?): Hsl? {
    if (obj == null) return null
    val h = obj["h"]?.jsonPrimitive?.doubleOrNull ?: return null
    val s = obj["s"]?.jsonPrimitive?.doubleOrNull ?: return null
    val l = obj["l"]?.jsonPrimitive?.doubleOrNull ?: return null
    if (h !in 0.0..360.0 || s !in 0.0..100.0 || l !in 0.0..100.0) return null
    return Hsl(h, s, l)
}

/** Each channel falls back on its own, as appearance.ts does. */
fun parseAppearance(raw: String?): Appearance {
    if (raw.isNullOrBlank()) return DEFAULT_APPEARANCE
    val obj = try { json.parseToJsonElement(raw).jsonObject } catch (e: Exception) { return DEFAULT_APPEARANCE }
    fun field(name: String) = try { obj[name]?.jsonObject } catch (e: Exception) { null }
    val flash = try { obj["flash_ms"]?.jsonPrimitive?.double?.roundToInt() } catch (e: Exception) { null }
    return Appearance(
        goodScan = hslOf(field("good_scan")) ?: DEFAULT_APPEARANCE.goodScan,
        notFoundScan = hslOf(field("not_found_scan")) ?: DEFAULT_APPEARANCE.notFoundScan,
        duplicateScan = hslOf(field("duplicate_scan")) ?: DEFAULT_APPEARANCE.duplicateScan,
        flashMs = clampFlashMs(flash),
    )
}

private fun Hsl.toJsonObject() = buildJsonObject { put("h", h); put("s", s); put("l", l) }

fun Appearance.toJson(): String = buildJsonObject {
    put("good_scan", goodScan.toJsonObject())
    put("not_found_scan", notFoundScan.toJsonObject())
    put("duplicate_scan", duplicateScan.toJsonObject())
    put("flash_ms", flashMs)
}.toString()

/** `hsl(150 60% 45%)` — the readout string the Appearance tab shows. */
fun hslCss(hsl: Hsl): String = "hsl(${hsl.h.roundToInt()} ${hsl.s.roundToInt()}% ${hsl.l.roundToInt()}%)"

/** Opaque ARGB int for the flash overlay. */
fun hslToArgb(hsl: Hsl): Int {
    val h = ((hsl.h % 360) + 360) % 360
    val s = (hsl.s / 100.0).coerceIn(0.0, 1.0)
    val l = (hsl.l / 100.0).coerceIn(0.0, 1.0)
    val c = (1 - abs(2 * l - 1)) * s
    val x = c * (1 - abs((h / 60.0) % 2 - 1))
    val m = l - c / 2
    val (r1, g1, b1) = when {
        h < 60 -> Triple(c, x, 0.0)
        h < 120 -> Triple(x, c, 0.0)
        h < 180 -> Triple(0.0, c, x)
        h < 240 -> Triple(0.0, x, c)
        h < 300 -> Triple(x, 0.0, c)
        else -> Triple(c, 0.0, x)
    }
    fun ch(v: Double) = ((v + m) * 255).roundToInt().coerceIn(0, 255)
    return (0xFF shl 24) or (ch(r1) shl 16) or (ch(g1) shl 8) or ch(b1)
}
