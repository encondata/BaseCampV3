package com.serversherpa.kiosk.ui.components

import android.os.SystemClock
import android.view.KeyCharacterMap
import android.view.KeyEvent as AndroidKeyEvent
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.onPreInterceptKeyBeforeSoftKeyboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.style.TextOverflow
import com.serversherpa.kiosk.core.scan.SledScanGuard
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.coroutines.delay

/** The guard that delivers each sled scan once (MainActivity provides the container's; with
 *  none provided every value is accepted, as before). */
val LocalSledScanGuard = staticCompositionLocalOf { SledScanGuard.ACCEPT_ALL }

/**
 * Tells the screen's copies of the box's text apart from text the screen set itself.
 *
 * A scanner in keyboard (HID) mode types a whole barcode, Enter included, before the screen's
 * view model hands the text back, so the screen's [value][ScanInput] runs behind the box. Each
 * text the box reports is remembered until the screen shows it (or a later one); a screen value
 * that matches one is a late copy and is ignored. Any other change (a clear after a submit, a
 * lookup showing what it searched for) is the screen's own and the box shows it.
 */
internal class ScanBoxEchoes(initial: String) {
    private var lastScreen = initial
    private val reported = ArrayDeque<String>()

    /** The box now holds [text] (typed, or emptied by a submit). */
    fun reported(text: String) {
        reported.addLast(text)
        while (reported.size > MAX_REPORTED) reported.removeFirst()
    }

    /** The screen's value is [screen]: true when the box must show it, false when it is
     *  unchanged or a late copy of something the box reported. */
    fun isScreensOwn(screen: String): Boolean {
        if (screen == lastScreen) return false
        lastScreen = screen
        val at = reported.indexOf(screen)
        if (at >= 0) { repeat(at + 1) { reported.removeFirst() }; return false }
        reported.clear()
        return true
    }

    private companion object { const val MAX_REPORTED = 1024 }
}

/**
 * Keeps keys typed straight after a submit out of the scan before it.
 *
 * The text field keeps its own copy of its text and takes the box's only when the box draws. A
 * submit empties the box at once, but keys that arrive before the next draw (a scanner sending
 * scan after scan with no gap) are applied to the field's old copy: each comes back as the old
 * text plus the key. Until the box draws again, that old text is stripped from every edit.
 */
internal class StaleFieldText(initial: String) {
    /** The text field's own copy of its text, as far as the box knows. */
    private var held = initial
    /** What the field still holds from before the box was emptied; null once it has drawn. */
    private var stale: String? = null

    /** The box drew [text]: the field holds it now. */
    fun drawn(text: String) { held = text; stale = null }

    /** The box was emptied between draws: the field still holds its old text. */
    fun emptied() { stale = held }

    /** The field reports [raw] after an edit: returns the box's text (raw, less any old text). */
    fun edited(raw: String): String {
        held = raw
        val old = stale ?: return raw
        return raw.substring(raw.commonPrefixWith(old).length)
    }
}

/**
 * The always-focused box: a barcode scanner is a keyboard, so whatever
 * it types lands here and its Enter submits. `keepFocus` reclaims focus
 * when it drifts (a tap on empty space, the app coming back).
 *
 * The box holds its own text, so a fast scanner never loses a key while the screen catches up,
 * and Enter submits exactly what was typed ([ScanBoxEchoes]). A submit empties the box; the
 * screen can still set or clear it through [value].
 *
 * Typing is noted on [LocalSledScanGuard], and a submit the sled's scanner already delivered is
 * refused there: the box is cleared and nothing is submitted.
 */
