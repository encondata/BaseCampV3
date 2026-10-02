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
import java.util.concurrent.locks.ReentrantLock

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
 *
 * [target] — the RFID reader's own identity, threaded in from
 * [ZebraRfidReader.attemptVendorConnection] — is what [chooseScanner] (via
 * [attemptStandDown]) matches candidates against, so this app connects only
 * to its own sled and never to some other paired Bluetooth device (see
 * [chooseScanner]'s doc for the field evidence this exists to fix). This
 * class is `internal` (rather than the module-default public it used to be
 * before [target] was added) purely so its constructor can take
 * [SledIdentity] — also `internal` — without Kotlin's "public declaration
 * exposes its internal type" check tripping; nothing outside this module
 * ever constructed this class, so the narrower visibility changes nothing
 * observable.
 */
internal open class ZebraBarcodeEngine(private val context: Context, private val target: SledIdentity) {
    // @Volatile because these are written on the dedicated background thread
    // ZebraRfidReader.runBarcodeStandDownWithTimeout() runs attemptStandDown()
    // on, and read/written on whatever thread eventually calls tearDown() —
    // normally the disconnect path's runInterruptible thread. Without this,
    // a tearDown() that runs concurrently with a still-in-flight
    // attemptStandDown() (the exact scenario the Bug 2 timeout fix made
    // newly possible: a timeout lets the background thread keep running
    // instead of being interrupted, so a near-immediate disconnect() can
    // call tearDown() while it is still going) would have no happens-before
    // edge to the background thread's writes and could read a stale/torn
    // value. @Volatile alone doesn't stop the two threads from calling into
    // `handler` at the same time, though — see [vendorCallLock] for that.
    @Volatile
    private var sdkHandler: SDKHandler? = null

    @Volatile
    private var scannerId: Int? = null

    /**
     * Serializes [attemptStandDown]'s and [tearDown]'s vendor-call sections
     * against each other, so the background stand-down thread and whatever
     * thread calls [tearDown] never call into the same `SDKHandler` instance
     * at the same time. Needed for the same reason [sdkHandler]/[scannerId]
     * are `@Volatile`: the Bug 2 fix bounds [attemptStandDown] with a 5s
     * wall-clock timeout but deliberately does not interrupt the background
     * thread when that timeout elapses (see
     * [ZebraRfidReader.runBarcodeStandDownWithTimeout]'s doc for why), so a
     * timed-out attempt can still be mid-call on `handler` — inside
     * `dcssdkEstablishCommunicationSession`/
     * `dcssdkExecuteCommandOpCodeInXMLForScanner` — when a near-immediate
     * `disconnect()` runs [tearDown] concurrently. `RfidController` never
     * serializes `connect()`/`disconnect()` against each other (see that
     * class's own doc), so nothing upstream of this file prevents that
     * overlap either. Two threads calling into the same vendor `.aar`
     * handler at once risks a native/JNI-level crash, not just a logic bug —
     * `@Volatile` alone only fixes visibility, not mutual exclusion.
     *
     * `ReentrantLock`, not `synchronized`: [tearDown] is called from
     * [ZebraRfidReader.disconnectBlocking]'s `teardownStep { barcodeEngine
     * ?.tearDown() }`, itself inside [ZebraRfidReader]'s own
     * `runInterruptible` block — see that class's doc for why a blocking
     * call in there must stay interruptible by `Thread.interrupt()`. A bare
     * Java monitor (`synchronized`) blocks on contention without responding
     * to `Thread.interrupt()`; `ReentrantLock.lockInterruptibly()` does, so
     * [tearDown] uses that instead of `lock()`, and lets the
     * `InterruptedException` propagate uncaught — `teardownStep` already
     * catches it and restores the thread's interrupt flag, the same
     * contract every other teardown step in that function relies on.
     * [attemptStandDown] runs on its own dedicated single-thread executor,
     * not as part of any coroutine's cancellation, so it uses the plain
     * blocking `lock()`: there is no cancellation signal for it to stay
     * responsive to, and using `lockInterruptibly()` there too would gain
     * nothing while adding an exception path this class's "never throws"
     * contract (see the class doc) would just have to wrap right back up.
     */
    private val vendorCallLock = ReentrantLock()

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
        // Held for the whole vendor-call sequence below, through the final
        // DCSSDK_DEVICE_SCAN_DISABLE opcode call — including the
        // chooseScanner()/logging steps in between, which don't touch
        // `handler` themselves but are fast, pure, and bounded, so splitting
        // the lock around them would only reopen a window for a concurrent
        // tearDown() to close `handler` out from under this function
        // partway through — exactly the race [vendorCallLock] exists to
        // close. See that field's doc for the full story.
        vendorCallLock.lock()
        try {
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

            // Active scanners first: a scanner already active is a stronger
            // signal than one merely available, and de-duplicated by id so a
            // scanner present in both lists is not logged/considered twice.
            val candidates = (active + available).map { it.toCandidate() }.distinctBy { it.scannerId }
            // Extends the original "what did the SDK see" log line with the
            // identity being matched against, so a device log shows both halves
            // of the matching decision on one line: everything the SDK reported,
            // and what this app was actually looking for among it.
            Log.w(
                TAG,
                "Barcode engine: ${available.size} available scanner(s): ${available.describeAll()}; " +
                    "${active.size} active scanner(s): ${active.describeAll()}; matching against target identity " +
                    "name=${target.name} address=${target.address} serial=${target.serial}.",
            )
            val chosen = chooseScanner(candidates, target)
            if (chosen == null) {
                // Two distinct real outcomes, both real: no candidates at all
                // (nothing paired, or the SDK saw nothing), versus candidates
                // that just aren't this kiosk's sled (the stranger's-dive-
                // computer case this whole matching rule exists to reject). Both
                // reduce to the same ImagerStandDownOutcome.NotIdentified and
                // the same operator-facing note — "couldn't be identified" is
                // honest either way — but the log lines below say which one
                // actually happened, because that distinction matters for
                // diagnosing a real device.
                if (candidates.isEmpty()) {
                    Log.w(TAG, "Barcode engine: no candidate scanners available at all; the imager could not be identified.")
                } else {
                    Log.w(
                        TAG,
                        "Barcode engine: ${candidates.size} candidate scanner(s) seen but none matched the target " +
                            "identity above; the imager could not be identified. Connecting to any of them would risk " +
                            "reaching a stranger's device, so none will be tried.",
                    )
                }
                return ImagerStandDownOutcome.NotIdentified
            }
            Log.w(
                TAG,
                "Barcode engine: chose scanner id=${chosen.scannerId} name=${chosen.name} model=${chosen.model} " +
                    "serial=${chosen.serial} — matched the target identity among ${candidates.size} candidate(s) " +
                    "total (see the line above for every candidate this kiosk saw and the identity matched against).",
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
        } finally {
            vendorCallLock.unlock()
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
     * never throws *from any individual vendor call* — every
     * `dcssdk*`/`Exception`/`LinkageError` below is still caught and logged,
     * exactly like [ZebraRfidReader.disconnectBlocking]'s own teardown
     * steps, so a disconnect still finishes and clears local state
     * regardless of whether any individual vendor call here succeeds. The
     * one exception (literally): acquiring [vendorCallLock] below via
     * `lockInterruptibly()` can throw `InterruptedException` if this thread
     * is interrupted while waiting for a concurrent [attemptStandDown] to
     * release it. That is deliberate, not a gap — see [vendorCallLock]'s doc
     * — and is left to propagate uncaught: the one real call site,
     * [ZebraRfidReader.disconnectBlocking]'s `teardownStep { barcodeEngine
     * ?.tearDown() }`, already catches `InterruptedException` and restores
     * the thread's interrupt flag, the same contract every other teardown
     * step in that function relies on.
     */
    fun tearDown() {
        // lockInterruptibly(), not lock() — see [vendorCallLock]'s doc for
        // why tearDown() specifically needs to stay interruptible here.
        vendorCallLock.lockInterruptibly()
        try {
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
        } finally {
            vendorCallLock.unlock()
        }
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

/** The hardware identity [chooseScanner] matches [ScannerCandidate]s
 *  against — the plain fields of the `ReaderDevice`
 *  [ZebraRfidReader.attemptVendorConnection] is already connected to
 *  (`getName()`/`getAddress()`/`getSerialNumber()`), pulled out into a value
 *  with no `com.zebra.*` type for the same reason [ScannerCandidate] is: so
 *  the matching logic in [chooseScanner] is testable without one. */
internal data class SledIdentity(val name: String?, val address: String?, val serial: String?)

/** Strips `:`/`-`/whitespace separators and lowercases what's left, so two
 *  representations of the same hardware token compare equal — e.g.
 *  `"48:A4:93:BD:15:DB"` (a colon-separated Bluetooth MAC, the shape
 *  `ReaderDevice.getAddress()` reports) and `"48a493bd15db"` (an
 *  unpunctuated lowercase form some other vendor call site might report the
 *  same address in). Used by [chooseScanner] on both sides of the
 *  comparison, since neither side's exact formatting is guaranteed. `null`
 *  in, `null` out — including for a value that is entirely separators — so
 *  two absent fields never accidentally compare equal to each other. */
private fun normalizeSledToken(value: String?): String? =
    value?.replace(Regex("[:\\-\\s]"), "")?.lowercase()?.takeUnless { it.isEmpty() }

/**
 * Pure selection behind [ZebraBarcodeEngine.attemptStandDown]: which
 * candidate, if any, is actually this kiosk's own sled. A phone's Bluetooth
 * pairing list is not evidence of anything but pairing — the real field log
 * this matching rule was written from (see
 * `.superpowers/sdd/kiosk-sled-bugs-task-1-brief.md`) shows a bare
 * `firstOrNull()` choosing `id=1 name=HSLT_a844`, a stranger's dive
 * computer, over the kiosk's actual RFD40 sled at `id=10` further down the
 * same list — so a candidate is trusted only if its hardware identity
 * actually matches [target], the identity of the RFID reader
 * [ZebraRfidReader.attemptVendorConnection] is already connected to.
 *
 * Matching rule: after normalizing both sides with [normalizeSledToken]
 * (case-insensitive, `:`/`-`/whitespace stripped), a candidate matches only
 * if its `serial` field equals [SledIdentity.address] or
 * [SledIdentity.serial]. `serial` is the right field to compare against an
 * address: for a classic-Bluetooth (SSI/RFCOMM) scanner, `DCSScannerInfo`
 * has no `getAddress()` at all — `getScannerHWSerialNumber()` is the field
 * that actually carries a colon-separated Bluetooth MAC (confirmed via
 * `javap`; see the brief) — and [ScannerCandidate.serial] is exactly that
 * field, so the same field can carry either a real serial or a MAC
 * depending on what the SDK happened to populate it with, and both are
 * worth checking against. `name` is deliberately never part of the
 * matching rule — unlike an address or a serial, a name is not exact, so it
 * is logged as context only (see the log line in
 * [ZebraBarcodeEngine.attemptStandDown] right before this runs) and never
 * used to select a candidate.
 *
 * Returns `null` — meaning the caller must not attempt a session with any
 * candidate at all — when nothing matches, when [candidates] is empty, or
 * when [target] itself carries neither an address nor a serial to match
 * against. See [ZebraBarcodeEngine.attemptStandDown] for how a `null` here
 * becomes [ImagerStandDownOutcome.NotIdentified].
 */
internal fun chooseScanner(candidates: List<ScannerCandidate>, target: SledIdentity): ScannerCandidate? {
    val targetAddress = normalizeSledToken(target.address)
    val targetSerial = normalizeSledToken(target.serial)
    if (targetAddress == null && targetSerial == null) return null
    return candidates.firstOrNull { candidate ->
        val candidateSerial = normalizeSledToken(candidate.serial) ?: return@firstOrNull false
        (targetAddress != null && candidateSerial == targetAddress) ||
            (targetSerial != null && candidateSerial == targetSerial)
    }
}

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

    /** Covers both real "couldn't identify the sled" cases [chooseScanner]
     *  can produce: no candidate scanners at all, and candidates that exist
     *  but don't match — see [ZebraBarcodeEngine.attemptStandDown]'s log
     *  lines for which one actually happened on a given attempt; this one
     *  outcome/note is honest for either, so it isn't split into two. */
    data object NotIdentified : ImagerStandDownOutcome
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
    ImagerStandDownOutcome.NotIdentified ->
        "The sled's barcode imager couldn't be identified among the available scanners; " +
            "it may still fire on a trigger pull."
    is ImagerStandDownOutcome.SessionFailed ->
        "The sled's barcode imager couldn't be reached (session failed: ${outcome.result}); " +
            "it may still fire on a trigger pull."
    is ImagerStandDownOutcome.CommandFailed ->
        "The sled's barcode imager may still fire on a trigger pull (stand-down command failed: ${outcome.result})."
    is ImagerStandDownOutcome.Unreachable ->
        "The sled's barcode imager couldn't be reached (${outcome.detail}); it may still fire on a trigger pull."
}
