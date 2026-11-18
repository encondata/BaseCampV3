package com.serversherpa.kiosk.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.text.TextLayoutResult
import org.junit.Assert.fail

/*
 * The 320 dp fit check (spec 3.7), shared by CompactFitTest and the compact header tests in
 * other test packages.
 */

private fun describe(node: SemanticsNode): String {
    val text = node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ")
        ?: node.config.getOrNull(SemanticsProperties.EditableText)?.text
        ?: node.config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ")
        ?: node.config.getOrNull(SemanticsProperties.TestTag)
        ?: "(node ${node.id})"
    return "\"$text\""
}

/** A node's bounds in root pixels, not clipped by its ancestors. */
internal fun SemanticsNode.left() = positionInRoot.x

internal fun SemanticsNode.right() = positionInRoot.x + size.width

/**
 * Every node with text or a click action sits inside the screen: left >= 0 and
 * right <= the root's width.
 *
 * Unclipped bounds (position plus size), not `boundsInRoot`: the shell's page scrolls, and a
 * scroll container clips its children to its own bounds, so a node running off the right edge
 * would still report a `boundsInRoot` inside the screen. The content of a horizontally
 * scrolling row (a tab strip) may sit past the edge by design; the row itself must fit, and
 * the Settings tests check the selected tab separately.
 *
 * A Row squeezes its last child into whatever width is left rather than pushing it off the
 * edge, so a cut-off button's box sits inside the screen while its label is squeezed to
 * nothing, one letter per line. Text is therefore also cut off when it has no width, runs
 * past its own box, is ellipsized to nothing, or is broken inside a word (a letter or digit on
 * both sides of a line break): the box is narrower than one word. Text that ellipsizes with
 * some of it showing gives way by design and is not cut off.
 */
fun ComposeTestRule.assertNothingClippedHorizontally(where: String = "") {
    waitForIdle()
    val root = onRoot(useUnmergedTree = true).fetchSemanticsNode()
    val width = root.size.width.toFloat()
    val clipped = mutableListOf<String>()
    fun walk(node: SemanticsNode, inHorizontalScroll: Boolean) {
        val config = node.config
        val hasText = SemanticsProperties.Text in config || SemanticsProperties.EditableText in config
        val clickable = SemanticsActions.OnClick in config
        if ((hasText || clickable) && !inHorizontalScroll) {
            if (node.left() < -0.5f || node.right() > width + 0.5f) {
                clipped += "${describe(node)} spans ${node.left()}..${node.right()} px of $width"
            }
            squeezed(node)?.let { clipped += "${describe(node)} $it" }
        }
        val scrolls = SemanticsProperties.HorizontalScrollAxisRange in config
        for (child in node.children) walk(child, inHorizontalScroll || scrolls)
    }
    walk(root, false)
    if (clipped.isNotEmpty()) fail("Cut off at 320 dp${if (where.isEmpty()) "" else " ($where)"}:\n" + clipped.joinToString("\n"))
}

/** Why [node]'s text is squeezed inside its own box, or null when it shows whole. */
private fun squeezed(node: SemanticsNode): String? {
    val text = node.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text } ?: return null
    if (text.isBlank()) return null
    if (node.size.width <= 0) return "is squeezed to no width"
    val layouts = mutableListOf<TextLayoutResult>()
    node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layouts)
    val layout = layouts.firstOrNull() ?: return null
    // An ellipsized line gives way on purpose and draws inside its box, though its reported right
    // edge is the line's before the ellipsis. It is cut off only when no character is left.
    for (line in 0 until layout.lineCount) {
        if (layout.isLineEllipsized(line) && layout.getLineEnd(line, visibleEnd = true) <= layout.getLineStart(line)) {
            return "is ellipsized to nothing in a ${node.size.width} px box"
        }
    }
    // Any other line wider than the laid-out text (a whole pixel, past sub-pixel rounding) is cut off.
    val widest = (0 until layout.lineCount).filterNot { layout.isLineEllipsized(it) }
        .maxOfOrNull { layout.getLineRight(it) - layout.getLineLeft(it) } ?: 0f
    if (widest - layout.size.width > 1f) return "runs ${widest - layout.size.width} px past its own ${layout.size.width} px box"
    val shown = layout.layoutInput.text.text
    for (line in 0 until layout.lineCount - 1) {
        val end = layout.getLineEnd(line)
        if (end in 1 until shown.length && shown[end - 1].isLetterOrDigit() && shown[end].isLetterOrDigit()) {
            return "is broken inside a word (\"${shown.substring(0, end)}|${shown.substring(end).take(12)}\") in a ${node.size.width} px box"
        }
    }
    return null
}
