package com.serversherpa.kiosk.nettest

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Design 8: Internet Test comes out by deleting its package and every line
 * marked `// INTERNET-TEST` elsewhere in the app, with nothing restored by
 * hand. That is safe only while each marked line can be deleted as a whole
 * line without breaking or changing the code around it. So every marked line
 * outside the package must be one of the shapes in [DeletableShapes], and a
 * line that mixes original code with Internet Test code fails here with its
 * file and line number.
 */
class MarkedLinesAreDeletableTest {
    @Test fun everyMarkedLineInTheAppIsDeletable() {
        val root = File("src/main/java")
        assertTrue("${root.absolutePath} not found (run from the app module)", root.isDirectory)
        val files = root.walk()
            .filter { it.isFile && it.extension == "kt" }
            .filterNot { it.invariantSeparatorsPath.contains("/com/serversherpa/kiosk/nettest/") }
            .toList()
        val marked = files.sumOf { file -> file.readLines().count { DeletableShapes.MARKER in it } }
        assertTrue("no line outside the package carries ${DeletableShapes.MARKER}", marked > 0)

        val problems = files.flatMap { DeletableShapes.undeletable(it.relativeTo(root).invariantSeparatorsPath, it.readLines()) }

        assertEquals("marked lines that can't be deleted on their own", emptyList<String>(), problems)
    }

    @Test fun theWholeGuardCallOnOneMarkedLineIsRejected() {
        // The original bug: deleting this line would stop the app starting the move guard.
        assertRejected("        MoveSetupGuard(auth.state, prefs, scope, onDropped = internetTest::onSetupDropped).start() $MARK")
    }

    @Test fun aLineMixingOriginalCodeAndAnArgumentIsRejected() {
        assertRejected("    val api: KioskApi = OkHttpKioskApi(httpClient, config, session, route = InternetTestRoutes::portal) $MARK")
    }

    @Test fun eachDeletableShapeIsAccepted() {
        val file = listOf(
            "import com.serversherpa.kiosk.nettest.InternetTestRoutes $MARK",
            "class Api(",
            "    private val route: (OkHttpClient) -> OkHttpClient = { it }, $MARK",
            "    private val onDropped: suspend () -> Unit = {}, $MARK",
            ") {",
            "    val internetTest = InternetTest(dataStore, scope) $MARK",
            "    fun go() {",
            "        internetTest.beforeSignOut() $MARK",
            "        InternetTestSection() $MARK",
            "        NetTestChip(onClick = { nav.navigate(Routes.SETTINGS) }) $MARK",
            "        netTestFootValue()?.let { FootItem(it) } $MARK",
            "        OkHttpKioskApi(httpClient, config, session,",
            "            route = InternetTestRoutes::portal, $MARK",
            "        )",
            "        client",
            "            .let(route) $MARK",
            "            .let(InternetTestRoutes::portal) $MARK",
            "            .newCall(request)",
            "        onDropped() $MARK",
            "    }",
            "}",
        )

        assertEquals(emptyList<String>(), DeletableShapes.undeletable("Fixture.kt", file))
    }

    @Test fun otherUndeletableShapesAreRejected() {
        // Two arguments, one of them original.
        assertRejected("            timeout = 5, route = InternetTestRoutes::portal, $MARK")
        // A named argument that isn't Internet Test's.
        assertRejected("            timeout = 5, $MARK")
        // A chain step with the original call after it.
        assertRejected("            .let(route).newCall(request) $MARK", "    private val route: (OkHttpClient) -> OkHttpClient = { it }, $MARK")
        // A chain step or a bare call of something that isn't an added parameter.
        assertRejected("            .let(other) $MARK")
        assertRejected("        onDropped() $MARK")
        // A block opened on a marked line and closed on another.
        assertRejected("        netTestFootValue()?.let { $MARK")
        // Two statements on one line.
        assertRejected("        internetTest.beforeSignOut(); auth.logout() $MARK")
        // A call chain that starts with the routes object: deleting the line drops the original call too.
        assertRejected("        InternetTestRoutes.portal(client).newCall(req).enqueue(cb) $MARK")
        // The original call reshaped around the hook, as the first build had it.
        assertRejected("        try { route(client).newCall(request).execute() } catch (e: IOException) { throw ApiError(0, \"network\") } $MARK")
        assertRejected("        factory.createSocket() $MARK")
        // The marker not at the end of the line.
        assertRejected("        internetTest.beforeSignOut() $MARK and more")
    }

    private fun assertRejected(line: String, vararg context: String) {
        val file = context.toList() + line
        val problems = DeletableShapes.undeletable("Fixture.kt", file)
        assertEquals("expected only line ${file.size} rejected", listOf("Fixture.kt:${file.size}: ${line.trim()}"), problems)
    }

    private companion object {
        const val MARK = DeletableShapes.MARKER
    }
}

