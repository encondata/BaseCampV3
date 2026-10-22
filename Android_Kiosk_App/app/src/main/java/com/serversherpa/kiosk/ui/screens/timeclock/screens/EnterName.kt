package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.serversherpa.kiosk.data.db.PersonEntity

/**
 * Enter Your Name with the system keyboard (Jimmy, on a Pixel: the in-app keyboard jumped as the
 * results came and went). The title, the lead and the search box stay fixed at the top; the
 * results fill the space between the box and the keyboard (`weight(1f)`, scrolling), so their
 * count never moves the box or the keyboard. In landscape the results sit beside the box.
 *
 * The box is a real text field: the IME types into it, and so does a reader that types like a
 * keyboard (a HID wedge or DataWedge keystrokes). Every change goes to [onQueryChange], which
 * selects a person the moment the value names exactly one. The IME's Search action, and Enter on
 * a hardware keyboard, is [onSearch]. Compose asks the IME for IME_FLAG_NO_FULLSCREEN on every
 * text field, so landscape never shows the full-screen extract editor.
 */
@Composable
fun EnterName(
    query: String,
    onQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
    results: List<PersonEntity>,
    /** The box has text but nobody matches it. */
    noMatches: Boolean,
    message: String?,
    disabled: Boolean,
    onPick: (PersonEntity) -> Unit,
    focusRequester: FocusRequester,
    /** Sits inside the box on the right (the camera lens, when the device has one). */
    trailing: (@Composable () -> Unit)? = null,
    /** How much fits above the keyboard ([rememberNameFit]). */
    fit: NameFit = NameFit.ROOMY,
) {
    val s = LocalTcSizes.current
    // With Back showing, the last rows can scroll clear of it; while the keyboard is up Back is
    // hidden (the system Back closes the keyboard first), so the rows are never covered.
    val listBottom = if (fit.back) 56.dp + tcBackBottom(s, false) + 8.dp else 8.dp
    val gap = if (fit.compact) 8.dp else if (s.landscape) s.dp(8f, 1.6f, 20f) else s.dp(10f, 2f, 24f)
    val top: @Composable (Modifier) -> Unit = { m ->
        Column(m, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(gap)) {
            if (fit.compact) Text("Enter Your Name", style = tcText(22.sp, FontWeight.ExtraBold))
            else TcTitle("Enter Your Name")
            if (fit.lead) TcLead("Type your name below to find your account.")
            SearchField(query, onQueryChange, onSearch, focusRequester, trailing, Modifier.fillMaxWidth(), compact = fit.compact)
            if (message != null) TcErrorText(message)
        }
    }
    val list: @Composable (Modifier) -> Unit = { m ->
        LazyColumn(
            m.testTag("tc-results"),
            contentPadding = PaddingValues(bottom = listBottom),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(results, key = { it.id }) { person -> ResultRow(person, !disabled) { onPick(person) } }
            if (noMatches) item {
                Text(
                    "No one matches that name yet. Keep typing or check the spelling.",
                    Modifier.fillMaxWidth().padding(top = 4.dp),
                    style = tcText(s.sp(15f, 2.2f, 20f), color = TcColors.Slate),
                )
            }
        }
    }
    if (s.landscape) {
        Row(Modifier.widthIn(max = 1280.dp).fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            top(Modifier.weight(1f))
            list(Modifier.weight(1f).fillMaxSize())
        }
    } else {
        Column(Modifier.widthIn(max = 760.dp).fillMaxSize(), verticalArrangement = Arrangement.spacedBy(gap)) {
            top(Modifier.fillMaxWidth())
            list(Modifier.weight(1f).fillMaxWidth())
        }
    }
}

/**
 * What Enter Your Name can show above the system keyboard. A short screen with the keyboard up (a
 * 360×640 dp handheld in portrait, any phone in landscape) drops the header and the lead, shrinks
 * the title and hides the floating Back, so the search box and at least two results stay in view.
 */
@Immutable
data class NameFit(
    /** The logo, wordmark and clock. */
    val header: Boolean,
    /** "Type your name below to find your account." */
    val lead: Boolean,
    /** A smaller title and box, tighter gaps. */
    val compact: Boolean,
    /** The floating Back button. */
    val back: Boolean,
) {
    companion object {
        val ROOMY = NameFit(header = true, lead = true, compact = false, back = true)
        /** Below this much height above the keyboard (dp) the header goes. */
        const val HEADER_MIN_DP = 420f
        /** Below this much the lead goes and the title and box shrink. */
        const val ROOMY_MIN_DP = 560f
    }
}

