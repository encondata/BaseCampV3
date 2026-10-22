package com.serversherpa.kiosk.ui.screens.timeclock

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.input.camera.CameraScanSheet
import com.serversherpa.kiosk.ui.components.CameraIcon
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TcStep
import com.serversherpa.kiosk.ui.screens.timeclock.flow.TimeclockFlowViewModel
import com.serversherpa.kiosk.ui.screens.timeclock.flow.firstNameOf
import com.serversherpa.kiosk.ui.screens.timeclock.screens.AllSet
import com.serversherpa.kiosk.ui.screens.timeclock.screens.BadgeQuestion
import com.serversherpa.kiosk.ui.screens.timeclock.screens.ChooseAction
import com.serversherpa.kiosk.ui.screens.timeclock.screens.ClockOutSummary
import com.serversherpa.kiosk.ui.screens.timeclock.screens.ConfirmPerson
import com.serversherpa.kiosk.ui.screens.timeclock.screens.EnterName
import com.serversherpa.kiosk.ui.screens.timeclock.screens.NameFit
import com.serversherpa.kiosk.ui.screens.timeclock.screens.rememberNameFit
import com.serversherpa.kiosk.ui.screens.timeclock.screens.PrintingBadge
import com.serversherpa.kiosk.ui.screens.timeclock.screens.TcBackButton
import com.serversherpa.kiosk.ui.screens.timeclock.screens.TcColors
import com.serversherpa.kiosk.ui.screens.timeclock.screens.TcShell
import com.serversherpa.kiosk.ui.screens.timeclock.screens.VerifyBadge
import com.serversherpa.kiosk.ui.screens.timeclock.screens.Welcome
import kotlinx.coroutines.delay

/**
 * The guided time clock on screen, in either mode: the shell, the step's screen, and the inputs
 * the view model needs — scans from the [com.serversherpa.kiosk.input.ScanBus] (DataWedge and the
 * camera sheet), hardware keys on Welcome (a reader that types like a keyboard; on Enter Your Name
 * the search box is a real text field with the system keyboard), and every touch or key for the
 * idle countdown. All state is the view model's.
 *
 * Station mode (Task 4) passes [onSettings] for the gear on Welcome, and [paused] / [keyMissing]
 * when the station key is lapsed or missing; Welcome then takes nobody.
 */
