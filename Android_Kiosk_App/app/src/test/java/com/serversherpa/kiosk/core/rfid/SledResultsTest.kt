package com.serversherpa.kiosk.core.rfid

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The result classifier and what the adapter does with each class (spec, Settings push and the result classifier). */
class SledResultsTest {
    private fun named(name: String?, message: String? = null) = VendorError(name, message)

    /** Every result name the spec's classifier, perform and connect tables name. */
    private val tableNames = listOf(
        "RFID_API_COMMAND_TIMEOUT",
        "RFID_COMM_SEND_ERROR",
        "RFID_COMM_NO_CONNECTION",
        "RFID_API_UNKNOWN_ERROR",
        "RFID_API_LOCK_ACQUIRE_FAILURE",
        "RFID_READER_REGION_NOT_CONFIGURED",
        "RFID_BATCHMODE_IN_PROGRESS",
        "RFID_OPERATION_IN_PROGRESS",
        "RFID_CHARGING_COMMAND_NOT_ALLOWED",
        "RFID_CONNECTION_PASSWORD_ERROR",
        "RFID_COMM_OPEN_ERROR",
        "RFID_RECONNECT_FAILED",
    )

    /** Thrown by a scripted setting step, carrying the vendor error it stands for (null: not a vendor error). */
    private class StepFailure(val error: VendorError?) : RuntimeException()

    private fun errorOf(t: Throwable): VendorError? = (t as? StepFailure)?.error

    @Test fun theClassifierSortsEveryNamedResult() {
        for (name in listOf("RFID_API_COMMAND_TIMEOUT", "RFID_COMM_SEND_ERROR", "RFID_COMM_NO_CONNECTION")) {
            assertEquals(name, ResultClass.LINK_TROUBLE, classifyResult(named(name)))
        }
        assertEquals(ResultClass.OUT_OF_STEP, classifyResult(named("RFID_API_LOCK_ACQUIRE_FAILURE")))
        assertEquals(ResultClass.REFUSAL, classifyResult(named("RFID_READER_REGION_NOT_CONFIGURED")))
        assertEquals(ResultClass.REFUSAL, classifyResult(named(null)))
    }

    @Test fun unknownErrorIsOutOfStepOnlyWithTheExactVendorText() {
        assertEquals(ResultClass.OUT_OF_STEP, classifyResult(named("RFID_API_UNKNOWN_ERROR", "Unknown error")))
        assertEquals(ResultClass.REFUSAL, classifyResult(named("RFID_API_UNKNOWN_ERROR", "Unknown error occurred")))
        assertEquals(ResultClass.REFUSAL, classifyResult(named("RFID_API_UNKNOWN_ERROR", null)))
    }

    @Test fun invalidUsageIsARefusal() {
        assertEquals(ResultClass.REFUSAL, classifyResult(VendorError(null, "bad argument", invalidUsage = true)))
        // Even when it carries a name that would otherwise be link trouble.
        assertEquals(
            ResultClass.REFUSAL,
            classifyResult(VendorError("RFID_API_COMMAND_TIMEOUT", null, invalidUsage = true)),
        )
    }

    @Test fun everyPerformRowGivesItsOutcome() {
        assertEquals(PerformOutcome.STARTED, performOutcome(null))
        assertEquals(PerformOutcome.UNCONFIRMED, performOutcome(named("RFID_API_COMMAND_TIMEOUT")))
        assertEquals(PerformOutcome.UNCONFIRMED, performOutcome(named("RFID_API_UNKNOWN_ERROR", "Unknown error")))
        assertEquals(PerformOutcome.REFUSED, performOutcome(named("RFID_API_UNKNOWN_ERROR", "Something else")))
        assertEquals(PerformOutcome.BATCH_MODE, performOutcome(named("RFID_BATCHMODE_IN_PROGRESS")))
        assertEquals(PerformOutcome.ALREADY_RUNNING, performOutcome(named("RFID_OPERATION_IN_PROGRESS")))
        assertEquals(PerformOutcome.CHARGING, performOutcome(named("RFID_CHARGING_COMMAND_NOT_ALLOWED")))
        assertEquals(PerformOutcome.NOT_SENT, performOutcome(named("RFID_API_LOCK_ACQUIRE_FAILURE")))
        assertEquals(PerformOutcome.NOT_SENT, performOutcome(named("RFID_COMM_SEND_ERROR")))
        assertEquals(PerformOutcome.REFUSED, performOutcome(named("RFID_READER_REGION_NOT_CONFIGURED")))
        assertEquals(PerformOutcome.REFUSED, performOutcome(VendorError(null, "bad", invalidUsage = true)))

        val succeeding = setOf(PerformOutcome.STARTED, PerformOutcome.UNCONFIRMED, PerformOutcome.ALREADY_RUNNING)
        for (outcome in PerformOutcome.entries) {
            assertEquals(outcome.name, outcome in succeeding, outcome.startSucceeds())
            val expected = when {
                outcome in succeeding -> null
                outcome == PerformOutcome.CHARGING -> SledWords.CHARGING
                else -> SledWords.READ_DID_NOT_START
            }
            assertEquals(outcome.name, expected, outcome.sentence())
        }
    }

