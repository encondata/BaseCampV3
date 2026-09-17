package com.serversherpa.kiosk.input.rfid

import android.content.Context
import android.util.Log
import com.zebra.scannercontrol.DCSSDKDefs.DCSSDK_COMMAND_OPCODE
import com.zebra.scannercontrol.DCSSDKDefs.DCSSDK_EVENT
import com.zebra.scannercontrol.DCSSDKDefs.DCSSDK_MODE
import com.zebra.scannercontrol.DCSSDKDefs.DCSSDK_RESULT
import com.zebra.scannercontrol.DCSScannerInfo
import com.zebra.scannercontrol.FirmwareUpdateEvent
import com.zebra.scannercontrol.IDcsSdkApiDelegate
import com.zebra.scannercontrol.SDKHandler

/**
 * The second file in this app that knows `com.zebra` exists — see
 * [ZebraRfidReader]'s class doc for the "only file" rule this used to be,
 * and `CorePurityTest.onlyDesignatedFilesImportTheZebraSdk` (renamed from
 * `onlyZebraRfidReaderImportsTheZebraSdk`) for where the two-file version of
 * that rule is now enforced.
 *
 * [ZebraRfidReader] talks to `com.zebra.rfid.api3`, the RFID radio. This
 * file talks to a completely different Zebra SDK, `com.zebra.scannercontrol`
 * — confirmed present in the same bundled `API3_LIB-release.aar` via
 * `javap` — because the RFID radio and the sled's barcode imager are two
 * separate devices inside one RFD40 housing, each with its own SDK. The bug
 * this file exists to fix: on a real RFD40-to-Pixel pairing, a trigger pull
 * starts an RFID sweep *and* fires the imager, which injects decoded barcode
 * text into whatever has focus and corrupts the sweep.
 * `Config.setTriggerMode(RFID_MODE, ...)` — the RFID SDK's own trigger
 * personality switch, see [ZebraRfidReader.configureTriggerMode] — does not
 * stop this: that flag is accepted by the radio, but the imager is not the
 * radio, and the `updateScannerPlugin` half of that call concerns the
 * host's DataWedge plugin, which a bare Pixel does not have. The only other
 * lever this device exposes is the scanner SDK's own scan-disable opcode,
 * sent to the imager directly — which is what [standDown] does.
 *
 * This is deliberately small and does exactly one job for now: stand the
 * imager down so it stops firing. It does not yet read barcodes back out —
 * [IDcsSdkApiDelegate.dcssdkEventBarcode] is implemented so the delegate
 * never throws, and its log line is the one place today that can prove
 * whether the imager is reachable through this SDK at all, but nothing
 * currently reads its payload. That is deliberately separate work; see this
 * file's own follow-up note in `.superpowers/sdd/barcode-engine-report.md`
 * for what the later read-mode switch will need from here (at minimum: a
 * way to re-enable the imager and route [IDcsSdkApiDelegate.dcssdkEventBarcode]
 * out to something that delivers the text, instead of only logging it).
 *
 * One instance is built fresh per RFID connection — see
 * [ZebraRfidReader.standDownBarcodeImager] — and torn down by [tearDown]
 * when that connection ends, the same "new vendor object per connect" shape
 * [ZebraRfidReader] itself uses for `Readers`/`RFIDReader`. [standDown] and
 * [tearDown] are the whole lifecycle; there is no `apply()`/settings push
 * here yet.
 *
 * Every vendor call is wrapped so this class can never throw out of
 * [standDown] or [tearDown] — a `LinkageError` alongside `Exception`, the
 * same belt-and-braces guard [ZebraRfidReader] uses for its own vendor
 * calls, since this `.aar` is wired in the same raw, unverified way (see
 * that class's doc). [standDown] failing must never fail the RFID
 * connection it runs alongside: reading tags has to keep working even if
 * this part cannot reach the imager at all, which — on a bare Pixel with no
 * DataWedge — is the one thing this whole file exists to find out.
 *
 * The SDK's callbacks in [delegate] arrive on the vendor's own thread(s),
 * exactly like [ZebraRfidReader.listener] — see that class's doc for why
 * calling back into the SDK from inside a callback, or blocking one, is not
 * allowed. None of the methods implemented here do either; most are
 * deliberately empty because nothing in this app consumes their payload
 * yet.
 *
 * Every step below is logged at warning level with the `ZebraBarcodeEngine`
 * tag — the operational mode set, how many scanners were found and their
 * names/models/serials/ids, which one was chosen and on what basis, the
 * result of establishing the session, and the result of the scan-disable/
 * scan-enable opcodes including any XML the SDK hands back — because,
 * exactly as with [ZebraRfidReader]'s batch-mode recovery and trigger-mode
 * setup, that logging is how the team finds out whether any of this
 * actually works on a phone; nobody on this team has seen Zebra's own
 * account of what a host is supposed to do with this SDK either.
 */
