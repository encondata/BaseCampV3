package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Verify Your Badge: a placeholder until RFID badge reads land. No tag is read yet, so Continue
 *  moves on. */
@Composable
fun VerifyBadge(onContinue: () -> Unit) {
    val s = LocalTcSizes.current
    Column(
        Modifier.widthIn(max = 820.dp).fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(s.dp(12f, 2.4f, 30f)),
    ) {
        TcTitle("Verify Your Badge")
        TcLead("Place your badge against the reader to check it's working.")
        Image(TcBadgeTapIcon, contentDescription = null, modifier = Modifier.size(if (s.landscape) s.dp(120f, 26f, 280f) else s.dp(140f, 30f, 320f)))
        TcButton("Continue", onContinue, Modifier.widthIn(max = 680.dp).fillMaxWidth().padding(top = s.dp(8f, 2f, 24f)))
    }
}
