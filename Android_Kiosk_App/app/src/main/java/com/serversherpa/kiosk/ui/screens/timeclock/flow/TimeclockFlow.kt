package com.serversherpa.kiosk.ui.screens.timeclock.flow

import com.serversherpa.kiosk.core.model.KioskTimeclockStatus

/*
 * The guided time clock flow as a pure reducer (kiosk/src/timeclock/flow.ts). The view model
 * owns every side effect (the status read, the punch, the badge print, the timers) and reports
 * what happened as an event; nothing here touches the network, a timer or the clock, so each
 * transition is a plain state-in, state-out test.
 *
 * Two modes share the steps. STATION is the signed-out Time Clock: it starts on WELCOME and Back
 * from NAME returns there. KIOSK is a signed-in kiosk reaching the flow from its Home tile: it
 * starts on NAME, and leaving from there is the view model's call, so Back from NAME changes
 * nothing here.
 */

enum class TcMode { STATION, KIOSK }

enum class TcStep { WELCOME, NAME, CONFIRM, ACTION, CLOCK_OUT, BADGE, PRINTING, VERIFY, DONE }

enum class Punched { IN, OUT }

/** The reducer's state. The person is [status]'s person; the typed text, the search results and
 *  the lookup flags live beside it in the view model's [TcUi], since no step rule reads them. */
data class TcState(
    val step: TcStep,
    val status: KioskTimeclockStatus? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val punched: Punched? = null,
)

sealed interface TcEvent {
    data object EnterName : TcEvent
    data class Identified(val status: KioskTimeclockStatus) : TcEvent
    data object ConfirmYes : TcEvent
    data object ConfirmNo : TcEvent
    data object ChooseIn : TcEvent
    data object ChooseOut : TcEvent
    data object PunchStarted : TcEvent
    data class PunchSucceeded(val status: KioskTimeclockStatus, val punched: Punched) : TcEvent
    data class PunchFailed(val code: String) : TcEvent
    data class StatusRefreshed(val status: KioskTimeclockStatus) : TcEvent
    data object BadgeNew : TcEvent
    data object BadgeExisting : TcEvent
    data object PrintingDone : TcEvent
    data object VerifyContinue : TcEvent
    data object Back : TcEvent
    data object Reset : TcEvent
}

/** A screen never outlives the person at it: 20 s without a touch or key returns to the start. */
const val IDLE_MS = 20_000L
/** All Set returns to the start on its own after this long. */
const val DONE_MS = 8_000L
/** The Printing placeholder advances to Verify after this long. */
const val PRINTING_MS = 3_000L
/** How long "We couldn't find that code." and its kind stay up. */
const val MESSAGE_MS = 5_000L
/** Welcome's reader value is forgotten (or settled) after this much quiet. */
const val SCAN_QUIET_MS = 1_500L
/** People and status reads give up after this long. Punches never time out. */
const val READ_TIMEOUT_MS = 10_000L

internal const val NOTICE_CHANGED = "Your status changed. Please choose again."
private const val ERROR_UNREACHABLE = "Can't reach the portal. Your punch was not recorded. Try again."
private const val ERROR_OTHER = "Something went wrong. Your punch was not recorded. Try again."
private const val ERROR_READ_ONLY = "The portal is in read-only mode. Your punch was not recorded. Try again shortly."
/** kiosk/src/lib/api.ts CLOUD_SIGN_IN_TEXT. */
private const val CLOUD_SIGN_IN_TEXT = "Sign in again while online to do this."

fun startStep(mode: TcMode): TcStep = if (mode == TcMode.STATION) TcStep.WELCOME else TcStep.NAME

fun initialState(mode: TcMode): TcState = TcState(step = startStep(mode))

private fun failureText(code: String): String = when (code) {
    "network", "edge_offline" -> ERROR_UNREACHABLE
    // a laptop kiosk signed in while offline can't punch until it signs in online
    "cloud_sign_in_required" -> CLOUD_SIGN_IN_TEXT
    "read_only_mode" -> ERROR_READ_ONLY
    else -> ERROR_OTHER
}

/** The events that start a punch. While one is in flight (`busy`) they change nothing, so a
 *  double tap can never send a second punch: the view model sends only when an event takes the
 *  state into busy. */
private fun startsPunch(event: TcEvent) = event is TcEvent.ChooseIn || event is TcEvent.ChooseOut || event is TcEvent.PunchStarted

/** One transition. A no-op returns [state] itself. */
fun reduce(state: TcState, event: TcEvent, mode: TcMode): TcState {
    if (state.busy && startsPunch(event)) return state
    return when (event) {
        TcEvent.EnterName -> if (state.step == TcStep.WELCOME) state.copy(step = TcStep.NAME) else state
        is TcEvent.Identified -> state.copy(step = TcStep.CONFIRM, status = event.status, busy = false, error = null, notice = null, punched = null)
        TcEvent.ConfirmNo -> state.copy(step = TcStep.NAME)
        TcEvent.ConfirmYes -> state.copy(step = TcStep.ACTION)
        TcEvent.ChooseOut -> if (state.status?.clocked_in == true) state.copy(step = TcStep.CLOCK_OUT, error = null, notice = null) else state
        // The view model punches straight away (no second confirm to clock in).
        TcEvent.ChooseIn -> if (state.status != null && !state.status.clocked_in) state.copy(busy = true, error = null, notice = null) else state
        TcEvent.PunchStarted -> state.copy(busy = true, error = null)
        is TcEvent.PunchSucceeded -> state.copy(
            step = if (event.punched == Punched.IN) TcStep.BADGE else TcStep.DONE,
            status = event.status, punched = event.punched, busy = false, error = null, notice = null,
        )
        is TcEvent.PunchFailed ->
            if (event.code == "already_clocked_in" || event.code == "not_clocked_in") {
                state.copy(step = TcStep.ACTION, busy = false, error = null, notice = NOTICE_CHANGED)
            } else {
                state.copy(busy = false, error = failureText(event.code), notice = null)
            }
        is TcEvent.StatusRefreshed -> state.copy(status = event.status, busy = false)
        TcEvent.BadgeNew -> state.copy(step = TcStep.PRINTING)
        TcEvent.PrintingDone -> state.copy(step = TcStep.VERIFY)
        TcEvent.VerifyContinue, TcEvent.BadgeExisting -> state.copy(step = TcStep.DONE)
        TcEvent.Back -> when (state.step) {
            TcStep.CONFIRM -> state.copy(step = TcStep.NAME)
            TcStep.NAME -> if (mode == TcMode.STATION) state.copy(step = TcStep.WELCOME) else state
            TcStep.ACTION -> state.copy(step = TcStep.CONFIRM)
            TcStep.CLOCK_OUT -> state.copy(step = TcStep.ACTION, error = null)
            else -> state
        }
        TcEvent.Reset -> initialState(mode)
    }
}
