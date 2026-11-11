package com.serversherpa.kiosk.core.rfid

/**
 * Every sentence an operator reads about the sled (spec, Words), used by the
 * reader adapter and the screens alike, so all of them say the same thing.
 *
 * Vocabulary: "sled" is the thing in the hand, "the sled's barcode scanner"
 * is its scanner, "tags" and "barcodes" are what it reads. No sentence names
 * the vendor's SDK, its result codes or its internal terms; those go to the
 * log only (`SledWordsTest` checks every member). The one exception is
 * [ROW_SESSION], the RFID tab's own row label. American English.
 */
object SledWords {
    private const val THE_SLED = "the sled"
    private const val ANOTHER_ASSET = "another asset"

    // ── Connection (RFID tab, Devices tab, the scan-screen slot) ──

    const val OFF = "Off. Turn the reader on to use the sled."
    const val NOT_CONNECTED = "Not connected."
    const val CONNECTING = "Connecting…"

    fun connected(name: String, batteryPct: Int?): String =
        if (batteryPct == null) "Connected to $name" else "Connected to $name · battery $batteryPct%"

    const val RECONNECTING_AFTER_DROP = "The sled disconnected. Reconnecting…"

    /** A connect that never came up, being tried again. */
    fun connectingTo(name: String?): String = "Connecting to ${name ?: THE_SLED}…"

    /** A connect that failed, or a reconnect that gave up. With [severalPaired], also says how to pick another sled. */
    fun couldNotReach(name: String?, severalPaired: Boolean = false): String {
        val sentence = "Couldn't reach ${name ?: THE_SLED}. Make sure it is on, charged and close by, then tap Connect."
        return if (severalPaired) "$sentence $USE_A_DIFFERENT_SLED" else sentence
    }

    const val USE_A_DIFFERENT_SLED = "To use a different sled, choose it in Settings › RFID."
    const val BLUETOOTH_OFF = "Bluetooth is off. Turn it on to use the sled."
    const val NO_SLED_PAIRED =
        "No sled is paired with this device. Pair the RFD40 in Bluetooth settings, then come back and tap Connect."
    const val SEVERAL_PAIRED = "More than one sled is paired with this device. Choose one in Settings › RFID."
    const val NAMELESS_DEVICE = "A paired Bluetooth device has no name. Remove it in Bluetooth settings."

    fun duplicateName(name: String): String =
        "Two paired Bluetooth devices are named $name. Remove the one that isn't the sled in Bluetooth settings."

    fun noRegion(name: String): String =
        "$name has no region set, so it can't read tags. An admin sets it in Settings › Admin."

    /** The exact reason of the retryable failure after a first batch clear; the controller recognizes it. */
    const val BATCH_CLEARED_RETRYING = "The sled was holding tags from offline use. Connecting again…"
    const val CLASS_LOADING =
        "This app couldn't start the sled connection. Restart the app; if it happens again, reinstall it."
    const val PASSWORD = "This sled is locked with a password. This app can't unlock it."
    const val BATCH_CLEARED_NOTE = "The sled was holding tags from offline use. They were cleared."
    const val BATCH_NOT_CLEARED_NOTE = "The sled was holding tags from offline use. They couldn't be cleared."

    /** Today's RFID tab sentence, byte for byte (two tests pin it). */
    const val PERMISSION_MISSING =
        "Android needs Bluetooth and location permission before the sled can connect. Grant them in this app's settings."
    const val OPEN_APP_SETTINGS = "Open app settings"

    /** The exact reason the adapter writes when the trigger events did not set up; `sledLine` recognizes it. */
    const val TRIGGER_NOT_SET_UP = "The sled connected, but its trigger didn't answer. Tap Connect to try again."
    const val TRIGGER_NOT_SET_UP_RETRYING = "The sled connected, but its trigger didn't answer. Trying again…"

