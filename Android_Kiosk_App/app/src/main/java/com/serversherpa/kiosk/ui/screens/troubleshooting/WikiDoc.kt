package com.serversherpa.kiosk.ui.screens.troubleshooting

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.serversherpa.kiosk.core.troubleshooting.DocNode
import com.serversherpa.kiosk.data.troubleshooting.TroubleshootingContent
import com.serversherpa.kiosk.ui.theme.ChipTone
import com.serversherpa.kiosk.ui.theme.LocalKioskColors
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * kiosk/src/troubleshooting/WikiDoc.tsx: renders a bundled guide's wiki (ProseMirror) JSON.
 * Only the nodes the web guard test allows; an unknown node renders nothing. Everything follows
 * the theme except barcodes, which sit on a white panel in both themes.
 */
@Composable
fun WikiDoc(doc: DocNode, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) { doc.content.forEach { Block(it) } }
}

@Composable
private fun Block(n: DocNode, bold: Boolean = false) {
    val c = LocalKioskColors.current
    val type = MaterialTheme.typography
    when (n.type) {
        "paragraph" -> Text(inline(n, bold), style = type.bodyMedium, color = c.textDark, modifier = Modifier.padding(vertical = 4.dp))
        "heading" -> {
            val sub = n.attrs.number("level") == 3
            Text(
                inline(n), style = if (sub) type.titleMedium else type.titleLarge, color = c.textDark,
                modifier = Modifier.padding(top = if (sub) 12.dp else 20.dp, bottom = 4.dp).semantics { heading() },
            )
        }
        "bulletList" -> ListBlock(n, ordered = false)
        "orderedList" -> ListBlock(n, ordered = true)
        "listItem" -> Column { n.content.forEach { Block(it) } }
        "table" -> Table(n)
        "callout" -> Callout(n)
        "wikiImage" -> Barcode(n)
        else -> Unit
    }
}

/** A block's text runs; `bold` marks (and table headers) draw bold. */
private fun inline(n: DocNode, bold: Boolean = false): AnnotatedString = buildAnnotatedString {
    for (t in n.content) {
        if (t.type != "text") continue
        val text = t.text.orEmpty()
        if (bold || t.marks.any { it.type == "bold" }) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(text) } else append(text)
    }
}

@Composable
private fun ListBlock(n: DocNode, ordered: Boolean) {
    val c = LocalKioskColors.current
    val start = n.attrs.number("start") ?: 1
    Column(Modifier.padding(vertical = 4.dp)) {
        n.content.filter { it.type == "listItem" }.forEachIndexed { i, item ->
            Row {
                Text(if (ordered) "${start + i}." else "•", style = MaterialTheme.typography.bodyMedium, color = c.textDark, modifier = Modifier.padding(vertical = 4.dp).width(24.dp))
                Column(Modifier.weight(1f)) { item.content.forEach { Block(it) } }
            }
        }
    }
}

/** Equal-width columns (by colspan) whose text wraps, so a table never scrolls sideways. */
@Composable
private fun Table(n: DocNode) {
    val c = LocalKioskColors.current
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.padding(vertical = 8.dp).fillMaxWidth().clip(shape).border(1.dp, c.paperLine, shape)) {
        n.content.filter { it.type == "tableRow" }.forEachIndexed { i, row ->
            if (i > 0) HorizontalDivider(color = c.paperLine)
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                row.content.forEachIndexed { j, cell ->
                    if (j > 0) VerticalDivider(color = c.paperLine)
                    val header = cell.type == "tableHeader"
                    val span = cell.attrs.number("colspan")?.coerceAtLeast(1) ?: 1
                    Column(Modifier.weight(span.toFloat()).fillMaxHeight().background(if (header) c.paper2 else Color.Transparent).padding(horizontal = 8.dp, vertical = 4.dp)) {
                        cell.content.forEach { Block(it, bold = header) }
                    }
                }
            }
        }
    }
}

/** The portal banner's tones: info blue, tip green, warning amber, danger red. */
@Composable
private fun Callout(n: DocNode) {
    val tone = when (n.attrs.string("variant")) {
        "tip" -> ChipTone.GREEN
        "warning" -> ChipTone.AMBER
        "danger" -> ChipTone.RED
        else -> ChipTone.BLUE
    }
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.padding(vertical = 8.dp).fillMaxWidth().background(tone.bg, shape).border(1.dp, tone.border, shape).padding(horizontal = 12.dp, vertical = 8.dp)) {
        n.content.forEach { Block(it) }
    }
}

/**
 * A programming barcode: black on a white panel with a 16 dp quiet zone in either theme, drawn
 * at its `width` dp and shrunk only to fit, with no smoothing; the caption below it.
 */
@Composable
private fun Barcode(n: DocNode) {
    val c = LocalKioskColors.current
    val ctx = LocalContext.current
    val file = n.attrs.string("assetId") ?: return
    val image = remember(file) { runCatching { TroubleshootingContent.image(ctx, file) }.getOrNull() } ?: return
    val width = n.attrs.number("width")?.dp ?: with(LocalDensity.current) { image.width.toDp() }
    val caption = n.attrs.string("caption")
    Column(Modifier.padding(vertical = 8.dp)) {
        Box(Modifier.testTag("barcode-panel").background(Color.White).padding(16.dp)) {
            Image(
                image, contentDescription = n.attrs.string("alt"),
                filterQuality = FilterQuality.None, contentScale = ContentScale.Fit,
                modifier = Modifier.widthIn(max = width).fillMaxWidth().aspectRatio(image.width.toFloat() / image.height).testTag("barcode-$file"),
            )
        }
        if (!caption.isNullOrEmpty()) Text(caption, style = MaterialTheme.typography.bodySmall, color = c.textMute, modifier = Modifier.padding(top = 6.dp))
    }
}

private fun JsonObject?.primitive(key: String): JsonPrimitive? = this?.get(key) as? JsonPrimitive

private fun JsonObject?.string(key: String): String? = primitive(key)?.takeIf { it.isString }?.content

private fun JsonObject?.number(key: String): Int? = primitive(key)?.takeIf { !it.isString }?.doubleOrNull?.toInt()
