package com.serversherpa.kiosk.nettest

/**
 * Apple's Network Link Conditioner presets, with speeds in kbps (Apple's Mbps
 * times 1000). OFF and CUSTOM carry no profile of their own: OFF is the bypass,
 * and CUSTOM reads the dial's own saved values.
 *
 * [id] is what gets saved, so it never changes once shipped.
 */
enum class Preset(val id: String, val label: String, val profile: LinkProfile?) {
    OFF("off", "Off", null),
    WIFI("wifi", "Wi-Fi", LinkProfile(40_000, 33_000, 1, 1, 0.0, 0.0, 0)),
    WIFI_AC("wifi-ac", "Wi-Fi 802.11ac", LinkProfile(250_000, 100_000, 1, 1, 0.0, 0.0, 0)),
    LTE("lte", "LTE", LinkProfile(50_000, 10_000, 50, 50, 0.0, 0.0, 0)),
    DSL("dsl", "DSL", LinkProfile(2_000, 256, 5, 5, 0.05, 0.039, 0)),
    THREE_G("3g", "3G", LinkProfile(780, 330, 100, 100, 0.0, 0.0, 0)),
    EDGE("edge", "Edge", LinkProfile(240, 200, 400, 400, 0.0, 0.0, 0)),
    VERY_BAD("very-bad", "Very Bad Network", LinkProfile(1_000, 1_000, 500, 500, 10.0, 10.0, 0)),
    HIGH_LATENCY_DNS("high-latency-dns", "High Latency DNS", LinkProfile(null, null, 0, 0, 0.0, 0.0, 3_000)),
    LOSS_100("loss-100", "100% Loss", LinkProfile(null, null, 0, 0, 100.0, 100.0, 0)),
    CUSTOM("custom", "Custom", null),
}

/**
 * The two links the tool can condition, each with its own list of presets.
 * INTERNET is everything off the local network; LOCAL is the printer and other
 * devices on the same network.
 */
enum class Dial(val presets: List<Preset>) {
    INTERNET(
        listOf(
            Preset.OFF, Preset.WIFI, Preset.WIFI_AC, Preset.LTE, Preset.DSL, Preset.THREE_G,
            Preset.EDGE, Preset.VERY_BAD, Preset.HIGH_LATENCY_DNS, Preset.LOSS_100, Preset.CUSTOM,
        ),
    ),
    LOCAL(listOf(Preset.OFF, Preset.WIFI, Preset.VERY_BAD, Preset.LOSS_100, Preset.CUSTOM)),
}