open class ZebraBarcodeEngine(private val context: Context) {
    private var sdkHandler: SDKHandler? = null
    private var scannerId: Int? = null

    /** Every method must exist and must not throw — the vendor calls back on
     *  its own thread(s), and [ZebraRfidReader]'s class doc's "never call
     *  back into the SDK, never block its thread" rule applies here too.
     *  Only [dcssdkEventBarcode] does anything beyond logging-or-nothing
     *  today: it is the one signal available, right now, for whether the
     *  imager is still reachable/firing through this SDK session at all —
     *  see the class doc. The others are wired up because the interface
     *  requires them and a future no-op turning into an accidental crash is
     *  exactly the kind of bug this file's careful wrapping elsewhere is
     *  trying to avoid; there is nothing yet for this app to do with an
     *  image, a video, a firmware-update event, or an auxiliary scanner. */
    private val delegate = object : IDcsSdkApiDelegate {
        override fun dcssdkEventScannerAppeared(scanner: DCSScannerInfo?) {
            Log.w(TAG, "Scanner appeared: ${scanner.describe()}.")
        }

        override fun dcssdkEventScannerDisappeared(scannerId: Int) {
            Log.w(TAG, "Scanner disappeared: id=$scannerId.")
        }

        override fun dcssdkEventCommunicationSessionEstablished(scanner: DCSScannerInfo?) {
            Log.w(TAG, "Communication session established (delegate callback): ${scanner.describe()}.")
        }

        override fun dcssdkEventCommunicationSessionTerminated(scannerId: Int) {
            Log.w(TAG, "Communication session terminated (delegate callback): id=$scannerId.")
        }

        override fun dcssdkEventBarcode(barcode: ByteArray?, type: Int, fromScannerId: Int) {
            // Not delivered anywhere yet — see the class doc. This log line
            // is the main unknown this file exists to answer: whether the
            // imager is reachable through the scanner SDK at all, and
            // whether the scan-disable opcode actually stops it from firing.
            Log.w(
                TAG,
                "Barcode event received via the SDK session from scanner $fromScannerId " +
                    "(length=${barcode?.size ?: 0}, type=$type). Not delivered anywhere yet.",
            )
        }

        override fun dcssdkEventImage(image: ByteArray?, scannerId: Int) = Unit

        override fun dcssdkEventVideo(video: ByteArray?, scannerId: Int) = Unit

        override fun dcssdkEventBinaryData(data: ByteArray?, scannerId: Int) = Unit

        override fun dcssdkEventFirmwareUpdate(event: FirmwareUpdateEvent?) = Unit

        override fun dcssdkEventAuxScannerAppeared(auxScanner: DCSScannerInfo?, parentScanner: DCSScannerInfo?) = Unit
    }

