package com.serversherpa.kiosk.core.rfid

/**
 * A failed vendor call, reduced to what the app decides on: the vendor's
 * result name (for example `RFID_API_COMMAND_TIMEOUT`), its own message, and
 * whether the call threw the SDK's invalid-usage exception. None of it is
 * ever shown to an operator; it goes to the log through [vendorLogLine].
 */
data class VendorError(val resultName: String?, val vendorMessage: String?, val invalidUsage: Boolean = false)

/** How the adapter treats a [VendorError] (spec, the result classifier). */
enum class ResultClass {
    /** The sled may not be hearing the app: a push stops, and two in a row mark the link lost. */
    LINK_TROUBLE,

    /** The sled and the SDK disagreed about the command in flight: retry that step once. */
    OUT_OF_STEP,

    /** The sled said no: logged, the push goes on, and the failure names the setting. */
    REFUSAL,
}

private const val COMMAND_TIMEOUT = "RFID_API_COMMAND_TIMEOUT"
private const val SEND_ERROR = "RFID_COMM_SEND_ERROR"
private const val NO_CONNECTION = "RFID_COMM_NO_CONNECTION"
private const val OPEN_ERROR = "RFID_COMM_OPEN_ERROR"
private const val UNKNOWN_ERROR = "RFID_API_UNKNOWN_ERROR"
private const val LOCK_ACQUIRE_FAILURE = "RFID_API_LOCK_ACQUIRE_FAILURE"
private const val BATCH_MODE_IN_PROGRESS = "RFID_BATCHMODE_IN_PROGRESS"
private const val OPERATION_IN_PROGRESS = "RFID_OPERATION_IN_PROGRESS"
private const val CHARGING_NOT_ALLOWED = "RFID_CHARGING_COMMAND_NOT_ALLOWED"
private const val PASSWORD_ERROR = "RFID_CONNECTION_PASSWORD_ERROR"

/** The vendor message that, with [UNKNOWN_ERROR], means "out of step", matched exactly. */
private const val UNKNOWN_ERROR_TEXT = "Unknown error"

private val LINK_TROUBLE_RESULTS = setOf(COMMAND_TIMEOUT, SEND_ERROR, NO_CONNECTION)

/** Connect results that waiting and trying again can fix. */
private val RETRYABLE_CONNECT_RESULTS = setOf(OPEN_ERROR, SEND_ERROR, COMMAND_TIMEOUT)

private fun VendorError.isUnknownErrorOutOfStep(): Boolean =
    resultName == UNKNOWN_ERROR && vendorMessage == UNKNOWN_ERROR_TEXT

/** Sorts [error] into its [ResultClass]. Every invalid-usage error is a refusal. */
fun classifyResult(error: VendorError): ResultClass = when {
    error.invalidUsage -> ResultClass.REFUSAL
    error.resultName in LINK_TROUBLE_RESULTS -> ResultClass.LINK_TROUBLE
    error.isUnknownErrorOutOfStep() || error.resultName == LOCK_ACQUIRE_FAILURE -> ResultClass.OUT_OF_STEP
    else -> ResultClass.REFUSAL
}

/** What a `perform()` (inventory start) result means (spec, the `perform()` outcome table). */
enum class PerformOutcome {
    STARTED,

    /** Sent, not confirmed: the start status may ride on the first tag. */
    UNCONFIRMED,

    /** The sled is reading into its own store. */
    BATCH_MODE,

    /** An inventory is already running (the sled's own start trigger). */
    ALREADY_RUNNING,

    /** The sled is on its charger. */
    CHARGING,

    /** The start never left the phone. */
    NOT_SENT,

    /** Any other sled status. */
    REFUSED,
}

/** The [PerformOutcome] of a start that returned [error] (null: it returned normally). */
fun performOutcome(error: VendorError?): PerformOutcome = when {
    error == null -> PerformOutcome.STARTED
    error.invalidUsage -> PerformOutcome.REFUSED
    error.resultName == COMMAND_TIMEOUT || error.isUnknownErrorOutOfStep() -> PerformOutcome.UNCONFIRMED
    error.resultName == BATCH_MODE_IN_PROGRESS -> PerformOutcome.BATCH_MODE
    error.resultName == OPERATION_IN_PROGRESS -> PerformOutcome.ALREADY_RUNNING
    error.resultName == CHARGING_NOT_ALLOWED -> PerformOutcome.CHARGING
    error.resultName == LOCK_ACQUIRE_FAILURE || error.resultName == SEND_ERROR -> PerformOutcome.NOT_SENT
    else -> PerformOutcome.REFUSED
}

/** True for the outcomes the adapter reports as a started read. */
fun PerformOutcome.startSucceeds(): Boolean =
    this == PerformOutcome.STARTED || this == PerformOutcome.UNCONFIRMED || this == PerformOutcome.ALREADY_RUNNING

