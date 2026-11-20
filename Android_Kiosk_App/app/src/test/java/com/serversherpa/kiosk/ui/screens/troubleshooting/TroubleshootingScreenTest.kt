package com.serversherpa.kiosk.ui.screens.troubleshooting

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onParent
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.serversherpa.kiosk.LocalAppContainer
import com.serversherpa.kiosk.NativeFontsSettled
import com.serversherpa.kiosk.core.troubleshooting.DocNode
import com.serversherpa.kiosk.core.troubleshooting.Mark
import com.serversherpa.kiosk.testContainer
import com.serversherpa.kiosk.ui.Routes
import com.serversherpa.kiosk.ui.screens.home.HomeScreen
import com.serversherpa.kiosk.ui.theme.KioskTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Troubleshooting list and a topic page on a 360 dp phone. Review Focus: a barcode stays
 * black on a white panel in either theme, shrinks to fit (never enlarges), and nothing runs off
 * the screen; an unknown topic says so and offers the way back.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp")
class TroubleshootingScreenTest {
    private val compose = createComposeRule()
    @get:Rule val rules: RuleChain = RuleChain.outerRule(NativeFontsSettled()).around(compose)

    /** Each barcode in the shipped doc, with its `width` in dp. */
    private val barcodes = mapOf(
        "factory-defaults.png" to 190,
        "ds2208-usb-keyboard-hid.png" to 350,
        "ds2278-hid-bluetooth-classic.png" to 360,
        "ds2278-unpairing.png" to 410,
        "add-enter-key.png" to 470,
    )

    private lateinit var view: View
    private lateinit var nav: NavHostController

