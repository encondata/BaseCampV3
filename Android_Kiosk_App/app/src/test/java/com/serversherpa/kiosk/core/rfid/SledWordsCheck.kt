package com.serversherpa.kiosk.core.rfid

/** Matched exactly as written: result-name prefixes of the two Zebra SDKs. */
private val CASE_SENSITIVE_TOKENS = listOf("RFID_", "DCSSDK_", "ENUM_")

/** Matched ignoring case, anywhere in the text: words an operator never reads about the sled. */
private val CASE_INSENSITIVE_TOKENS = listOf("SDK", "layout", "session", "imager", "plugin", "read-back", "HID")

/**
 * The words rule (spec, Words): the forbidden tokens [text] contains, in the
 * order listed above; empty when the sentence is clean. With
 * [allowSessionLabel], "session" is not checked, for the one place the RFID
 * tab's own "Session" row label may appear. `SledWordsTest`, `SledLineTest`
 * and the adapter's failure-reason test all check their sentences with this.
 */
internal fun sledWordsViolations(text: String, allowSessionLabel: Boolean = false): List<String> =
    CASE_SENSITIVE_TOKENS.filter { text.contains(it) } +
        CASE_INSENSITIVE_TOKENS
            .filter { !(allowSessionLabel && it == "session") }
            .filter { text.contains(it, ignoreCase = true) }