    /**
     * Stands the sled's barcode imager down: builds an `SDKHandler`, puts it
     * in the operational mode a Bluetooth sled needs, wires up [delegate],
     * subscribes to the events this file cares about, finds the sled among
     * the scanners the SDK reports (via [chooseScanner]), opens a
     * communication session with it, and sends the
     * `DCSSDK_DEVICE_SCAN_DISABLE` opcode.
     *
     * Returns an operator-facing sentence — via [imagerStandDownNote] — for
     * every outcome, success included, the same "say what happened, not
     * only what went wrong" idiom
     * [ZebraRfidReader.configureTriggerMode]/[ZebraRfidReader.connectNote]
     * already use. Never throws: see the class doc for why a failure here
     * must never fail the RFID connect it runs alongside.
     */
    fun standDown(): String {
        val outcome = try {
            attemptStandDown()
        } catch (e: LinkageError) {
            Log.w(TAG, "Barcode engine unreachable: ${e.javaClass.name}.", e)
            ImagerStandDownOutcome.Unreachable(e.message ?: e.javaClass.simpleName)
        } catch (e: Exception) {
            Log.w(TAG, "Barcode engine unreachable: ${e.javaClass.name}.", e)
            ImagerStandDownOutcome.Unreachable(e.message ?: e.javaClass.simpleName)
        }
        return imagerStandDownNote(outcome)
    }

    private fun attemptStandDown(): ImagerStandDownOutcome {
        val handler = SDKHandler(context)
        sdkHandler = handler

        // BT_NORMAL is classic Bluetooth (SSI over RFCOMM/SPP) — the same
        // transport ZebraRfidReader's own RFID connect() uses to reach this
        // sled (see that class's connect() doc); DCSSDK_OPMODE_BT_LE is for
        // a BLE-only scanner, which an RFD40 paired the classic way is not.
        // Not documented Zebra behavior — an inference from the transport
        // ZebraRfidReader already uses successfully — so the result is
        // logged rather than assumed silently correct.
        val modeResult = handler.dcssdkSetOperationalMode(DCSSDK_MODE.DCSSDK_OPMODE_BT_NORMAL)
        Log.w(TAG, "Barcode engine: dcssdkSetOperationalMode(DCSSDK_OPMODE_BT_NORMAL) returned $modeResult.")

        handler.dcssdkSetDelegate(delegate)

        val eventMask = DCSSDK_EVENT.DCSSDK_EVENT_SCANNER_APPEARANCE.value or
            DCSSDK_EVENT.DCSSDK_EVENT_SCANNER_DISAPPEARANCE.value or
            DCSSDK_EVENT.DCSSDK_EVENT_SESSION_ESTABLISHMENT.value or
            DCSSDK_EVENT.DCSSDK_EVENT_SESSION_TERMINATION.value or
            DCSSDK_EVENT.DCSSDK_EVENT_BARCODE.value
        val subscribeResult = handler.dcssdkSubsribeForEvents(eventMask)
        Log.w(TAG, "Barcode engine: dcssdkSubsribeForEvents($eventMask) returned $subscribeResult.")

        val available = runCatching { handler.dcssdkGetAvailableScannersList() }.getOrNull().orEmpty()
        val active = runCatching { handler.dcssdkGetActiveScannersList() }.getOrNull().orEmpty()
        Log.w(
            TAG,
            "Barcode engine: ${available.size} available scanner(s): ${available.describeAll()}; " +
                "${active.size} active scanner(s): ${active.describeAll()}.",
        )

        // Active scanners first: a scanner already active is a stronger
        // signal than one merely available, and de-duplicated by id so a
        // scanner present in both lists is not logged/considered twice.
        val candidates = (active + available).map { it.toCandidate() }.distinctBy { it.scannerId }
        val chosen = chooseScanner(candidates)
        if (chosen == null) {
            Log.w(TAG, "Barcode engine: no scanner found via the scanner SDK; the imager cannot be reached this way.")
            return ImagerStandDownOutcome.NoScannerFound
        }
        Log.w(
            TAG,
            "Barcode engine: chose scanner id=${chosen.scannerId} name=${chosen.name} model=${chosen.model} " +
                "serial=${chosen.serial} — ${candidates.size} candidate(s) total, first taken (see the line " +
                "above for every candidate this kiosk saw).",
        )
        scannerId = chosen.scannerId

        val sessionResult = handler.dcssdkEstablishCommunicationSession(chosen.scannerId)
        Log.w(TAG, "Barcode engine: dcssdkEstablishCommunicationSession(${chosen.scannerId}) returned $sessionResult.")
        if (sessionResult != DCSSDK_RESULT.DCSSDK_RESULT_SUCCESS) {
            return ImagerStandDownOutcome.SessionFailed(sessionResult.name)
        }

        val outXml = StringBuilder()
        val commandResult = handler.dcssdkExecuteCommandOpCodeInXMLForScanner(
            DCSSDK_COMMAND_OPCODE.DCSSDK_DEVICE_SCAN_DISABLE,
            scanCommandInXml(),
            outXml,
            chosen.scannerId,
        )
        Log.w(
            TAG,
            "Barcode engine: DCSSDK_DEVICE_SCAN_DISABLE for scanner ${chosen.scannerId} returned $commandResult, " +
                "outXML=\"$outXml\".",
        )
        return if (commandResult == DCSSDK_RESULT.DCSSDK_RESULT_SUCCESS) {
            ImagerStandDownOutcome.Silenced
        } else {
            ImagerStandDownOutcome.CommandFailed(commandResult.name)
        }
    }