/**
 * The shapes a marked line may take outside the Internet Test package. Each
 * one can be deleted as a whole line and leaves the code around it exactly as
 * it was before Internet Test (a trailing comma before `)` aside, which Kotlin
 * compiles the same):
 *
 * 1. an import of a `com.serversherpa.kiosk.nettest.` symbol;
 * 2. a whole statement that starts with one of Internet Test's own names
 *    ([LEADING]), or `val internetTest = ...` (the container's property).
 *    `InternetTestRoutes` is not one of them: it hands back a client or a
 *    socket factory, so a statement that starts with it is a chain
 *    (`InternetTestRoutes.portal(client).newCall(req).enqueue(cb)`) whose
 *    original calls would go with the line;
 * 3. a named argument on its own line, `name = <expr>,`, whose expression
 *    names Internet Test;
 * 4. a constructor parameter with a default, `private val name: <type> = <default>,`,
 *    so no caller has to pass it;
 * 5. a chain step `.let(<expr>)` whose expression names Internet Test or a
 *    parameter added by shape 4 in the same file;
 * 6. a bare call `name()` of a parameter added by shape 4 in the same file.
 *
 * Each shape must also be one piece: brackets balanced, no `;` and no second
 * argument at the top level, so no original code can hide on the line. The
 * list is deliberately short. A new kind of touch point should be reshaped to
 * fit one of these before the list grows.
 */
internal object DeletableShapes {
    const val MARKER = "// INTERNET-TEST"

    /** Internet Test's own names that a marked statement or expression may use. */
    val SYMBOLS = setOf("internetTest", "InternetTest", "InternetTestRoutes", "InternetTestSection", "NetTestChip", "netTestFootValue")

    /**
     * The names a whole marked statement may start with. Not `InternetTestRoutes`:
     * it is allowed inside a `.let(...)` step or a named argument (shapes 3 and
     * 5), where the rest of the expression is original code, never at the head
     * of a statement.
     */
    val LEADING = SYMBOLS - "InternetTestRoutes"

    private val IMPORT = Regex("""import com\.serversherpa\.kiosk\.nettest\.\w+(\.\w+)*""")
    private val PROPERTY = Regex("""val internetTest = (.+)""")
    private val NAMED_ARGUMENT = Regex("""(\w+) = (.+),""")
    private val PARAMETER = Regex("""private val (\w+): (.+) = (.+),""")
    private val CHAIN_STEP = Regex("""\.let\((.+)\)""")
    private val BARE_CALL = Regex("""(\w+)\(\)""")
    private val WORD = Regex("""\w+""")

    /** The marked lines of [lines] that aren't a deletable shape, each as `file:line: text`. */
    fun undeletable(file: String, lines: List<String>): List<String> {
        val code = lines.map { it.trimEnd().removeSuffix(MARKER).trim() }
        val added = lines.indices
            .filter { MARKER in lines[it] }
            .mapNotNull { PARAMETER.matchEntire(code[it])?.groupValues?.get(1) }
            .toSet()
        return lines.indices
            .filter { MARKER in lines[it] }
            .filterNot { lines[it].trimEnd().endsWith(MARKER) && isDeletable(code[it], added) }
            .map { "$file:${it + 1}: ${lines[it].trim()}" }
    }

    private fun isDeletable(code: String, added: Set<String>): Boolean {
        if (!onePiece(code)) return false
        if (IMPORT.matches(code)) return true
        PROPERTY.matchEntire(code)?.let { return isStatementEnd(code) }
        NAMED_ARGUMENT.matchEntire(code)?.let { return onePiece(it.groupValues[2]) && names(it.groupValues[2], SYMBOLS) }
        PARAMETER.matchEntire(code)?.let { return onePiece(it.groupValues[2]) && onePiece(it.groupValues[3]) }
        CHAIN_STEP.matchEntire(code)?.let { return onePiece(it.groupValues[1]) && names(it.groupValues[1], SYMBOLS + added) }
        BARE_CALL.matchEntire(code)?.let { if (it.groupValues[1] in added) return true }
        return WORD.find(code)?.value in LEADING && code.first().isLetter() && isStatementEnd(code)
    }

    private fun names(expr: String, names: Set<String>): Boolean = WORD.findAll(expr).any { it.value in names }

    /** Ends where a statement can end, not mid-expression (an operator, a dot or a comma). */
    private fun isStatementEnd(code: String): Boolean = code.last().let { it.isLetterOrDigit() || it == ')' || it == '}' || it == ']' }

    /**
     * Brackets balanced, and no `;` or `,` outside them, string and char
     * literals aside. A comma inside the brackets of a call is fine; one at the
     * top level means a second argument or declaration shares the line.
     */
    private fun onePiece(code: String): Boolean {
        var depth = 0
        var i = 0
        while (i < code.length) {
            when (val c = code[i]) {
                '"', '\'' -> {
                    i++
                    while (i < code.length && code[i] != c) i += if (code[i] == '\\') 2 else 1
                    if (i >= code.length) return false
                }
                '(', '{', '[' -> depth++
                ')', '}', ']' -> if (--depth < 0) return false
                ';' -> if (depth == 0) return false
                ',' -> if (depth == 0 && i != code.lastIndex) return false
            }
            i++
        }
        return depth == 0
    }
}
