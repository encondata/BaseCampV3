package com.serversherpa.kiosk.input.rfid

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Spec test 23, the two never-call scans (spec, "Never call").
 *
 * The vendor scan reads only the two Zebra files and fails on any vendor call
 * the design rules out: calls that can end the process, stubs that always
 * throw, calls that change the sled's stored setup or start scanning for other
 * devices, and the second scanner SDK. `Dispose(` may appear once, inside
 * `tearDownVendor`, and `saveConfig(` only inside the batch-mode prevention,
 * recovery and teardown functions. `DCSSDK_DEVICE_SCAN_ENABLE` may appear
 * once, inside `scanEnable`: `VendorScannerSdk`'s, which the engine calls for
 * its checked scan enable after each establish. `DCSSDK_DEVICE_SCAN_DISABLE`
 * may appear nowhere. It also fails on `Thread.stop()`, which
 * the leaked-reader reaper must never use (it only interrupts): any `.stop(`
 * or `::stop` whose receiver is not the radio's `Inventory`.
 *
 * The device-settings scan reads all of `src/main/java` and fails on anything
 * that changes a setting of the phone itself: turning the Bluetooth adapter on
 * or off, writing system settings, locking the orientation, wake locks, and
 * keeping the screen on anywhere but the sled display effect.
 *
 * Both scans strip comments and string literals first, so KDoc and log lines
 * that name a forbidden call do not count, and neither reads `src/test`
 * (`ZebraReadersConstructibleTest` constructs a `Readers`). Run from the app
 * module, as Gradle does.
 */
class SledNeverCallTest {
    @Test fun theZebraFilesMakeNoForbiddenVendorCall() {
        val sources = ZEBRA_FILES.map { name ->
            val file = File(MAIN, "$RFID_DIR/$name")
            assertTrue("${file.path} not found (run from the app module)", file.isFile)
            name to file.readText()
        }
        // The stripper must leave the code in view: a literal it misread would
        // blank the rest of a file and let every pattern pass unseen.
        sources.forEach { (name, text) ->
            val code = stripCommentsAndStrings(text)
            assertEquals("$name keeps its line count once stripped", text.lines().size, code.lines().size)
            assertEquals(
                "$name's last function is still in view once stripped",
                FUN.findAll(text).last().groupValues[1],
                FUN.findAll(code).lastOrNull()?.groupValues?.get(1),
            )
        }
        val stripped = sources.associate { (name, text) -> name to stripCommentsAndStrings(text) }
        assertTrue("the teardown's Dispose( call is in view", "vendor.readers.Dispose()" in stripped.getValue("ZebraRfidReader.kt"))
        assertTrue("the scanner SDK's constructor call is in view", "SDKHandler(appContext, false)" in stripped.getValue("ZebraBarcodeEngine.kt"))
        val engine = stripped.getValue("ZebraBarcodeEngine.kt")
        val scanEnableAt = engine.indexOf("DCSSDK_COMMAND_OPCODE.DCSSDK_DEVICE_SCAN_ENABLE")
        assertTrue("the checked scan enable's opcode is in view", scanEnableAt >= 0)
        assertEquals(
            "the checked scan enable's opcode sits in VendorScannerSdk",
            "VendorScannerSdk",
            CLASS.findAll(engine.substring(0, scanEnableAt)).lastOrNull()?.groupValues?.get(1),
        )

        val findings = vendorFindings(sources)

        assertEquals("forbidden vendor calls in the Zebra files", emptyList<String>(), findings)
    }

    @Test fun noDeviceSettingIsChangedAnywhereInTheApp() {
        val root = File(MAIN)
        assertTrue("main sources missing at ${root.absolutePath}", root.isDirectory)
        val sources = root.walkTopDown()
            .filter { it.isFile && (it.extension == "kt" || it.extension == "java") }
            .map { it.relativeTo(root).invariantSeparatorsPath to it.readText() }
            .sortedBy { it.first }
            .toList()
        assertTrue("no sources found under ${root.absolutePath}", sources.any { it.first.endsWith("ZebraRfidReader.kt") })

        val findings = sources.flatMap { (path, text) -> deviceSettingFindings(path, text) }

        assertEquals("calls that change a device setting", emptyList<String>(), findings)
    }