    /**
     * A second batch result in a row (ruling 28). It names the one remedy
     * known to work, Zebra's 123RFID Mobile app, says it should be a one-time
     * fix, and says the app keeps batch mode off afterward (ruling 37).
     */
    const val BATCH_MODE_UNRECOVERABLE_MESSAGE =
        "This reader is holding tags stored during earlier offline use, and this app couldn't clear " +
            "them. Open Zebra's 123RFID Mobile app and connect to the sled there — it can clear the stored " +
            "batch; once that's done, reconnect here. This should only be a one-time fix: once this app " +
            "completes one healthy connection with this sled, it turns batch mode off and keeps it off on " +
            "every disconnect, so the sled should not return to this state on its own again."

    // ── The "RFID reader" row's hint ──

    const val READER_HINT = "A Zebra RFD40 paired to this device over Bluetooth."
    const val DISPLAY_HINT =
        "While the sled is in use, the display stays on in the scan screens, so the sled isn't dropped when the " +
            "phone sleeps. It turns off after 10 minutes without a trigger pull or a touch."
    const val RECONNECT_HINT =
        "If the sled drops, the app tries to reconnect four times over the next few minutes. Tap Stop, or turn " +
            "the reader off, to stop it."

    // ── Buttons ──

    const val CONNECT = "Connect"
    const val DISCONNECT = "Disconnect"
    const val STOP = "Stop"
    const val TRY_AGAIN = "Try again"
    const val RETRY = "Retry"
    const val SCAN = "Scan"

    // ── Sled triggers ──

    const val SLED_TRIGGERS = "Sled triggers"

    /** The hint for [layout]: what [reports] says for the pair it writes. */
    fun hint(layout: SledTriggerLayout): String {
        val (upper, lower) = layout.keys()
        return reports(readbackOf(upper, lower, null))
    }

    /** What the sled's triggers do, per trigger; one plural sentence when both do the same. */
    fun reports(readback: SledTriggerReadback): String {
        val upper = TriggerRole.of(readback.upper)
        val lower = TriggerRole.of(readback.lower)
        return if (upper == lower) {
            "Upper and lower triggers ${upper.plural}."
        } else {
            "Upper trigger ${upper.singular}. Lower trigger ${lower.singular}."
        }
    }

    /** The sled reports something other than what was asked. */
    fun didNotTake(readback: SledTriggerReadback): String = "The sled didn't take that. It is set to: " + reports(readback)

    const val TRIGGER_CHECK_FAILED = "Couldn't check the sled's trigger setting."
    const val NO_SCANNER = "This sled has no barcode scanner. Both triggers read tags."
    const val ZEBRA_HOST = "On this device the handheld's own scanner reads barcodes. Both sled triggers read tags."

    private enum class TriggerRole(val singular: String, val plural: String) {
        TAGS("reads tags", "read tags"),
        BARCODES("scans barcodes", "scan barcodes"),
        NONE("is not assigned", "are not assigned"),
        ;

        companion object {
            fun of(key: SledKey): TriggerRole = when (key) {
                SledKey.RFID -> TAGS
                SledKey.SLED_SCAN -> BARCODES
                SledKey.TERMINAL_SCAN, SledKey.SCAN_NOTIFY, SledKey.NO_ACTION, SledKey.UNKNOWN -> NONE
            }
        }
    }

    // ── The sled's barcode scanner ──

    const val SCANNER_STARTING = "Starting the sled's barcode scanner…"
    const val SCANNER_READY = "Barcode scanner ready."
    const val SCANNER_DID_NOT_START =
        "The sled's barcode scanner didn't start, so scans from the sled won't arrive. Tap Try again, or scan with the camera."
    const val SCANNER_STOPPED_RESPONDING =
        "The sled's barcode scanner stopped responding. Close the app and open it again."

    // ── Reading ──

    const val READ_DID_NOT_START = "The sled didn't start reading. Pull the trigger again."
    const val CHARGING = "The sled can't read tags while it is charging."
    const val MAY_STILL_BE_READING = "The sled may still be reading. Pull the trigger once to stop it."

