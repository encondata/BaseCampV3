package com.serversherpa.kiosk.core.troubleshooting

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.data.troubleshooting.TroubleshootingContent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The bundled guides in assets/troubleshooting (byte-for-byte copies of kiosk/src/troubleshooting),
 *  parsed by core's [TroubleshootingJson] and loaded by data's [TroubleshootingContent]. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TroubleshootingTest {
    @get:Rule val fonts = NativeFontsSettled()

    private val ctx = ApplicationProvider.getApplicationContext<Application>()

    @Test fun topicsIsTheScannerGuide() {
        assertEquals(
            listOf(Topic("zebra-ds22", "Zebra Scanner Troubleshooting", "Set up, pair, and reset Zebra DS22 scanners, with programming barcodes.", "zebra-ds22.json")),
            TroubleshootingContent.topics(ctx),
        )
    }

    @Test fun theDocParsesWithEveryTopLevelNode() {
        val topic = TroubleshootingContent.topics(ctx).single()
        val doc = TroubleshootingContent.doc(ctx, topic)
        val raw = ctx.assets.open("troubleshooting/zebra-ds22.json").use { Json.parseToJsonElement(it.readBytes().decodeToString()) }
        assertEquals("doc", doc.type)
        assertEquals(raw.jsonObject.getValue("content").jsonArray.size, doc.content.size)
        assertTrue(doc.content.isNotEmpty())
    }

    @Test fun everyBundledImageDecodes() {
        val sizes = mapOf(
            "factory-defaults.png" to (612 to 245),
            "ds2208-usb-keyboard-hid.png" to (1139 to 245),
            "ds2278-hid-bluetooth-classic.png" to (1169 to 282),
            "ds2278-unpairing.png" to (1339 to 285),
            "add-enter-key.png" to (1528 to 292),
        )
        for ((file, size) in sizes) {
            val image = TroubleshootingContent.image(ctx, file)
            assertEquals(file, size, image.width to image.height)
        }
    }

    @Test fun unknownKeysAreIgnoredAndMissingOnesDefault() {
        val doc = TroubleshootingJson.doc("""{"type":"doc","version":3,"content":[{"type":"text","text":"hi","extra":{}}]}""")
        assertEquals(DocNode(type = "doc", content = listOf(DocNode(type = "text", text = "hi"))), doc)
    }

    @Test fun onlyPlainFileNamesAreRead() {
        assertTrue(TroubleshootingJson.isPlainFileName("add-enter-key.png"))
        for (bad in listOf("", ".", "..", "../secrets.json", "a/b.png", "a\\b.png")) assertFalse(bad, TroubleshootingJson.isPlainFileName(bad))
    }
}