    @Test fun theStripperIgnoresCommentsAndStrings() {
        val fixture = listOf(
            "// rfid.getCradleStatus(0)",
            "/* a block /* nested rfid.reconnect() */ still a comment .setBluetoothMode(true) */",
            "/**",
            " * KDoc: never call sdk.dcssdkEnableBluetoothScannersDiscovery(true).",
            " */",
            "val note = \"dcssdkClose(\"",
            "val raw = \"\"\"runInterruptible { reader.connect(name) }\"\"\"",
            "val quote = '\"'",
            "val sized = \"\${items.size} tags, then .reconnect(\"",
            "fun pick() { sdk.dcssdkClose() }",
            "val multi = \"\"\"",
            "  setScanDataEvent",
            "\"\"\"",
            "fun later() { rfid.getCradleStatus() }",
        ).joinToString("\n")

        val stripped = stripCommentsAndStrings(fixture)

        assertEquals("line breaks are kept", fixture.count { it == '\n' }, stripped.count { it == '\n' })
        assertEquals(
            listOf(
                "Fixture.kt:10 in pick(): dcssdkClose(",
                "Fixture.kt:14 in later(): .getCradleStatus(",
            ),
            vendorFindings(listOf("Fixture.kt" to fixture)),
        )
    }

    /** Each rule that depends on the arguments or on where the call sits flags its shape and spares the allowed one. */
    @Test fun eachRuleFlagsItsForbiddenShapeAndSparesTheAllowedOne() {
        val fixture = listOf(
            "fun open() {",
            "    rfid.connect()",
            "    readers.connect(device.name)",
            "    SDKHandler(context, false)",
            "    SDKHandler(context)",
            "    rfid.Config.setTriggerMode(mode, false)",
            "    rfid.Config.setTriggerMode(mode, true)",
            "    rfid.Actions.reset()",
            "    inventory.reset()",
            "    val readers = Readers(context, ENUM_TRANSPORT.ALL)",
            "    config.saveConfig()",
            "    if (plan.saveConfig) done()",
            "}",
            "fun preventBatchMode() { config.saveConfig() }",
            "fun recoverFromBatchMode() { config.saveConfig() }",
            "fun tearDownVendor() { config.saveConfig(); readers.Dispose() }",
            "fun dispose() { readers.Dispose() }",
            "fun reap(zombie: Thread) {",
            "    rfid.Actions.Inventory.stop()",
            "    rfid.Actions?.Inventory?.stop()",
            "    zombie.stop()",
            "    Thread.currentThread()?.stop()",
            "    threads.forEach(Thread::stop)",
            "}",
            "fun scanEnable(id: Int) = command(DCSSDK_COMMAND_OPCODE.DCSSDK_DEVICE_SCAN_ENABLE, id)",
            "fun armScanner(id: Int) = command(DCSSDK_COMMAND_OPCODE.DCSSDK_DEVICE_SCAN_ENABLE, id)",
            "fun standDown(id: Int) = command(DCSSDK_COMMAND_OPCODE.DCSSDK_DEVICE_SCAN_DISABLE, id)",
        ).joinToString("\n")

        assertEquals(
            listOf(
                "Fixture.kt:3 in open(): .connect( with an argument",
                "Fixture.kt:5 in open(): SDKHandler( with one argument",
                "Fixture.kt:7 in open(): setTriggerMode( with true",
                "Fixture.kt:8 in open(): Actions.reset(",
                "Fixture.kt:10 in open(): ENUM_TRANSPORT.ALL",
                "Fixture.kt:11 in open(): saveConfig( outside preventBatchMode, recoverFromBatchMode and tearDownVendor",
                "Fixture.kt:17 in dispose(): Dispose( outside tearDownVendor",
                "Fixture.kt:21 in reap(): $THREAD_STOP",
                "Fixture.kt:22 in reap(): $THREAD_STOP",
                "Fixture.kt:23 in reap(): $THREAD_STOP",
                "Fixture.kt:26 in armScanner(): DCSSDK_DEVICE_SCAN_ENABLE outside scanEnable",
                "Fixture.kt:27 in standDown(): DCSSDK_DEVICE_SCAN_DISABLE",
                "Dispose( appears 2 times; at most once, in tearDownVendor",
                "DCSSDK_DEVICE_SCAN_ENABLE appears 2 times; at most once, in scanEnable",
            ),
            vendorFindings(listOf("Fixture.kt" to fixture)),
        )

        val device = listOf(
            "fun settings() {",
            "    adapter.enable()",
            "    adapter?.disable()",
            "    feature.enable(true)",
            "    Settings.System.putInt(resolver, name, 1)",
            "    activity.requestedOrientation = 1",
            "    power.newWakeLock(flags, tag)",
            "    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)",
            "    view.keepScreenOn = true",
            "}",
        ).joinToString("\n")
        assertEquals(
            listOf(
                "ui/Other.kt:2: .enable()",
                "ui/Other.kt:3: .disable()",
                "ui/Other.kt:5: Settings.System.put",
                "ui/Other.kt:6: requestedOrientation",
                "ui/Other.kt:7: newWakeLock(",
                "ui/Other.kt:8: FLAG_KEEP_SCREEN_ON",
                "ui/Other.kt:9: keepScreenOn",
            ),
            deviceSettingFindings("ui/Other.kt", device),
        )
        assertEquals(emptyList<String>(), deviceSettingFindings(DISPLAY_EFFECT, "fun keep(view: View) { view.keepScreenOn = true }"))
    }

