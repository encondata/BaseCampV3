package com.serversherpa.kiosk.nettest

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** How long a test stays on after it is switched on: two hours. */
const val TEST_LIFETIME_MS = 7_200_000L

/**
 * True when a test armed at [armedAtMs] should no longer be running at [nowMs].
 * Never armed counts as expired, and so does a clock moved backward past the
 * moment of arming, since the elapsed time can't be trusted.
 */
fun isExpired(armedAtMs: Long?, nowMs: Long): Boolean =
    armedAtMs == null || nowMs < armedAtMs || nowMs - armedAtMs >= TEST_LIFETIME_MS

/** The wall-clock moment a test armed at [armedAtMs] turns itself off. */
fun turnsOffAtMs(armedAtMs: Long): Long = armedAtMs + TEST_LIFETIME_MS

/**
 * One dial's saved choice: a preset id (a [Preset.id], kept as text so an id
 * from a newer build never breaks the load) and the Custom values.
 */
@Serializable
data class DialSetting(
    val preset: String = Preset.OFF.id,
    val custom: LinkProfile = DEFAULT_CUSTOM,
)

/**
 * Everything Internet Test remembers: the master switch, when it was switched
 * on (the two-hour clock starts there), and each dial's choice.
 */
@Serializable
data class InternetTestSettings(
    val enabled: Boolean = false,
    val armedAtMs: Long? = null,
    val internet: DialSetting = DialSetting(),
    val local: DialSetting = DialSetting(),
) {
    fun dial(d: Dial): DialSetting = when (d) {
        Dial.INTERNET -> internet
        Dial.LOCAL -> local
    }

    /**
     * The conditions to apply to [d] right now, or null when that link should go
     * direct: the switch is off, or the dial is on Off. Custom values are
     * clamped on the way out.
     */
    fun activeProfile(d: Dial): LinkProfile? {
        if (!enabled) return null
        val setting = dial(d)
        return when (val preset = Preset.entries.firstOrNull { it.id == setting.preset } ?: Preset.OFF) {
            Preset.OFF -> null
            Preset.CUSTOM -> setting.custom.clamped()
            else -> preset.profile
        }
    }

    fun encode(): String = Codec.encodeToString(this)

    companion object {
        private val Codec = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
            coerceInputValues = true
        }

        /**
         * Reads what [encode] wrote. Never throws: nothing saved, corrupt JSON or
         * the wrong shape all give the defaults (switch off), and a preset id the
         * dial doesn't offer reads as "off".
         */
        fun decode(text: String?): InternetTestSettings {
            if (text.isNullOrBlank()) return InternetTestSettings()
            val parsed = try {
                Codec.decodeFromString<InternetTestSettings>(text)
            } catch (_: Exception) {
                return InternetTestSettings()
            }
            return parsed.copy(
                internet = parsed.internet.withKnownPreset(Dial.INTERNET),
                local = parsed.local.withKnownPreset(Dial.LOCAL),
            )
        }

        private fun DialSetting.withKnownPreset(d: Dial): DialSetting =
            if (d.presets.any { it.id == preset }) this else copy(preset = Preset.OFF.id)
    }
}
