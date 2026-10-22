package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** You're All Set! The view model returns to the start on its own after DONE_MS. */
@Composable
fun AllSet(name: String, onDone: () -> Unit) {
    val s = LocalTcSizes.current
    Column(
        Modifier.widthIn(max = 820.dp).fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(s.dp(12f, 2.4f, 30f)),
    ) {
        Image(TcCheckIcon, contentDescription = null, modifier = Modifier.size(if (s.landscape) s.dp(100f, 20f, 220f) else s.dp(120f, 24f, 260f)))
        TcHero("You're All Set!", done = true)
        if (name.isBlank()) TcLead("Have a great day!")
        else Column(horizontalAlignment = Alignment.CenterHorizontally) {
            TcLead("Have a great day,")
            val lead = s.sp(16f, 3.6f, 38f)
            Text("$name!", style = tcText(lead * 1.9f, FontWeight.ExtraBold))
        }
        TcButton("Done", onDone, Modifier.widthIn(max = 680.dp).fillMaxWidth().padding(top = s.dp(8f, 2f, 24f)), kind = TcButtonKind.BLUE)
    }
}