    // ---- the vendor scan ----

    private fun vendorFindings(sources: List<Pair<String, String>>): List<String> {
        val findings = mutableListOf<Finding>()
        var disposeCount = 0
        var scanEnableCount = 0
        for ((name, source) in sources) {
            val code = stripCommentsAndStrings(source)
            val functions = FUN.findAll(code).map { it.range.first to it.groupValues[1] }.toList()
            /** The nearest preceding `fun <name>(`, the function a match at [offset] sits in. */
            fun enclosing(offset: Int): String? = functions.lastOrNull { it.first < offset }?.second
            fun at(offset: Int): String {
                val line = code.substring(0, offset).count { it == '\n' } + 1
                val function = enclosing(offset)
                return if (function == null) "$name:$line" else "$name:$line in $function()"
            }

            for (pattern in VENDOR_PATTERNS) {
                patternRegex(pattern).findAll(code).forEach { findings += Finding(it.range.first, "${at(it.range.first)}: $pattern") }
            }
            callsOf(code, Regex("""\.connect\s*\(""")).filter { (_, args) -> args.isNotEmpty() }
                .forEach { findings += Finding(it.first, "${at(it.first)}: .connect( with an argument") }
            callsOf(code, Regex("""\bSDKHandler\s*\(""")).filter { (_, args) -> args.size == 1 }
                .forEach { findings += Finding(it.first, "${at(it.first)}: SDKHandler( with one argument") }
            callsOf(code, Regex("""\bsetTriggerMode\s*\(""")).filter { (_, args) -> args.any { TRUE.containsMatchIn(it) } }
                .forEach { findings += Finding(it.first, "${at(it.first)}: setTriggerMode( with true") }
            Regex("""\bActions\s*\??\.\s*reset\s*\(""").findAll(code)
                .forEach { findings += Finding(it.range.first, "${at(it.range.first)}: Actions.reset(") }
            Regex("""(?:\.\s*stop\s*\(|::\s*stop\b)""").findAll(code)
                .filterNot { INVENTORY_RECEIVER.containsMatchIn(code.substring(0, it.range.first)) }
                .forEach { findings += Finding(it.range.first, "${at(it.range.first)}: $THREAD_STOP") }
            Regex("""\bsaveConfig\s*\(""").findAll(code)
                .filter { enclosing(it.range.first) !in SAVE_CONFIG_HOMES }
                .forEach { findings += Finding(it.range.first, "${at(it.range.first)}: saveConfig( outside $SAVE_CONFIG_HOMES_TEXT") }
            Regex("""\bDispose\s*\(""").findAll(code).forEach {
                disposeCount++
                if (enclosing(it.range.first) != DISPOSE_HOME) {
                    findings += Finding(it.range.first, "${at(it.range.first)}: Dispose( outside $DISPOSE_HOME")
                }
            }
            Regex("""\b$SCAN_ENABLE\b""").findAll(code).forEach {
                scanEnableCount++
                if (enclosing(it.range.first) != SCAN_ENABLE_HOME) {
                    findings += Finding(it.range.first, "${at(it.range.first)}: $SCAN_ENABLE outside $SCAN_ENABLE_HOME")
                }
            }
        }
        val lines = findings.sortedWith(compareBy({ it.text.substringBefore(':') }, { it.offset })).map { it.text }.toMutableList()
        if (disposeCount > 1) lines += "Dispose( appears $disposeCount times; at most once, in $DISPOSE_HOME"
        if (scanEnableCount > 1) lines += "$SCAN_ENABLE appears $scanEnableCount times; at most once, in $SCAN_ENABLE_HOME"
        return lines
    }

    // ---- the device-settings scan ----