    @Test fun twoLinkTroublesInARowMarkTheLinkLost() {
        val tracker = LinkTroubleTracker()
        assertFalse(tracker.record(ResultClass.LINK_TROUBLE))
        assertTrue(tracker.record(ResultClass.LINK_TROUBLE))

        val reset = LinkTroubleTracker()
        assertFalse(reset.record(ResultClass.LINK_TROUBLE))
        assertFalse(reset.record(null))
        assertFalse(reset.record(ResultClass.LINK_TROUBLE))
        assertFalse(reset.record(ResultClass.REFUSAL))
        assertFalse(reset.record(ResultClass.LINK_TROUBLE))
        assertFalse(reset.record(ResultClass.OUT_OF_STEP))
        assertFalse(reset.record(ResultClass.LINK_TROUBLE))
        assertTrue(reset.record(ResultClass.LINK_TROUBLE))
    }

    @Test fun aRefusedStepDoesNotStopThePushAndIsNamed() {
        val ran = mutableListOf<String>()
        val steps = listOf(
            SettingStep(SledWords.ROW_SLED_BEEPER) {
                ran += "beeper"
                throw StepFailure(named("RFID_API_PARAM_OUT_OF_RANGE"))
            },
            SettingStep(SledWords.ROW_TRANSMIT_POWER) { ran += "power" },
        )
        val outcome = runSettingSteps(steps, ::errorOf)
        assertEquals(PushOutcome.Refused(listOf("Sled beeper"), othersApplied = true), outcome)
        assertEquals(listOf("beeper", "power"), ran)
        assertEquals("The sled didn't accept: sled beeper. The other settings were applied.", outcome.message())

        // A throwable that is not a vendor error is a refusal too; an out-of-step step is retried once.
        var tries = 0
        val mixed = listOf(
            SettingStep(SledWords.ROW_TAG_POPULATION) { throw IllegalStateException("not vendor") },
            SettingStep(SledWords.ROW_DPO) {
                tries++
                if (tries == 1) throw StepFailure(named("RFID_API_LOCK_ACQUIRE_FAILURE"))
            },
        )
        assertEquals(PushOutcome.Refused(listOf("Tag population"), othersApplied = true), runSettingSteps(mixed, ::errorOf))
        assertEquals(2, tries)

        assertEquals(PushOutcome.Applied, runSettingSteps(listOf(SettingStep("x") {}), ::errorOf))
        assertNull(PushOutcome.Applied.message())
    }

    @Test fun linkTroubleStopsThePush() {
        val ran = mutableListOf<String>()
        val steps = listOf(
            SettingStep(SledWords.ROW_SLED_BEEPER) { ran += "beeper" },
            SettingStep(SledWords.ROW_TRANSMIT_POWER) {
                ran += "power"
                throw StepFailure(named("RFID_API_COMMAND_TIMEOUT"))
            },
            SettingStep(SledWords.ROW_SESSION) { ran += "session" },
        )
        val outcome = runSettingSteps(steps, ::errorOf)
        assertEquals(PushOutcome.LinkTrouble, outcome)
        assertEquals(listOf("beeper", "power"), ran)
        assertEquals(SledWords.PUSH_STOPPED, outcome.message())
    }