@Composable
fun TimeclockFlowScreen(
    vm: TimeclockFlowViewModel,
    onSettings: (() -> Unit)? = null,
    paused: Boolean = false,
    keyMissing: Boolean = false,
) {
    val container = LocalAppContainer.current
    val ui by vm.state.collectAsStateWithLifecycle()
    var camera by rememberSaveable { mutableStateOf(false) }
    val step = ui.step
    val welcomeOff = step == TcStep.WELCOME && paused
    val typing = (step == TcStep.WELCOME || step == TcStep.NAME) && !welcomeOff
    val takesInput by rememberUpdatedState(typing)
    // Welcome has no visible box: the root catches a reader's keystrokes there. On Enter Your
    // Name the search box is a real text field, so it gets them (and the system keyboard's).
    val welcomeKeys = step == TcStep.WELCOME && !welcomeOff
    val catchesKeys by rememberUpdatedState(welcomeKeys)

    LaunchedEffect(vm) { container.scanBus.events.collect { if (takesInput) vm.onScan(it.value) } }

    // A full-screen dialog: it floats over the flow rather than replacing it.
    if (camera) CameraScanSheet(onScan = { container.scanBus.publish(it) }, onDismiss = { camera = false }, qrOnly = true)

    BackHandler(enabled = ui.hasBack) { vm.back() }

    // Off Enter Your Name the flow root holds focus: on Welcome a reader's keystrokes land there,
    // and on every other step a hardware key still reaches onPreviewKeyEvent (idle activity).
    val focus = remember { FocusRequester() }
    // Enter Your Name: the search box takes focus and the system keyboard comes up when the step
    // opens, and again once the camera sheet has closed and the main window has focus back (a
    // show() while the dialog still holds the window is lost); leaving the step hides it.
    val nameFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val windowFocused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(step, camera, windowFocused, ui.looking) {
        if (camera) return@LaunchedEffect
        if (step == TcStep.NAME) {
            if (!windowFocused) return@LaunchedEffect
            delay(50); runCatching { nameFocus.requestFocus() }; keyboard?.show()
        } else {
            keyboard?.hide()
            delay(50); runCatching { focus.requestFocus() }
        }
    }
    val fit = if (step == TcStep.NAME) rememberNameFit() else NameFit.ROOMY

    TcShell(
        modifier = Modifier
            .pointerInput(vm) {
                awaitPointerEventScope {
                    while (true) {
                        val e = awaitPointerEvent(PointerEventPass.Initial)
                        if (e.changes.any { it.changedToDown() }) vm.onActivity()
                    }
                }
            }
            .onPreviewKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                vm.onActivity()
                if (!catchesKeys) return@onPreviewKeyEvent false
                val query = vm.state.value.query
                when (e.key) {
                    Key.Enter, Key.NumPadEnter -> { vm.onSearch(); true }
                    Key.Backspace -> { vm.onType(query.dropLast(1)); true }
                    else -> {
                        val cp = e.utf16CodePoint
                        if (cp >= 32 && !e.isCtrlPressed && !e.isAltPressed) { vm.onType(query + String(Character.toChars(cp))); true } else false
                    }
                }
            }
            .focusRequester(focus)
            .focusable()
            .testTag("tc-flow"),
        onSettings = if (onSettings != null && step == TcStep.WELCOME) onSettings else null,
        back = if (ui.hasBack && fit.back) ({ TcBackButton(enabled = !ui.busy) { vm.back() } }) else null,
        fixed = step == TcStep.NAME,
        header = fit.header,
        compactTop = fit.compact,
    ) {
        val status = ui.flow.status
        when (step) {
            TcStep.WELCOME -> Welcome(
                paused = paused, keyMissing = keyMissing, message = ui.shownMessage,
                onScan = { if (container.hasCamera) camera = true },
                onName = { vm.enterName() },
            )
            TcStep.NAME -> EnterName(
                query = ui.query, onQueryChange = vm::onType, onSearch = vm::onSearch,
                results = ui.results, noMatches = ui.noMatches, message = ui.shownMessage,
                disabled = ui.looking, onPick = vm::pick, focusRequester = nameFocus, fit = fit,
                trailing = if (container.hasCamera) ({
                    IconButton(onClick = { camera = true }, enabled = !ui.looking) {
                        Icon(CameraIcon, contentDescription = "Scan with the camera", tint = TcColors.Amber, modifier = Modifier.size(28.dp))
                    }
                }) else null,
            )
            TcStep.CONFIRM -> if (status != null) ConfirmPerson(status.person, onYes = vm::confirmYes, onNo = vm::confirmNo)
            TcStep.ACTION -> if (status != null) ChooseAction(
                status, busy = ui.busy, notice = ui.flow.notice, error = ui.flow.error,
                onIn = vm::chooseIn, onOut = vm::chooseOut, onRetry = vm::retry,
            )
            TcStep.CLOCK_OUT -> if (status != null) ClockOutSummary(status, busy = ui.busy, error = ui.flow.error, onConfirm = vm::confirmClockOut, onRetry = vm::retry)
            TcStep.BADGE -> BadgeQuestion(onNew = vm::badgeNew, onExisting = vm::badgeExisting)
            TcStep.PRINTING -> PrintingBadge()
            TcStep.VERIFY -> VerifyBadge(onContinue = vm::verifyContinue)
            TcStep.DONE -> AllSet(firstNameOf(status?.person), onDone = vm::done)
        }
    }
}
