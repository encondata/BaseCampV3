package com.serversherpa.kiosk.ui.screens.scan

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.serversherpa.kiosk.core.rfid.RfidReadSession
import com.serversherpa.kiosk.core.scan.displayRfid
import com.serversherpa.kiosk.ui.components.MiniButton
import com.serversherpa.kiosk.ui.theme.FragmentMono
import com.serversherpa.kiosk.ui.theme.LocalKioskColors

/** How many tag chips the strip shows. The rest are counted, not listed. */
private const val CHIPS = 12

/**
 * What a sweep looks like while it is happening: the unique count large enough
 * to read at arm's length, the total beside it so a chatty read is obvious, and
 * the newest tags streaming past. It sits where the scan box sits, so the
 * outbox list below never moves and the queued rows appear where the operator
 * is already looking.
 *
 * `session` changes on every tag report — a fast sweep can recompose this many
 * times a second — so the chip strip is built with `asReversed().take(CHIPS)`
 * rather than `reversed().takeLast(CHIPS)` or similar: `asReversed()` is an
 * O(1) view over the backing list (`onTagRead` builds `tags` as an
 * `ArrayList`, so it is random-access), and `take` on that view stops after
 * `CHIPS` elements instead of walking the whole thing. The strip's per-frame
 * cost is therefore bounded by `CHIPS`, not by how many tags the sweep has
 * found so far, which is what keeps a several-hundred-tag rack from getting
 * slower to render as the sweep goes on.
 */
@Composable
fun RfidReadPanel(session: RfidReadSession, showSkipped: Boolean, onStop: () -> Unit) {
    val c = LocalKioskColors.current
    Column(
        Modifier.fillMaxWidth()
            .background(c.paper, RoundedCornerShape(14.dp))
            .border(2.dp, c.accent, RoundedCornerShape(14.dp))
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                session.uniqueCount.toString(),
                fontSize = 44.sp, fontWeight = FontWeight.Bold, color = c.accent,
            )
            Column(Modifier.weight(1f)) {
                Text("Reading…", style = MaterialTheme.typography.titleMedium, color = c.textDark)
                // Two separate Text nodes, not one buildString: an operator reads
                // it as one line either way, but a combined string would put
                // "already sent" inside the same accessible text as "reads",
                // which nothing downstream (including this file's own test) can
                // then address on its own.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${session.totalReads} reads",
                        fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute,
                    )
                    if (showSkipped && session.skippedRepeats > 0) {
                        Text(
                            " · ",
                            fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute,
                        )
                        Text(
                            "${session.skippedRepeats} already sent",
                            fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textMute,
                        )
                    }
                }
            }
            MiniButton("Stop", onStop)
        }
        if (session.tags.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for (tag in session.tags.asReversed().take(CHIPS)) {
                    Text(
                        displayRfid(tag.epc),
                        fontFamily = FragmentMono, style = MaterialTheme.typography.labelMedium, color = c.textDark,
                        modifier = Modifier.background(c.paper2, RoundedCornerShape(999.dp))
                            .border(1.dp, c.paperLine, RoundedCornerShape(999.dp))
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                    )
                }
            }
        }
    }
}
