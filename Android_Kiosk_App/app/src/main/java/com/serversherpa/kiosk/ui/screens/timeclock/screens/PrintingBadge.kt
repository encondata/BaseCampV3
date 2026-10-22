package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** Printing Your Badge: a placeholder until real badge printing lands. The view model moves on to
 *  Verify after PRINTING_MS. */
@Composable
fun PrintingBadge() {
    val s = LocalTcSizes.current
    Column(
        Modifier.widthIn(max = 820.dp).fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(s.dp(12f, 2.4f, 30f)),
    ) {
        TcTitle("Printing Your Badge")
        TcLead("Please wait while we print your badge…")
        Image(TcPrinterIcon, contentDescription = null, modifier = Modifier.size(if (s.landscape) s.dp(120f, 26f, 280f) else s.dp(140f, 30f, 320f)))
        CircularProgressIndicator(
            color = TcColors.Blue, trackColor = Color(0xFFDBEAFE), strokeWidth = 5.dp,
            modifier = Modifier.size(48.dp).semantics { contentDescription = "Printing" },
        )
    }
}