    /**
     * Tears down whatever [standDown] built. Re-enables the imager first,
     * best-effort, before terminating the session and closing the handler —
     * see [ZebraRfidReader.disconnectBlocking]'s call site and this file's
     * own report for why: the sled is shared hardware, and the kiosk is not
     * the only thing that will ever be connected to it. Leaving the scan
     * engine disabled after this app lets go would surprise whatever
     * connects next (Zebra's own 123RFID Mobile, or a different app
     * expecting the imager to work) with a sled that silently does not
     * scan, for a reason nothing on screen would explain. Best-effort and
     * never throws, exactly like [ZebraRfidReader.disconnectBlocking]'s own
     * teardown steps: a disconnect must finish and clear local state
     * regardless of whether any individual vendor call here succeeds.
     */
    fun tearDown() {
        val handler = sdkHandler ?: return
        val id = scannerId
        if (id != null) {
            try {
                val outXml = StringBuilder()
                val result = handler.dcssdkExecuteCommandOpCodeInXMLForScanner(
                    DCSSDK_COMMAND_OPCODE.DCSSDK_DEVICE_SCAN_ENABLE,
                    scanCommandInXml(),
                    outXml,
                    id,
                )
                Log.w(TAG, "Barcode engine: DCSSDK_DEVICE_SCAN_ENABLE for scanner $id returned $result, outXML=\"$outXml\".")
            } catch (e: Exception) {
                Log.w(TAG, "Barcode engine: re-enabling the imager on teardown threw.", e)
            } catch (e: LinkageError) {
                Log.w(TAG, "Barcode engine: re-enabling the imager on teardown threw.", e)
            }
            try {
                val result = handler.dcssdkTerminateCommunicationSession(id)
                Log.w(TAG, "Barcode engine: dcssdkTerminateCommunicationSession($id) returned $result.")
            } catch (e: Exception) {
                Log.w(TAG, "Barcode engine: terminating the session threw.", e)
            } catch (e: LinkageError) {
                Log.w(TAG, "Barcode engine: terminating the session threw.", e)
            }
        }
        try {
            handler.dcssdkClose()
        } catch (e: Exception) {
            Log.w(TAG, "Barcode engine: dcssdkClose() threw.", e)
        } catch (e: LinkageError) {
            Log.w(TAG, "Barcode engine: dcssdkClose() threw.", e)
        }
        sdkHandler = null
        scannerId = null
    }

    private companion object {
        const val TAG = "ZebraBarcodeEngine"
    }
}

/** Log-friendly one-liner for a possibly-null [DCSScannerInfo] — used by
 *  [ZebraBarcodeEngine.delegate]'s appeared/established callbacks. */
private fun DCSScannerInfo?.describe(): String {
    if (this == null) return "null"
    return "id=${getScannerID()} name=${getScannerName()} model=${getScannerModel()} serial=${getScannerHWSerialNumber()}"
}

private fun List<DCSScannerInfo>.describeAll(): String =
    if (isEmpty()) "none" else joinToString { it.describe() }