    // ── Settings: the RFID tab's row labels, which the refused-settings sentence names ──

    const val ROW_SLED_BEEPER = "Sled beeper"
    const val ROW_TRANSMIT_POWER = "Transmit power"

    /** The one allowed use of "session" on screen: the RFID tab's own row label. */
    const val ROW_SESSION = "Session"
    const val ROW_TAG_POPULATION = "Tag population"
    const val ROW_UNIQUE = "Report each tag once"
    const val ROW_DPO = "Dynamic power optimization"

    // ── Settings: the RFID tab's row hints ──

    const val HINT_SLED_BEEPER = "The reader's own beep on each tag. Off is its quiet setting."
    const val HINT_TRANSMIT_POWER = "How far the reader reaches. Lower it if a sweep is picking up the next rack."
    const val HINT_SESSION = "A higher setting keeps a tag quiet longer after it answers."
    const val HINT_TAG_POPULATION = "Roughly how many tags are in front of the reader at once."
    const val HINT_UNIQUE = "The reader reports a tag once per sweep instead of repeatedly."
    const val HINT_DPO = "Saves battery during a long sweep."
    const val HINT_REGION = "A compliance setting. It's set on the Admin tab, not here."

    /** The RFID tab's read-only region line, with the last region an admin set ([code]). */
    fun activeRegion(code: String): String = "The active region is $code."

    /** The RFID tab's region line when no admin has set one here. */
    const val READERS_OWN_REGION = "The reader's own setting applies."

    /**
     * The settings the sled refused, named by their row [labels] with the first
     * letter lowercased ("a", "a and b", "a, b, and c"). With [othersApplied]
     * false, the second sentence is left off. No labels: [SETTINGS_NOT_APPLIED].
     */
    fun refused(labels: List<String>, othersApplied: Boolean = true): String {
        if (labels.isEmpty()) return SETTINGS_NOT_APPLIED
        val names = labels.map { label -> label.replaceFirstChar { it.lowercaseChar() } }
        val list = when (names.size) {
            1 -> names[0]
            2 -> "${names[0]} and ${names[1]}"
            else -> names.dropLast(1).joinToString(", ") + ", and " + names.last()
        }
        val first = "The sled didn't accept: $list."
        return if (othersApplied) "$first The other settings were applied." else first
    }

    const val PUSH_STOPPED = "The sled stopped answering before every setting was applied."

    /** A failed push that carried no sentence of its own. */
    const val SETTINGS_NOT_APPLIED = "The sled didn't accept every setting."

    fun powerCap(maxDbm: Int): String = "This sled's maximum is $maxDbm dBm."

    // ── Admin ──

    const val REGIONS_FAILED = "Couldn't read the sled's regions. Tap Retry."
    const val REGION_SET_RECONNECTING = "Region set. Reconnecting the sled…"
    const val FINISH_READ_FIRST = "Finish the current read before changing the region."
    const val REGION_NOT_SET = "The sled didn't accept that region."

    // ── Developer (the row's label lives in DeveloperPanel; ruling 35) ──

    const val VENDOR_LOGGING_HINT =
        "Writes everything sent to and from the sled to this device's log, including tag and barcode values. " +
            "Off again when the app closes."

    // ── RFID Enroll (the web kiosk's words) ──

    const val ENROLL_OWN_ASSET_ID = "That's this asset's own asset ID, not an RFID tag."
    const val ENROLL_OWN_SERIAL = "That's this asset's own serial, not an RFID tag."

    /** Another asset's ID scanned as a tag; [name] is that asset's name, or null for "another asset". */
    fun enrollOtherAssetId(name: String?): String = "That's the asset ID for ${name ?: ANOTHER_ASSET}, not an RFID tag."

    /** Another asset's serial scanned as a tag; [name] is that asset's name, or null for "another asset". */
    fun enrollOtherSerial(name: String?): String = "That's the serial for ${name ?: ANOTHER_ASSET}, not an RFID tag."
}