    private fun deviceSettingFindings(path: String, source: String): List<String> {
        val code = stripCommentsAndStrings(source)
        val patterns = if (path == DISPLAY_EFFECT) DEVICE_PATTERNS - KEEP_SCREEN_ON else DEVICE_PATTERNS
        return patterns.flatMap { pattern ->
            deviceRegex(pattern).findAll(code).map { it.range.first to "$path:${code.substring(0, it.range.first).count { c -> c == '\n' } + 1}: $pattern" }
        }.sortedBy { it.first }.map { it.second }
    }

    private fun deviceRegex(pattern: String): Regex = when (pattern) {
        ".enable()" -> Regex("""\.enable\s*\(\s*\)""")
        ".disable()" -> Regex("""\.disable\s*\(\s*\)""")
        else -> patternRegex(pattern)
    }

    // ---- shared ----

    private class Finding(val offset: Int, val text: String)

    /** [pattern] as written, with any whitespace allowed before a trailing `(`. */
    private fun patternRegex(pattern: String): Regex =
        if (pattern.endsWith("(")) Regex(Regex.escape(pattern.dropLast(1)) + """\s*\(""") else Regex(Regex.escape(pattern))

    /** Each call [opener] matches in [code], as its offset and its top-level arguments (blank ones dropped). */
    private fun callsOf(code: String, opener: Regex): List<Pair<Int, List<String>>> = opener.findAll(code).map { match ->
        val args = mutableListOf<String>()
        val current = StringBuilder()
        var depth = 0
        var i = match.range.last + 1
        while (i < code.length) {
            val c = code[i]
            if (depth == 0 && (c == ')' || c == ',')) {
                args += current.toString().trim()
                current.clear()
                if (c == ')') break
            } else {
                if (c == '(' || c == '[' || c == '{') depth++
                if (c == ')' || c == ']' || c == '}') depth--
                current.append(c)
            }
            i++
        }
        match.range.first to args.filter { it.isNotEmpty() }
    }.toList()