    /** The routes as KioskApp wires them, minus the shell; the shell's 16 dp page padding kept. */
    private fun showRoutes() {
        compose.setContent {
            view = LocalView.current
            KioskTheme {
                val nav = rememberNavController().also { nav = it }
                Box(Modifier.fillMaxSize().padding(16.dp)) {
                    NavHost(nav, startDestination = Routes.TROUBLESHOOTING) {
                        composable(Routes.TROUBLESHOOTING) { TroubleshootingScreen(nav) }
                        composable(Routes.TROUBLESHOOTING_TOPIC, arguments = listOf(navArgument("topicId") { type = NavType.StringType })) { entry ->
                            TroubleshootingTopicScreen(nav, entry.arguments?.getString("topicId"))
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    private fun showTopic(id: String, theme: String = "light") {
        compose.setContent {
            view = LocalView.current
            KioskTheme(theme = theme) {
                Box(Modifier.fillMaxSize().padding(16.dp)) { TroubleshootingTopicScreen(rememberNavController(), id) }
            }
        }
        compose.waitForIdle()
    }

    private fun shot(): Bitmap {
        val b = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        compose.runOnUiThread { view.draw(Canvas(b)) }
        return b
    }

    @Test fun theListShowsTheScannerTopicAndOpensIt() {
        showRoutes()
        compose.onNodeWithText("Troubleshooting").assertExists()
        compose.onNodeWithText("Zebra Scanner Troubleshooting").assertExists()
        compose.onNodeWithText("Set up, pair, and reset Zebra DS22 scanners, with programming barcodes.").assertExists()
        compose.onNodeWithTag("topic-zebra-ds22").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Appendix: programming barcodes").assertExists()
        compose.onNodeWithText("Set up, pair, and reset Zebra DS22 scanners, with programming barcodes.").assertDoesNotExist()
    }

    @Test fun anUnknownTopicSaysSoAndGoesBack() {
        showRoutes()
        compose.runOnIdle { nav.navigate(Routes.troubleshootingTopic("nope")) }
        compose.waitForIdle()
        compose.onNodeWithText("This topic isn't available.").assertExists()
        compose.onNodeWithText("Back to Troubleshooting").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Zebra Scanner Troubleshooting").assertExists()
        compose.onNodeWithText("This topic isn't available.").assertDoesNotExist()
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun barcodesSitOnWhiteAndFitA360dpPhone() = assertBarcodes("light")

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun barcodesStayOnWhiteInTheDarkTheme() = assertBarcodes("dark")

    private fun assertBarcodes(theme: String) {
        showTopic("zebra-ds22", theme)
        compose.onNodeWithText("Appendix: programming barcodes").assertExists()
        val density = compose.density.density
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        // 360 dp less the shell's page padding and the panel's own padding, both sides.
        val room = 360 - 2 * 16 - 2 * 16
        for ((file, width) in barcodes) {
            val image = compose.onNodeWithTag("barcode-$file", useUnmergedTree = true)
            image.onParent().assert(hasTestTag("barcode-panel"))
            image.onParent().performScrollTo()   // the whole panel, so its bounds aren't clipped
            compose.waitForIdle()
            val img = image.fetchSemanticsNode().boundsInRoot
            val panel = image.onParent().fetchSemanticsNode().boundsInRoot

            // Drawn at its width, shrunk only to fit the phone.
            val expected = minOf(width, room) * density
            assertEquals("$file width", expected, img.width, 1f)
            assertTrue("$file runs off the screen: $panel in $root", panel.left >= root.left && panel.right <= root.right)
            // At least 16 dp of panel around the image on every side.
            for ((side, gap) in listOf("left" to img.left - panel.left, "right" to panel.right - img.right, "top" to img.top - panel.top, "bottom" to panel.bottom - img.bottom)) {
                assertTrue("$file $side padding is $gap px", gap >= 16 * density - 0.5f)
            }

            // The quiet zone is white and the bars are black, whatever the theme.
            val bmp = shot()
            for ((x, y) in listOf(panel.left + 3 to panel.top + 3, panel.right - 4 to panel.bottom - 4, panel.left + 3 to img.center.y, img.center.x to panel.top + 3)) {
                assertEquals("$file panel at ($x, $y) in $theme", android.graphics.Color.WHITE, bmp.getPixel(x.toInt(), y.toInt()))
            }
            val y = img.center.y.toInt()
            val darkest = (img.left.toInt() until img.right.toInt()).minOf { android.graphics.Color.red(bmp.getPixel(it, y)) }
            assertTrue("$file has no black bars ($darkest)", darkest < 60)
        }
        compose.onNodeWithText("Add Enter Key (Carriage Return/Line Feed)").assertExists()   // its caption
        assertInside(compose.onRoot(useUnmergedTree = true).fetchSemanticsNode(), root.right)
    }

    /** Nothing in the page (tables included) is wider than the phone. */
    private fun assertInside(node: SemanticsNode, right: Float) {
        assertTrue("${node.config} ends at ${node.boundsInRoot.right} > $right", node.boundsInRoot.right <= right + 0.5f)
        node.children.forEach { assertInside(it, right) }
    }

    @Test fun anUnknownNodeRendersNothingAndBoldStillShows() {
        compose.setContent {
            KioskTheme {
                WikiDoc(DocNode(type = "doc", content = listOf(
                    DocNode(type = "mystery", content = listOf(DocNode(type = "text", text = "hidden words"))),
                    DocNode(type = "paragraph", content = listOf(
                        DocNode(type = "text", text = "Plain "),
                        DocNode(type = "text", text = "bold", marks = listOf(Mark("bold"))),
                    )),
                )))
            }
        }
        compose.onNodeWithText("hidden words", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Plain bold").assertExists()
    }

    /** Before setup, Home's Troubleshooting tile is open and the banner names it. */
    @Test fun homeOffersTroubleshootingBeforeSetup() {
        val c = testContainer()
        compose.setContent { CompositionLocalProvider(LocalAppContainer provides c) { KioskTheme { HomeScreen(rememberNavController()) } } }
        compose.onNodeWithText("Kiosk setup is incomplete. Only Kiosk Setup, Troubleshooting and Settings are available.").assertExists()
        compose.onNodeWithTag("tile-TROUBLESHOOTING").assertExists().assertIsEnabled()
        compose.onNodeWithText("Fix common problems with kiosk hardware.").assertExists()
    }
}