/** The sentence a failed start carries; null for the outcomes that succeed. */
fun PerformOutcome.sentence(): String? = when {
    startSucceeds() -> null
    this == PerformOutcome.CHARGING -> SledWords.CHARGING
    else -> SledWords.READ_DID_NOT_START
}

/**
 * Counts link-trouble results in a row, from any block. [record] returns true
 * once two have come in a row (the link is then lost); any other class, or
 * null for a call that succeeded, starts the count again.
 */
class LinkTroubleTracker {
    private var inARow = 0

    @Synchronized
    fun record(cls: ResultClass?): Boolean {
        if (cls != ResultClass.LINK_TROUBLE) {
            inARow = 0
            return false
        }
        inARow++
        return inARow >= 2
    }
}

/** One step of a settings push: [label] is its RFID tab row label, [run] the vendor calls, which throw on failure. */
class SettingStep(val label: String, val run: () -> Unit)

/** How a settings push ended. */
sealed interface PushOutcome {
    data object Applied : PushOutcome

    /** The sled refused the steps named by [labels]; [othersApplied] is false when it refused every step. */
    data class Refused(val labels: List<String>, val othersApplied: Boolean) : PushOutcome

    /** The push stopped at link trouble; later steps did not run. */
    data object LinkTrouble : PushOutcome
}

/**
 * Runs every step in order. [errorOf] turns a step's throwable into its
 * [VendorError], or null when it is not a vendor error (which counts as a
 * refusal). An out-of-step result retries that step once, and a second one
 * counts as a refusal; a refusal records the step's label and goes on; link
 * trouble stops the push at once.
 */
fun runSettingSteps(steps: List<SettingStep>, errorOf: (Throwable) -> VendorError?): PushOutcome {
    val refused = mutableListOf<String>()
    for (step in steps) {
        var retried = false
        while (true) {
            val cls = try {
                step.run()
                null
            } catch (t: Throwable) {
                errorOf(t)?.let(::classifyResult) ?: ResultClass.REFUSAL
            }
            when {
                cls == null -> break
                cls == ResultClass.LINK_TROUBLE -> return PushOutcome.LinkTrouble
                cls == ResultClass.OUT_OF_STEP && !retried -> retried = true
                else -> {
                    refused += step.label
                    break
                }
            }
        }
    }
    return if (refused.isEmpty()) PushOutcome.Applied else PushOutcome.Refused(refused, refused.size < steps.size)
}

/** The sentence a push outcome shows: the refused settings, the stopped push, or null when all applied. */
fun PushOutcome.message(): String? = when (this) {
    PushOutcome.Applied -> null
    is PushOutcome.Refused -> SledWords.refused(labels, othersApplied)
    PushOutcome.LinkTrouble -> SledWords.PUSH_STOPPED
}

/**
 * The failure a connect publishes for [error] (null: no vendor result).
 * [name] is the chosen sled's name; [severalPaired] adds how to choose
 * another one; [classLoading] means the SDK's classes could not load. Only an
 * open error, a send error or a command timeout is retryable.
 */
fun connectFailure(error: VendorError?, name: String?, severalPaired: Boolean, classLoading: Boolean): RfidConnection.Failed {
    val result = error?.resultName.takeUnless { error?.invalidUsage == true }
    return when {
        classLoading -> RfidConnection.Failed(SledWords.CLASS_LOADING, retryable = false, fix = null)
        result == PASSWORD_ERROR -> RfidConnection.Failed(SledWords.PASSWORD, retryable = false, fix = null)
        else -> RfidConnection.Failed(
            SledWords.couldNotReach(name, severalPaired),
            retryable = result in RETRYABLE_CONNECT_RESULTS,
            fix = SledFix.CONNECT,
        )
    }
}

/** The log line for a failed vendor call at [step]: the result name and the vendor's own text. Never shown. */
fun vendorLogLine(step: String, error: VendorError): String {
    val usage = if (error.invalidUsage) " (invalid usage)" else ""
    return "$step failed: ${error.resultName ?: "no result name"}$usage — ${error.vendorMessage ?: "no vendor message"}"
}

/** Longest the adapter waits after `Inventory.stop()` returns. */
private const val STOP_SETTLE_MAX_MS = 500L

/** Quiet gap with no tag, after the stop event, that ends the wait early. */
private const val STOP_SETTLE_QUIET_MS = 100L

/**
 * Whether a stop has settled: [STOP_SETTLE_MAX_MS] since the stop returned,
 * or the stop event has arrived and no tag has been emitted for
 * [STOP_SETTLE_QUIET_MS].
 */
fun stopSettled(sinceStopMs: Long, stopEventSeen: Boolean, sinceLastTagMs: Long): Boolean =
    sinceStopMs >= STOP_SETTLE_MAX_MS || (stopEventSeen && sinceLastTagMs >= STOP_SETTLE_QUIET_MS)