private fun DCSScannerInfo.toCandidate() =
    ScannerCandidate(scannerId = getScannerID(), name = getScannerName(), model = getScannerModel(), serial = getScannerHWSerialNumber())

/** What [chooseScanner] picks from — the plain fields of a `DCSScannerInfo`,
 *  pulled out into a value with no `com.zebra.*` type so the selection logic
 *  is testable without one (see [ZebraBarcodeEngineTest]). */
internal data class ScannerCandidate(val scannerId: Int, val name: String?, val model: String?, val serial: String?)

/**
 * Pure selection behind [ZebraBarcodeEngine.attemptStandDown]: which
 * candidate to treat as the sled. This kiosk pairs with exactly one sled at
 * a time, so any candidate the SDK reports is presumably it — picking the
 * first keeps this deterministic without pretending to a matching rule this
 * app has no evidence for. If real hardware ever shows more than one
 * candidate, [ZebraBarcodeEngine.attemptStandDown]'s log line lists every
 * one of them (name, model, serial, id) so a real matching rule — e.g.
 * against the RFID reader's own name — can be written from actual field
 * data instead of a guess made from a desk. `null` only when [candidates] is
 * empty. */
internal fun chooseScanner(candidates: List<ScannerCandidate>): ScannerCandidate? = candidates.firstOrNull()

/** The `dcssdkExecuteCommandOpCodeInXMLForScanner` calls in
 *  [ZebraBarcodeEngine] need no XML body: `DCSSDK_DEVICE_SCAN_DISABLE`/
 *  `DCSSDK_DEVICE_SCAN_ENABLE` take no parameters, and the scanner is
 *  addressed by the `scannerID` int argument, not by anything inside the
 *  XML — so this is always the empty string. Broken out into its own
 *  function, rather than an inline `""` at each of the two call sites, so
 *  there is one name to change if a future opcode needs a real body, and so
 *  a test can pin the value down explicitly instead of trusting two
 *  independent inline literals never to drift apart. */
internal fun scanCommandInXml(): String = ""

/** What [ZebraBarcodeEngine.attemptStandDown] (or the `LinkageError`/
 *  `Exception` guard around it) actually produced, reduced to a plain value
 *  so [imagerStandDownNote] is testable without a real SDK. */
internal sealed interface ImagerStandDownOutcome {
    data object Silenced : ImagerStandDownOutcome
    data object NoScannerFound : ImagerStandDownOutcome
    data class SessionFailed(val result: String) : ImagerStandDownOutcome
    data class CommandFailed(val result: String) : ImagerStandDownOutcome
    data class Unreachable(val detail: String) : ImagerStandDownOutcome
}

/**
 * Pure text behind [ZebraBarcodeEngine.standDown]'s operator-facing note —
 * what the RFID tab shows, via [ZebraRfidReader.connectNote], about whether
 * the sled's barcode imager was actually silenced. Written every time
 * [ZebraBarcodeEngine.standDown] finishes, success included, the same
 * "say what happened, not only what went wrong" idiom
 * [ZebraRfidReader.triggerModeOutcomeNote] uses. Pulled into a plain
 * function over a plain value so it is directly testable, the same way
 * [ZebraRfidReader]'s own note-building functions are.
 */
internal fun imagerStandDownNote(outcome: ImagerStandDownOutcome): String = when (outcome) {
    ImagerStandDownOutcome.Silenced ->
        "The sled's barcode imager was told to stand down."
    ImagerStandDownOutcome.NoScannerFound ->
        "The sled's barcode imager couldn't be reached (no scanner found via the scanner SDK); " +
            "it may still fire on a trigger pull."
    is ImagerStandDownOutcome.SessionFailed ->
        "The sled's barcode imager couldn't be reached (session failed: ${outcome.result}); " +
            "it may still fire on a trigger pull."
    is ImagerStandDownOutcome.CommandFailed ->
        "The sled's barcode imager may still fire on a trigger pull (stand-down command failed: ${outcome.result})."
    is ImagerStandDownOutcome.Unreachable ->
        "The sled's barcode imager couldn't be reached (${outcome.detail}); it may still fire on a trigger pull."
}