    /**
     * [source] with every `//` and `/* */` comment (nested ones included) and
     * the text of every string and char literal removed. A string becomes `""`
     * and a char `''`, so a call that passes one still has an argument; a
     * template's `${…}` code is kept, since it is code. Line breaks are kept
     * everywhere, so line numbers in the result match [source].
     */
    private fun stripCommentsAndStrings(source: String): String = Stripper(source).run()

    /** One pass over a Kotlin source for [stripCommentsAndStrings]. */
    private class Stripper(private val source: String) {
        private val out = StringBuilder(source.length)
        private var i = 0

        fun run(): String {
            code(inTemplate = false)
            return out.toString()
        }

        /** Writes only the line breaks of `source[from until to]`. */
        private fun keepBreaks(from: Int, to: Int) {
            for (k in from until minOf(to, source.length)) if (source[k] == '\n') out.append('\n')
        }

        /** Copies code from [i] to the end, or past the `}` that closes a template when [inTemplate]. */
        private fun code(inTemplate: Boolean) {
            var braces = 0
            while (i < source.length) {
                val c = source[i]
                when {
                    source.startsWith("//", i) -> {
                        while (i < source.length && source[i] != '\n') i++
                        out.append(' ')
                    }
                    source.startsWith("/*", i) -> blockComment()
                    c == '"' -> string()
                    c == '\'' -> charLiteral()
                    c == '`' -> {
                        val end = source.indexOf('`', i + 1).let { if (it < 0) source.length else it + 1 }
                        out.append(source, i, end)
                        i = end
                    }
                    inTemplate && c == '}' && braces == 0 -> {
                        i++
                        return
                    }
                    else -> {
                        if (c == '{') braces++
                        if (c == '}') braces--
                        out.append(c)
                        i++
                    }
                }
            }
        }

        /** A block comment, nested ones included, becomes one space plus its line breaks. */
        private fun blockComment() {
            val start = i
            var depth = 0
            while (i < source.length) {
                when {
                    source.startsWith("/*", i) -> {
                        depth++
                        i += 2
                    }
                    source.startsWith("*/", i) -> {
                        depth--
                        i += 2
                        if (depth == 0) break
                    }
                    else -> i++
                }
            }
            out.append(' ')
            keepBreaks(start, i)
        }

        /** A char literal such as `'"'` or `'\''` becomes `''`. */
        private fun charLiteral() {
            i++
            while (i < source.length && source[i] != '\'' && source[i] != '\n') i += if (source[i] == '\\') 2 else 1
            if (i < source.length && source[i] == '\'') i++
            out.append("''")
        }

        /** The string at [i], plain or raw, becomes `""`, keeping its templates' code and its line breaks. */
        private fun string() {
            val raw = source.startsWith("\"\"\"", i)
            i += if (raw) 3 else 1
            out.append('"')
            var textFrom = i
            while (i < source.length) {
                val c = source[i]
                when {
                    raw && source.startsWith("\"\"\"", i) -> {
                        keepBreaks(textFrom, i)
                        while (i < source.length && source[i] == '"') i++
                        out.append('"')
                        return
                    }
                    !raw && c == '"' -> {
                        keepBreaks(textFrom, i)
                        i++
                        out.append('"')
                        return
                    }
                    !raw && c == '\\' -> i += 2
                    c == '$' && source.getOrNull(i + 1) == '{' -> {
                        keepBreaks(textFrom, i)
                        i += 2
                        code(inTemplate = true)
                        textFrom = i
                    }
                    else -> i++
                }
            }
            keepBreaks(textFrom, i)
            out.append('"')
        }
    }

    private companion object {
        /** The main sources, relative to the app module. */
        const val MAIN = "src/main/java"
        const val RFID_DIR = "com/serversherpa/kiosk/input/rfid"
        val ZEBRA_FILES = listOf("ZebraRfidReader.kt", "ZebraBarcodeEngine.kt")

        /** The one file that may keep the screen on (spec, App wiring), relative to [MAIN]. */
        const val DISPLAY_EFFECT = "com/serversherpa/kiosk/ui/SledDisplayEffect.kt"

        /** The vendor patterns matched as written; the argument and placement rules are in [vendorFindings]. */
        val VENDOR_PATTERNS = listOf(
            ".getCradleStatus(",
            ".setBluetoothMode(",
            "import com.zebra.barcode.sdk",
            "dcssdkEnableAutomaticSessionReestablishment",
            "dcssdkEnableAvailableScannersDetection",
            "dcssdkStartScanForAvailableDevices",
            "dcssdkSetSTCEnabledState",
            "dcssdkEnableBluetoothScannersDiscovery",
            "dcssdkClose(",
            "DCSSDK_DEVICE_SCAN_DISABLE",
            "DCSSDK_OPMODE_BT_LE",
            "DCSSDK_OPMODE_SNAPI",
            "DCSSDK_OPMODE_USB_CDC",
            "ENUM_TRANSPORT.ALL",
            ".reconnect(",
            "setScanBatchMode(",
            "setUsbBatchMode(",
            "resetFactoryDefaults(",
            "PostConnectReaderUpdate(",
            "setScanDataEvent",
            "getKeylayoutType(",
            "runInterruptible",
        )

        /**
         * `Thread.stop()`, which the leaked-reader reaper must never use. The
         * matcher cannot see types, so it flags every `.stop(` call and `::stop`
         * reference whose receiver is not `Inventory`, the radio's one stop.
         */
        const val THREAD_STOP = ".stop( or ::stop not on Inventory (Thread.stop)"

        /** The code just before a `.stop(` or `::stop` ends in the receiver `Inventory` (or `Inventory?`). */
        val INVENTORY_RECEIVER = Regex("""\bInventory\s*\??\s*$""")

        const val DISPOSE_HOME = "tearDownVendor"

        /** The scan enable's opcode, allowed once: in `VendorScannerSdk.scanEnable`, the engine's checked scan enable (hardware, 2026-11-17). */
        const val SCAN_ENABLE = "DCSSDK_DEVICE_SCAN_ENABLE"
        const val SCAN_ENABLE_HOME = "scanEnable"

        val SAVE_CONFIG_HOMES = setOf("preventBatchMode", "recoverFromBatchMode", "tearDownVendor")
        const val SAVE_CONFIG_HOMES_TEXT = "preventBatchMode, recoverFromBatchMode and tearDownVendor"

        const val KEEP_SCREEN_ON = "keepScreenOn"
        val DEVICE_PATTERNS = listOf(
            ".enable()",
            ".disable()",
            "Settings.System.put",
            "Settings.Global.put",
            "Settings.Secure.put",
            "requestedOrientation",
            "newWakeLock(",
            "FLAG_KEEP_SCREEN_ON",
            KEEP_SCREEN_ON,
        )

        /** A function declaration and its name: `fun name(`, `fun <T> name(`, `fun Receiver.name(`. */
        val FUN = Regex("""\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(""")

        /** A class declaration and its name (`class Name`, `enum class Name`, ...). */
        val CLASS = Regex("""\bclass\s+(\w+)""")
        val TRUE = Regex("""\btrue\b""")
    }
}
