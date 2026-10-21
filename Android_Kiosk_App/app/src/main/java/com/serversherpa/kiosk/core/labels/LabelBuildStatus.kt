package com.serversherpa.kiosk.core.labels

/** A label's outcome codes (kiosk/src/labelgen/plan.ts): `ok`, or why there is no label. */
const val OUTCOME_OK = "ok"
const val NO_TEMPLATE_AT_DPI = "no_template_at_dpi"
const val TEMPLATE_FAILED = "template_failed"
const val TEMPLATE_UNSUPPORTED = "template_unsupported"

enum class LabelBuildPhase { IDLE, RUNNING, DONE, UNSUPPORTED_DEVICE, ERROR }

/** What a build is waiting for before it can make labels: a saved printer (its DPI picks the
 *  template), or a sync that brings the move's label data (none since the version 2 upgrade). */
enum class LabelBuildNeed { PRINTER, SYNC }

/**
 * The on-device label build. [total] is how many labels this build renders (only assets whose
 * inputs changed) and [done] how many of them are finished. [ready] counts the move's assets
 * whose current label prints; [problems] counts the others by outcome code. [notes] are the
 * template pick's notes (a template only at another DPI). [templateId], [fonts] and
 * [availableDpis] come from the plan for Printer Setup's checks. [error] says why a build failed.
 */
data class LabelBuildStatus(
    val phase: LabelBuildPhase = LabelBuildPhase.IDLE,
    val done: Int = 0,
    val total: Int = 0,
    val ready: Int = 0,
    val problems: Map<String, Int> = emptyMap(),
    val notes: List<String> = emptyList(),
    val needs: LabelBuildNeed? = null,
    val templateId: String? = null,
    val fonts: List<String> = emptyList(),
    val availableDpis: List<Int> = emptyList(),
    val error: String? = null,
) {
    /** 0..1 for a progress bar; a finished build with nothing to render is complete. */
    val progress: Float
        get() = when {
            total > 0 -> done.coerceIn(0, total).toFloat() / total
            phase == LabelBuildPhase.DONE -> 1f
            else -> 0f
        }
}

data class LabelTally(val ready: Int, val problems: Map<String, Int>)

/** Ready labels and the rest counted by outcome. */
fun tallyOutcomes(outcomes: Iterable<String>): LabelTally {
    var ready = 0
    val problems = LinkedHashMap<String, Int>()
    for (o in outcomes) {
        if (o == OUTCOME_OK) ready++ else problems[o] = (problems[o] ?: 0) + 1
    }
    return LabelTally(ready, problems)
}
