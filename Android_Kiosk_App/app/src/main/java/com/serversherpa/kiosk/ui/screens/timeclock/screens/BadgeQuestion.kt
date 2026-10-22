package com.serversherpa.kiosk.ui.screens.timeclock.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** After a Clock In (the punch is already recorded): a new badge or not. Side by side in landscape. */
@Composable
fun BadgeQuestion(onNew: () -> Unit, onExisting: () -> Unit) {
    val s = LocalTcSizes.current
    Column(
        Modifier.widthIn(max = 820.dp).fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(s.dp(12f, 2.4f, 30f)),
    ) {
        TcTitle("Do you need a new badge?")
        Spacer(Modifier.height(s.dp(10f, 3f, 40f)))
        val print: @Composable (Modifier) -> Unit = { m -> TcButton("Print a new badge", onNew, m) }
        val works: @Composable (Modifier) -> Unit = { m -> TcButton("My badge works", onExisting, m, kind = TcButtonKind.GHOST) }
        if (s.landscape) {
            Row(Modifier.widthIn(max = 900.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                print(Modifier.weight(1f)); works(Modifier.weight(1f))
            }
        } else {
            Column(Modifier.widthIn(max = 680.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                print(Modifier.fillMaxWidth()); works(Modifier.fillMaxWidth())
            }
        }
    }
}