/** The layout decision as a pure function of the window height and the keyboard's inset (dp). */
fun nameFit(windowHeightDp: Float, imeDp: Float): NameFit {
    if (imeDp <= 0f) return NameFit.ROOMY
    val above = windowHeightDp - imeDp
    val roomy = above >= NameFit.ROOMY_MIN_DP
    return NameFit(header = above >= NameFit.HEADER_MIN_DP, lead = roomy, compact = !roomy, back = false)
}

/** [nameFit] for this window and the keyboard as it is now. */
@Composable
internal fun rememberNameFit(): NameFit {
    val density = LocalDensity.current
    val imeDp = with(density) { WindowInsets.ime.getBottom(density).toDp().value }
    return nameFit(LocalConfiguration.current.screenHeightDp.toFloat(), imeDp)
}

/** The bottom offset of the floating Back button: just above the keyboard while it is up. */
internal fun tcBackBottom(s: TcSizes, imeVisible: Boolean): Dp = if (imeVisible) 8.dp else s.pad + s.dp(28f, 4f, 44f)

@Composable
private fun SearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    onSearch: () -> Unit,
    focusRequester: FocusRequester,
    trailing: (@Composable () -> Unit)?,
    modifier: Modifier,
    compact: Boolean,
) {
    val s = LocalTcSizes.current
    val shape = RoundedCornerShape(16.dp)
    val fs = if (compact) 18.sp else s.sp(20f, 3f, 30f)
    BasicTextField(
        value = query,
        onValueChange = onQueryChange,
        singleLine = true,
        textStyle = tcText(fs, align = TextAlign.Start),
        cursorBrush = SolidColor(TcColors.Amber),
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Words, autoCorrectEnabled = false,
            keyboardType = KeyboardType.Text, imeAction = ImeAction.Search,
        ),
        keyboardActions = KeyboardActions(onSearch = { onSearch() }),
        modifier = modifier
            .focusRequester(focusRequester)
            // Enter from a hardware keyboard or reader: the same as the IME's Search.
            .onPreviewKeyEvent { e ->
                if (e.key == Key.Enter || e.key == Key.NumPadEnter) { if (e.type == KeyEventType.KeyDown) onSearch(); true } else false
            }
            .semantics { contentDescription = "Your name" }
            .testTag("tc-search-text"),
        decorationBox = { field ->
            Row(
                Modifier.fillMaxWidth().heightIn(min = if (compact) 56.dp else 68.dp)
                    .shadow(4.dp, shape, ambientColor = TcColors.Ink.copy(alpha = .06f), spotColor = TcColors.Ink.copy(alpha = .06f))
                    .clip(shape).background(Color.White).border(1.dp, TcColors.Amber, shape)
                    .padding(start = 20.dp, end = if (trailing != null) 8.dp else 20.dp)
                    .testTag("tc-search-box"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Icon(TcSearchIcon, contentDescription = null, tint = TcColors.Ink, modifier = Modifier.size(26.dp))
                Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) Text("Start typing your name…", maxLines = 1, style = tcText(fs, color = TcColors.Placeholder, align = TextAlign.Start))
                    field()
                }
                trailing?.invoke()
            }
        },
    )
}

@Composable
private fun ResultRow(person: PersonEntity, enabled: Boolean, onClick: () -> Unit) {
    val s = LocalTcSizes.current
    val shape = RoundedCornerShape(14.dp)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 60.dp).alpha(if (enabled) 1f else .55f)
            .clip(shape).background(Color.White.copy(alpha = .95f)).border(1.dp, TcColors.Line, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(person.displayName, style = tcText(s.sp(18f, 2.8f, 26f), FontWeight.SemiBold, align = TextAlign.Start))
            person.jobTitle?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = tcText(s.sp(13f, 1.9f, 18f), color = TcColors.Slate, align = TextAlign.Start))
            }
        }
        Icon(TcChevronIcon, contentDescription = null, tint = TcColors.Slate, modifier = Modifier.size(22.dp))
    }
}