@OptIn(ExperimentalComposeUiApi::class) // onPreInterceptKeyBeforeSoftKeyboard
@Composable
fun ScanInput(
    value: String,
    onValueChange: (String) -> Unit,
    onSubmit: (String) -> Unit,
    placeholder: String,
    enabled: Boolean = true,
    keepFocus: Boolean = true,
    modifier: Modifier = Modifier,
    /** Sits inside the box on the right — the camera lives here rather than in a
     *  button below, so the scan line is one thing and not two. */
    trailingIcon: @Composable (() -> Unit)? = null,
) {
    val requester = remember { FocusRequester() }
    val guard = LocalSledScanGuard.current
    val echoes = remember { ScanBoxEchoes(value) }
    val drawnText = remember { StaleFieldText(value) }
    var field by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    if (echoes.isScreensOwn(value)) field = TextFieldValue(value, TextRange(value.length))
    // Every draw hands the text field the box's text, so it no longer holds an old one.
    SideEffect { drawnText.drawn(field.text) }
    fun report(text: String) { echoes.reported(text); onValueChange(text) }
    fun empty() { field = TextFieldValue(""); drawnText.emptied(); echoes.reported("") }
    fun submit() {
        val v = field.text.trim()
        if (v.isEmpty()) return
        // Emptied here, not left to the screen: its clear may never arrive as a change when it
        // never saw the typed text, and the next scan would be appended. The screen's own clear
        // is then a late copy ([ScanBoxEchoes]).
        empty()
        if (guard.acceptTyped(v, SystemClock.elapsedRealtime())) onSubmit(v) else onValueChange("")
    }
    /** A key from a hardware keyboard (a scanner in HID mode is one), before the on-screen
     *  keyboard app sees it: a character goes straight into the box at the cursor and Enter
     *  submits. Taken here, a key can't be dropped or replayed by the keyboard app while the box
     *  resets its text between scans. Other keys (Backspace, arrows, shortcuts) pass on. */
    fun hardwareKey(event: androidx.compose.ui.input.key.KeyEvent): Boolean {
        if (!enabled) return false
        val key = event.nativeKeyEvent
        if (key.isCtrlPressed || key.isAltPressed || key.isMetaPressed) return false
        val enter = key.keyCode == AndroidKeyEvent.KEYCODE_ENTER || key.keyCode == AndroidKeyEvent.KEYCODE_NUMPAD_ENTER
        val char = key.unicodeChar
        val printable = !enter && char != 0 && (char and KeyCharacterMap.COMBINING_ACCENT) == 0 && !Character.isISOControl(char)
        if (!enter && !printable) return false
        if (key.action == AndroidKeyEvent.ACTION_DOWN) {
            if (enter) submit()
            else {
                val typed = String(Character.toChars(char))
                val start = field.selection.min
                val text = field.text.substring(0, start) + typed + field.text.substring(field.selection.max)
                guard.noteTyping(SystemClock.elapsedRealtime())
                field = TextFieldValue(text, TextRange(start + typed.length))
                report(text)
            }
        }
        return true // the key's release too, so the text field never sees half a key
    }
    LaunchedEffect(enabled, keepFocus) { if (enabled && keepFocus) { delay(50); runCatching { requester.requestFocus() } } }
    OutlinedTextField(
        value = field,
        onValueChange = { raw ->
            val text = drawnText.edited(raw.text)
            val next = if (text == raw.text) raw else TextFieldValue(text, TextRange(text.length))
            val before = field.text
            if (next.text.length > before.length) guard.noteTyping(SystemClock.elapsedRealtime())
            field = next
            if (next.text != before) report(next.text)
        },
        enabled = enabled,
        singleLine = true,
        // One line, always: a long hint trails off with "…" instead of making the box two lines tall.
        placeholder = { Text(placeholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onDone = { submit() }),
        trailingIcon = trailingIcon,
        modifier = modifier.fillMaxWidth().testTag("scan-input").focusRequester(requester)
            .onPreInterceptKeyBeforeSoftKeyboard { hardwareKey(it) }
            .onFocusChanged { if (!it.isFocused && enabled && keepFocus) runCatching { requester.requestFocus() } },
    )
}

/** The camera affordance for a scan box: tap the lens, the full-screen scanner opens. */
@Composable
fun CameraFieldButton(enabled: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled) {
        Icon(CameraIcon, contentDescription = "Scan with the camera", tint = LocalKioskColors.current.accent)
    }
}
