package com.serversherpa.kiosk.core.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

enum class BuiltinSound(val wire: String, val label: String) {
    CHIME("chime", "Chime"), BEEP("beep", "Beep"), DOUBLE_BEEP("double_beep", "Double beep"), BUZZ("buzz", "Buzz"), BONK("bonk", "Bonk");
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

sealed class SoundChoice {
    data object None : SoundChoice()
    data class Builtin(val id: BuiltinSound) : SoundChoice()
}

/** good / not-found / duplicate choices and a 0–1 volume — kiosk-local. */
data class SoundSettings(val good: SoundChoice, val notFound: SoundChoice, val duplicate: SoundChoice, val volume: Double)

val DEFAULT_SOUND_SETTINGS = SoundSettings(
    good = SoundChoice.Builtin(BuiltinSound.CHIME),
    notFound = SoundChoice.Builtin(BuiltinSound.BUZZ),
    duplicate = SoundChoice.Builtin(BuiltinSound.DOUBLE_BEEP),
    volume = 0.8,
)

private val json = Json { ignoreUnknownKeys = true }

private fun choiceOf(obj: JsonObject?): SoundChoice? {
    val kind = obj?.get("kind")?.jsonPrimitive?.content ?: return null
    return when (kind) {
        "none" -> SoundChoice.None
        "builtin" -> BuiltinSound.fromWire(obj["id"]?.jsonPrimitive?.content)?.let { SoundChoice.Builtin(it) }
        else -> null   // "upload" is a web-only kind
    }
}

fun parseSoundSettings(raw: String?): SoundSettings {
    if (raw.isNullOrBlank()) return DEFAULT_SOUND_SETTINGS
    val obj = try { json.parseToJsonElement(raw).jsonObject } catch (e: Exception) { return DEFAULT_SOUND_SETTINGS }
    fun field(name: String) = try { obj[name]?.jsonObject } catch (e: Exception) { null }
    val volume = try { obj["volume"]?.jsonPrimitive?.doubleOrNull } catch (e: Exception) { null }
    return SoundSettings(
        good = choiceOf(field("good")) ?: DEFAULT_SOUND_SETTINGS.good,
        notFound = choiceOf(field("not_found")) ?: DEFAULT_SOUND_SETTINGS.notFound,
        duplicate = choiceOf(field("duplicate")) ?: DEFAULT_SOUND_SETTINGS.duplicate,
        volume = volume?.coerceIn(0.0, 1.0) ?: DEFAULT_SOUND_SETTINGS.volume,
    )
}

private fun SoundChoice.toJsonObject() = when (this) {
    SoundChoice.None -> buildJsonObject { put("kind", "none") }
    is SoundChoice.Builtin -> buildJsonObject { put("kind", "builtin"); put("id", id.wire) }
}

fun SoundSettings.toJson(): String = buildJsonObject {
    put("good", good.toJsonObject()); put("not_found", notFound.toJsonObject())
    put("duplicate", duplicate.toJsonObject()); put("volume", volume)
}.toString()
