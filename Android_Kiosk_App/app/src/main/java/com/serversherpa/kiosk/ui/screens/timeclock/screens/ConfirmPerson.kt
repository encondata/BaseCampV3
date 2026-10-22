package com.serversherpa.kiosk.ui.screens.timeclock.screens

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.KioskTimeclockPerson
import com.serversherpa.kiosk.nettest.InternetTestRoutes // INTERNET-TEST
import com.serversherpa.kiosk.ui.screens.timeclock.flow.initialsOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/** The presigned photo fetched with the app's OkHttp client (the kiosk has no image library), as
 *  the old Timeclock screen did; null when it fails, so the initials stay. */
internal suspend fun loadPhoto(client: OkHttpClient, url: String): ImageBitmap? = withContext(Dispatchers.IO) {
    try {
        client
            .let(InternetTestRoutes::portal) // INTERNET-TEST
            .newCall(Request.Builder().url(url).build()).execute().use { r ->
            if (!r.isSuccessful) return@use null
            r.body?.bytes()?.let { BitmapFactory.decodeByteArray(it, 0, it.size)?.asImageBitmap() }
        }
    } catch (e: CancellationException) { throw e
    } catch (e: Exception) { null }
}

/** The person's photo in a white-ringed circle, or their initials until it lands or if it fails. */
@Composable
private fun TcAvatar(url: String?, name: String, size: Dp) {
    val client = LocalAppContainer.current.httpClient
    var bitmap by remember(url) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(url) { if (url != null) bitmap = loadPhoto(client, url) }
    val ring = Modifier.size(size).shadow(16.dp, CircleShape, ambientColor = TcColors.Ink.copy(alpha = .18f), spotColor = TcColors.Ink.copy(alpha = .18f))
        .clip(CircleShape).border(6.dp, Color.White, CircleShape)
    val bmp = bitmap
    if (bmp != null) {
        Image(bmp, contentDescription = null, contentScale = ContentScale.Crop, modifier = ring)
    } else {
        val s = LocalTcSizes.current
        Box(ring.background(Brush.linearGradient(listOf(Color(0xFF334155), TcColors.Slate))), contentAlignment = Alignment.Center) {
            Text(initialsOf(name), style = tcText(s.sp(52f, 11f, 128f), FontWeight.Bold, Color.White).copy(letterSpacing = .02.em))
        }
    }
}

/**
 * Is this you? The person's photo (initials when there is none), name, job title and Employee ID;
 * a missing title or ID leaves no empty line. In landscape the photo sits left of the words.
 */
@Composable
fun ConfirmPerson(person: KioskTimeclockPerson, onYes: () -> Unit, onNo: () -> Unit) {
    val s = LocalTcSizes.current
    val avatar = if (s.landscape) s.dp(140f, 34f, 360f) else s.dp(150f, 32f, 380f)
    val align = if (s.landscape) TextAlign.Start else TextAlign.Center
    val body: @Composable (Modifier) -> Unit = { m ->
        Column(
            m, horizontalAlignment = if (s.landscape) Alignment.Start else Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(s.dp(6f, 1.2f, 14f)),
        ) {
            Text("Is this you?", style = tcText(s.sp(26f, 5f, 54f), FontWeight.Bold, align = align))
            val nameSize = if (s.landscape) s.sp(34f, 8f, 84f) else s.sp(38f, 8.4f, 92f)
            Text(person.display_name, style = tcText(nameSize, FontWeight.ExtraBold, align = align).copy(letterSpacing = (-0.02).em, lineHeight = nameSize * 1.05f))
            val meta = tcText(s.sp(17f, 3f, 32f), color = TcColors.Muted, align = align)
            person.job_title?.takeIf { it.isNotBlank() }?.let { Text(it, Modifier.testTag("tc-person-meta"), style = meta) }
            person.external_id?.takeIf { it.isNotBlank() }?.let { Text("Employee ID $it", Modifier.testTag("tc-person-meta"), style = meta) }
            Spacer(Modifier.height(s.dp(10f, 2.4f, 28f)))
            val yes: @Composable (Modifier) -> Unit = { bm -> TcButton("Yes, that's me", onYes, bm, trailing = TcArrowRightIcon) }
            val no: @Composable (Modifier) -> Unit = { bm -> TcButton("No, search again", onNo, bm, kind = TcButtonKind.GHOST) }
            if (s.landscape) {
                Row(Modifier.widthIn(max = 680.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    yes(Modifier.weight(1f)); no(Modifier.weight(1f))
                }
            } else {
                Column(Modifier.widthIn(max = 680.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    yes(Modifier.fillMaxWidth()); no(Modifier.fillMaxWidth())
                }
            }
        }
    }
    if (s.landscape) {
        Row(
            Modifier.widthIn(max = 1100.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(s.dp(24f, 5f, 72f), Alignment.CenterHorizontally),
        ) {
            TcAvatar(person.avatar_url, person.display_name, avatar)
            body(Modifier.weight(1f, fill = false).widthIn(max = 640.dp))
        }
    } else {
        Column(
            Modifier.widthIn(max = 820.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(s.dp(12f, 2.4f, 30f)),
        ) {
            TcAvatar(person.avatar_url, person.display_name, avatar)
            body(Modifier.fillMaxWidth())
        }
    }
}
