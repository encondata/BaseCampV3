package com.serversherpa.kiosk.ui.screens.rolodex

import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.core.model.RolodexRow
import com.serversherpa.kiosk.ui.screens.timeclock.flow.initialsOf
import com.serversherpa.kiosk.ui.screens.timeclock.screens.loadPhoto
import com.serversherpa.kiosk.ui.theme.Geologica

/** Photos are decoded no larger than this (Rolodex photos are 512 px; a portal upload may be far bigger). */
internal const val PHOTO_DECODE_PX = 384

/**
 * Worker photos already fetched, in memory, keyed by person and photo version: never by the
 * presigned URL, which changes on every list read and expires after ten minutes. A new photo has a
 * new version, so its key misses and the new picture loads.
 */
internal object WorkerPhotoCache {
    private val maxBytes = minOf(32L * 1024 * 1024, Runtime.getRuntime().maxMemory() / 8).toInt()
    private val photos = object : LruCache<String, ImageBitmap>(maxBytes) {
        override fun sizeOf(key: String, value: ImageBitmap): Int = value.width * value.height * 4
    }

    fun key(personId: String, photoVersion: String): String = "$personId:$photoVersion"
    fun get(key: String): ImageBitmap? = photos.get(key)
    fun put(key: String, photo: ImageBitmap) { photos.put(key, photo) }
}

/** A list row's photo, or its gray initials. */
@Composable
fun WorkerAvatar(row: RolodexRow, size: Dp, modifier: Modifier = Modifier) =
    WorkerAvatar(row.person_id, row.display_name, row.photo_url, row.photo_version, size, modifier)

/**
 * A worker's photo in a circle, or the gray initials gradient (as the Time Clock draws them) when
 * there is none, while it loads, offline (a cached list's photo links have expired) or when it
 * fails. The fetch is [rememberWorkerPhoto]'s.
 */
@Composable
fun WorkerAvatar(personId: String, name: String, photoUrl: String?, photoVersion: String?, size: Dp, modifier: Modifier = Modifier) =
    WorkerAvatar(name, rememberWorkerPhoto(personId, photoUrl, photoVersion), size, modifier)

/**
 * A worker's photo as far as it has loaded: from [WorkerPhotoCache] by person and [photoVersion],
 * else fetched with the Time Clock's [loadPhoto], decoded downsampled, and cached. Null without a
 * photo, while it loads, offline (a cached list's photo links have expired) or when it fails.
 */
@Composable
internal fun rememberWorkerPhoto(personId: String, photoUrl: String?, photoVersion: String?): ImageBitmap? {
    val client = LocalAppContainer.current.httpClient
    val key = photoVersion?.let { WorkerPhotoCache.key(personId, it) }
    var photo by remember(key) { mutableStateOf(key?.let(WorkerPhotoCache::get)) }
    // Keyed on the URL too: a page that failed offline tries again when a fresh list brings a live link.
    LaunchedEffect(key, photoUrl) {
        if (key == null || photo != null || photoUrl == null) return@LaunchedEffect
        loadPhoto(client, photoUrl, PHOTO_DECODE_PX)?.let { WorkerPhotoCache.put(key, it); photo = it }
    }
    return photo
}

/** [photo] cropped to a circle, or [name]'s gray initials when it's null. */
@Composable
internal fun WorkerAvatar(name: String, photo: ImageBitmap?, size: Dp, modifier: Modifier = Modifier) {
    val circle = modifier.size(size).clip(CircleShape)
    if (photo != null) {
        Image(photo, contentDescription = null, contentScale = ContentScale.Crop, modifier = circle)
    } else {
        Box(circle.background(Brush.linearGradient(listOf(Color(0xFF334155), Color(0xFF64748B)))), contentAlignment = Alignment.Center) {
            Text(
                initialsOf(name),
                style = TextStyle(fontFamily = Geologica, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.34f).sp, color = Color.White),
            )
        }
    }
}
