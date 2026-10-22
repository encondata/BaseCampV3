package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.data.db.PersonEntity

/**
 * Enter Your Name: the search box (which a hardware reader or keyboard types into as well), up to
 * eight matching people to tap, and the on-screen keyboard. In landscape the results sit beside
 * the keyboard.
 */
@Composable
fun EnterName(
    query: String,
    results: List<PersonEntity>,
    /** The box has text but nobody matches it. */
    noMatches: Boolean,
    message: String?,
    disabled: Boolean,
    onPick: (PersonEntity) -> Unit,
    keyboard: @Composable (Modifier) -> Unit,
    /** Sits inside the box on the right (the camera lens, when the device has one). */
    trailing: (@Composable () -> Unit)? = null,
) {
    val s = LocalTcSizes.current
    Column(
        Modifier.widthIn(max = if (s.landscape) 1280.dp else 900.dp).fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(s.dp(12f, 2.4f, 30f)),
    ) {
        TcTitle("Enter Your Name")
        TcLead("Type your name below to find your account.")
        SearchBox(query, trailing, Modifier.then(if (s.landscape) Modifier else Modifier.widthIn(max = 760.dp)).fillMaxWidth())
        if (message != null) TcErrorText(message)
        val list: @Composable (Modifier) -> Unit = { m ->
            Column(m, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (person in results) ResultRow(person, !disabled) { onPick(person) }
                if (noMatches) {
                    Text(
                        "No one matches that name yet. Keep typing or check the spelling.",
                        style = tcText(s.sp(15f, 2.2f, 20f), color = TcColors.Slate),
                    )
                }
            }
        }
        if (s.landscape) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                list(Modifier.weight(1f).widthIn(min = 240.dp))
                keyboard(Modifier.weight(1.7f))
            }
        } else {
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                list(Modifier.fillMaxWidth())
                keyboard(Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun SearchBox(query: String, trailing: (@Composable () -> Unit)?, modifier: Modifier) {
    val s = LocalTcSizes.current
    val shape = RoundedCornerShape(16.dp)
    Row(
        modifier.heightIn(min = 68.dp)
            .shadow(4.dp, shape, ambientColor = TcColors.Ink.copy(alpha = .06f), spotColor = TcColors.Ink.copy(alpha = .06f))
            .clip(shape).background(Color.White).border(1.dp, TcColors.Amber, shape)
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(TcSearchIcon, contentDescription = null, tint = TcColors.Ink, modifier = Modifier.size(26.dp))
        val fs = s.sp(20f, 3f, 30f)
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            Text(
                query.ifEmpty { "Start typing your name…" }, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false).testTag("tc-search-text"),
                style = tcText(fs, color = if (query.isEmpty()) TcColors.Placeholder else TcColors.Ink, align = TextAlign.Start),
            )
            if (query.isNotEmpty()) Box(Modifier.padding(start = 2.dp).width(2.dp).height(with(LocalDensity.current) { fs.toDp() }).background(TcColors.Amber))
        }
        trailing?.invoke()
    }
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
