package com.serversherpa.kiosk.core.rfid

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** How the sled's trigger drives an inventory. */
enum class RfidTriggerMode(val wire: String, val label: String, val hint: String) {
    HOLD("hold", "Hold to read", "Reading starts when the trigger goes down and stops when it comes up."),
    HOLD_OR_LATCH("latch", "Hold, or click to latch", "Holding reads. A quick click leaves it reading until the next click."),
    TOGGLE("toggle", "Click to start and stop", "Every press flips between reading and stopped."),
    ;
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

/** What to do with a tag this kiosk already queued since the screen opened. */
enum class RepeatSweepPolicy(val wire: String, val label: String, val hint: String) {
    ALWAYS_QUEUE("always", "Queue every sweep", "A second pass over the same rack queues those tags again."),
    SKIP_SILENT("skip", "Skip tags already sent", "A tag queued earlier on this screen is dropped without a word."),
    SKIP_AND_COUNT("count", "Skip, but count them", "Dropped repeats are counted on screen so a second pass still shows."),
    ;
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

/** The sled's own beeper. OFF is the reader's quiet setting, not a mute we fake. */
enum class SledBeeper(val wire: String, val label: String) {
    OFF("off", "Off"), LOW("low", "Low"), MEDIUM("medium", "Medium"), HIGH("high", "High");
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

/** The gen2 session. Higher sessions make a tag stay quiet longer after it answers. */
enum class RfidSession(val wire: String, val label: String) {
    S0("s0", "S0"), S1("s1", "S1"), S2("s2", "S2"), S3("s3", "S3");
    companion object { fun fromWire(s: String?) = entries.firstOrNull { it.wire == s } }
}

const val RFID_POWER_MIN = 5
const val RFID_POWER_MAX = 30
const val RFID_POPULATION_MIN = 1
const val RFID_POPULATION_MAX = 1000

/**
 * Everything the operator can set about the reader, kiosk-local like the rest
 * of the settings. `powerDbm` is the one most likely to need tuning on site:
 * high power is what makes a sweep pull in the next rack.
 */
data class RfidSettings(
    val enabled: Boolean = false,
    val triggerMode: RfidTriggerMode = RfidTriggerMode.HOLD,
    val repeatPolicy: RepeatSweepPolicy = RepeatSweepPolicy.ALWAYS_QUEUE,
    val beeper: SledBeeper = SledBeeper.MEDIUM,
    val powerDbm: Int = 27,
    val session: RfidSession = RfidSession.S1,
    val tagPopulation: Int = 30,
    val uniqueTagReport: Boolean = true,
    val ledOnRead: Boolean = true,
    val dpo: Boolean = true,
    val region: String? = null,
)

val DEFAULT_RFID_SETTINGS = RfidSettings()

fun RfidSettings.clamped(): RfidSettings = copy(
    powerDbm = powerDbm.coerceIn(RFID_POWER_MIN, RFID_POWER_MAX),
    tagPopulation = tagPopulation.coerceIn(RFID_POPULATION_MIN, RFID_POPULATION_MAX),
)

/** The SDK takes transmit power in tenths of a dBm: 27 dBm is 270. */
fun powerToTenths(dbm: Int): Int = dbm.coerceIn(RFID_POWER_MIN, RFID_POWER_MAX) * 10

private val json = Json { ignoreUnknownKeys = true }

fun RfidSettings.toJson(): String = buildJsonObject {
    put("enabled", enabled)
    put("triggerMode", triggerMode.wire)
    put("repeatPolicy", repeatPolicy.wire)
    put("beeper", beeper.wire)
    put("powerDbm", powerDbm)
    put("session", session.wire)
    put("tagPopulation", tagPopulation)
    put("uniqueTagReport", uniqueTagReport)
    put("ledOnRead", ledOnRead)
    put("dpo", dpo)
    if (region != null) put("region", region)
}.toString()

/** A bad field falls back to its default; a bad document falls back to all of them. */
fun parseRfidSettings(raw: String?): RfidSettings {
    val obj = try { raw?.let { json.parseToJsonElement(it).jsonObject } } catch (e: Exception) { null }
        ?: return DEFAULT_RFID_SETTINGS
    // A field can hold a JSON object or array instead of a primitive (an older
    // build, or a corrupted document); `as?` returns null there instead of
    // throwing the way the `.jsonPrimitive` extension would.
    fun prim(key: String) = obj[key] as? JsonPrimitive
    fun str(key: String) = prim(key)?.takeIf { it.isString }?.content
    fun int(key: String) = prim(key)?.takeIf { !it.isString }?.intOrNull
    fun bool(key: String) = prim(key)?.takeIf { !it.isString }?.booleanOrNull
    val d = DEFAULT_RFID_SETTINGS
    return RfidSettings(
        enabled = bool("enabled") ?: d.enabled,
        triggerMode = RfidTriggerMode.fromWire(str("triggerMode")) ?: d.triggerMode,
        repeatPolicy = RepeatSweepPolicy.fromWire(str("repeatPolicy")) ?: d.repeatPolicy,
        beeper = SledBeeper.fromWire(str("beeper")) ?: d.beeper,
        powerDbm = int("powerDbm") ?: d.powerDbm,
        session = RfidSession.fromWire(str("session")) ?: d.session,
        tagPopulation = int("tagPopulation") ?: d.tagPopulation,
        uniqueTagReport = bool("uniqueTagReport") ?: d.uniqueTagReport,
        ledOnRead = bool("ledOnRead") ?: d.ledOnRead,
        dpo = bool("dpo") ?: d.dpo,
        region = str("region"),
    ).clamped()
}
