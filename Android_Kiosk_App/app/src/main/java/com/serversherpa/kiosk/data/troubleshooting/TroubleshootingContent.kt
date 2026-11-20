package com.serversherpa.kiosk.data.troubleshooting

import android.content.Context
import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.serversherpa.kiosk.core.troubleshooting.DocNode
import com.serversherpa.kiosk.core.troubleshooting.Topic
import com.serversherpa.kiosk.core.troubleshooting.TroubleshootingJson

/**
 * The bundled troubleshooting guides in assets/troubleshooting: byte-for-byte copies of
 * kiosk/src/troubleshooting (scripts/troubleshooting/sync.sh), so they work offline.
 */
object TroubleshootingContent {
    private const val DIR = "troubleshooting"

    private fun path(file: String): String {
        require(TroubleshootingJson.isPlainFileName(file)) { "bad troubleshooting file name: $file" }
        return "$DIR/$file"
    }

    private fun read(ctx: Context, file: String): String = ctx.assets.open(path(file)).use { it.readBytes().decodeToString() }

    fun topics(ctx: Context): List<Topic> = TroubleshootingJson.topics(read(ctx, "topics.json"))

    fun doc(ctx: Context, topic: Topic): DocNode = TroubleshootingJson.doc(read(ctx, topic.doc))

    fun image(ctx: Context, file: String): ImageBitmap {
        val bitmap = ctx.assets.open(path(file)).use { BitmapFactory.decodeStream(it) } ?: error("couldn't decode $file")
        return bitmap.asImageBitmap()
    }
}