    @Test fun everyStepRefusedSaysNoOthersWereApplied() {
        val steps = listOf(
            SettingStep(SledWords.ROW_SLED_BEEPER) { throw StepFailure(named("RFID_API_PARAM_OUT_OF_RANGE")) },
            SettingStep(SledWords.ROW_TRANSMIT_POWER) { throw StepFailure(VendorError(null, "bad", invalidUsage = true)) },
            // A second out-of-step answer on the same step is a refusal.
            SettingStep(SledWords.ROW_UNIQUE) { throw StepFailure(named("RFID_API_UNKNOWN_ERROR", "Unknown error")) },
        )
        val outcome = runSettingSteps(steps, ::errorOf)
        assertEquals(
            PushOutcome.Refused(listOf("Sled beeper", "Transmit power", "Report each tag once"), othersApplied = false),
            outcome,
        )
        assertEquals(
            "The sled didn't accept: sled beeper, transmit power, and report each tag once.",
            outcome.message(),
        )
    }

    @Test fun everyConnectFailureReasonIsASledWordsSentence() {
        val retryableNames = setOf("RFID_COMM_OPEN_ERROR", "RFID_COMM_SEND_ERROR", "RFID_API_COMMAND_TIMEOUT")
        val constants = setOf(SledWords.CLASS_LOADING, SledWords.PASSWORD)
        val names = listOf("RFD40+_1234", null)
        for (name in names) {
            for (several in listOf(false, true)) {
                val reach = SledWords.couldNotReach(name, several)
                val cases = tableNames.map { it to named(it, "vendor text") } +
                    listOf<Pair<String?, VendorError?>>(null to null, null to VendorError(null, "bad", invalidUsage = true))
                for ((resultName, error) in cases) {
                    val failed = connectFailure(error, name, several, classLoading = false)
                    assertTrue("$resultName: ${failed.reason}", failed.reason in constants || failed.reason == reach)
                    assertEquals("$resultName: ${failed.reason}", emptyList<String>(), sledWordsViolations(failed.reason))
                    assertEquals("$resultName retryable", resultName in retryableNames, failed.retryable)
                    when (resultName) {
                        "RFID_CONNECTION_PASSWORD_ERROR" -> {
                            assertEquals(SledWords.PASSWORD, failed.reason)
                            assertNull(failed.fix)
                        }
                        else -> {
                            assertEquals(reach, failed.reason)
                            assertEquals(SledFix.CONNECT, failed.fix)
                        }
                    }
                }
                // Class loading wins over whatever result came with it.
                for (error in listOf(null, named("RFID_COMM_OPEN_ERROR"))) {
                    val loading = connectFailure(error, name, several, classLoading = true)
                    assertEquals(RfidConnection.Failed(SledWords.CLASS_LOADING, retryable = false, fix = null), loading)
                    assertEquals(emptyList<String>(), sledWordsViolations(loading.reason))
                }
            }
        }
        assertEquals(
            RfidConnection.Failed(SledWords.couldNotReach("RFD40+_1234", true), retryable = false, fix = SledFix.CONNECT),
            connectFailure(named("RFID_RECONNECT_FAILED"), "RFD40+_1234", severalPaired = true, classLoading = false),
        )
    }

    @Test fun theLogLineCarriesTheResultNameAndVendorMessage() {
        val line = vendorLogLine("setHandheldEvent", VendorError("RFID_API_COMMAND_TIMEOUT", "Command timed out"))
        assertTrue(line, line.contains("setHandheldEvent"))
        assertTrue(line, line.contains("RFID_API_COMMAND_TIMEOUT"))
        assertTrue(line, line.contains("Command timed out"))

        val usage = vendorLogLine("setAttribute", VendorError(null, "bad digits", invalidUsage = true))
        assertTrue(usage, usage.contains("setAttribute"))
        assertTrue(usage, usage.contains("bad digits"))
        assertTrue(usage, usage.contains("invalid usage"))
    }

    @Test fun stopSettlesOnTheStopEventAndAQuietGapOrAfter500ms() {
        assertFalse(stopSettled(sinceStopMs = 50, stopEventSeen = false, sinceLastTagMs = 400))
        assertFalse(stopSettled(sinceStopMs = 50, stopEventSeen = true, sinceLastTagMs = 99))
        assertTrue(stopSettled(sinceStopMs = 50, stopEventSeen = true, sinceLastTagMs = 100))
        assertFalse(stopSettled(sinceStopMs = 499, stopEventSeen = false, sinceLastTagMs = 499))
        assertTrue(stopSettled(sinceStopMs = 500, stopEventSeen = false, sinceLastTagMs = 0))
        assertTrue(stopSettled(sinceStopMs = 500, stopEventSeen = true, sinceLastTagMs = 0))
    }
}
