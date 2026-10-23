package com.serversherpa.kiosk.ui.screens.labels

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.LabelSettings
import com.serversherpa.kiosk.core.labels.PrintQueue
import com.serversherpa.kiosk.core.labels.PrintQueueDeps
import com.serversherpa.kiosk.core.labels.PrintState
import com.serversherpa.kiosk.core.labels.PrintStep
import com.serversherpa.kiosk.core.labels.PrinterConnection
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.model.KioskLabelFont
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.printer.BLUETOOTH_DENIED_TEXT
import com.serversherpa.kiosk.core.printer.BLUETOOTH_OFF_TEXT
import com.serversherpa.kiosk.core.printer.DirectoryEntry
import com.serversherpa.kiosk.core.printer.FONT_INSTALL_CUT_TEXT
import com.serversherpa.kiosk.core.printer.HostId
import com.serversherpa.kiosk.core.printer.HostStatus
import com.serversherpa.kiosk.core.printer.LOCATION_OFF_TEXT
import com.serversherpa.kiosk.core.printer.SCAN_ENDED_EARLY_TEXT
import com.serversherpa.kiosk.core.printer.pairingLostText
import com.serversherpa.kiosk.data.api.KioskJson
import com.serversherpa.kiosk.data.db.KioskDatabase
import com.serversherpa.kiosk.data.db.LABEL_CONTEXT_META_KEY
import com.serversherpa.kiosk.data.db.LabelFontEntity
import com.serversherpa.kiosk.data.db.LabelTemplateEntity
import com.serversherpa.kiosk.data.db.MOVE_META_KEY
import com.serversherpa.kiosk.data.db.MetaEntity
import com.serversherpa.kiosk.data.labels.LabelBuilder
import com.serversherpa.kiosk.data.labels.LabelEngine
import com.serversherpa.kiosk.data.labels.LabelSettingsStore
import com.serversherpa.kiosk.data.prefs.KioskPrefs
import com.serversherpa.kiosk.data.printer.BluetoothAvailability
import com.serversherpa.kiosk.data.printer.BluetoothPairingLost
import com.serversherpa.kiosk.data.printer.BluetoothPrinterInfo
import com.serversherpa.kiosk.data.printer.BluetoothScanEnd
import com.serversherpa.kiosk.data.printer.BluetoothUnavailable
import com.serversherpa.kiosk.data.printer.FakeBluetoothPrinting
import com.serversherpa.kiosk.data.printer.FoundBluetoothPrinter
import com.serversherpa.kiosk.data.printer.FoundPrinter
import com.serversherpa.kiosk.data.printer.PrinterGuard
import com.serversherpa.kiosk.data.printer.PrinterLock
import com.serversherpa.kiosk.data.printer.PrinterNoReply
import com.serversherpa.kiosk.data.printer.PrinterTimeout
import com.serversherpa.kiosk.data.printer.PrinterUnreachable
import com.serversherpa.kiosk.data.printer.SetupZebra
import com.serversherpa.kiosk.data.printer.WriteProgress
import com.serversherpa.kiosk.data.printer.lockedSender
import com.serversherpa.kiosk.data.sync.SyncMeta
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.data.sync.SyncStatus
import java.io.File
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The generator for Printer Setup: a plan per DPI (a "Vegas Top" template at 203, none at 300),
 * the test labels, and the two send-time helpers spelled out so a test can see what went in.
 */
private class SetupEngine : LabelEngine {
    val calls: MutableList<Pair<String, JsonObject>> = Collections.synchronizedList(ArrayList())
    @Volatile var planFonts: List<String> = emptyList()
    @Volatile var planFails = false

    override suspend fun call(fn: String, argsJson: String): String {
        val a = KioskJson.parseToJsonElement(argsJson).jsonObject
        calls += fn to a
        fun zplOut(z: String) = buildJsonObject { put("zpl", z) }.toString()
        return when (fn) {
            "buildPlan" -> {
                if (planFails) throw IllegalStateException("isolate died")
                val dpi = a["dpi"]!!.jsonPrimitive.int
                val picked = dpi == 203
                buildJsonObject {
                    put("templateId", if (picked) JsonPrimitive("t1") else JsonNull)
                    put("templateFamily", if (picked) JsonPrimitive("vegas") else JsonNull)
                    put("notes", JsonArray(if (picked) emptyList() else listOf(JsonPrimitive("Vegas Top is at 203 DPI only."))))
                    put("fonts", JsonArray(if (picked) planFonts.map { JsonPrimitive(it) } else emptyList()))
                    put("availableDpis", JsonArray(if (picked) emptyList() else listOf(JsonPrimitive(203))))
                    put("hasAssetData", true)
                    put("jobs", JsonArray(emptyList()))
                }.toString()
            }
            "alignmentTestZpl" -> zplOut("ALIGN ${a["widthDots"]!!.jsonPrimitive.int}x${a["heightDots"]!!.jsonPrimitive.int} ${a["sizeLabel"]!!.jsonPrimitive.content} ${a["dpi"]!!.jsonPrimitive.int}")
            "sampleLabel" -> buildJsonObject {
                put("zpl", "SAMPLE ${a["kind"]!!.jsonPrimitive.content} ${a["dpi"]!!.jsonPrimitive.int}"); put("reason", JsonNull)
            }.toString()
            "applyPrintSettings" -> zplOut("LT${a["verticalOffset"]!!.jsonPrimitive.int}LS${a["horizontalOffset"]!!.jsonPrimitive.int}|${a["zpl"]!!.jsonPrimitive.content}")
            "withPrintMode" -> zplOut(a["zpl"]!!.jsonPrimitive.content + if (a["peel"]!!.jsonPrimitive.boolean) "|MMP" else "|MMT")
            else -> error("unexpected $fn")
        }
    }
}

/** The printer's one port: every connection to it, in the order they began, and how many were open
 *  at once. A connection whose text contains [hold] stays open while [hold] is set. */
private class FakeLine {
    val started: MutableList<String> = Collections.synchronizedList(ArrayList())
    private val open = AtomicInteger(0)
    val maxOpen = AtomicInteger(0)
    @Volatile var hold: String? = null
    @Volatile var held = false

    suspend fun connect(what: String) {
        started += what
        maxOpen.accumulateAndGet(open.incrementAndGet(), ::maxOf)
        try {
            while (hold?.let { what.contains(it) } == true) {
                held = true
                delay(2)
            }
        } finally {
            open.decrementAndGet()
        }
    }
}

/** A Zebra at one host: what it says, and what it was sent. */
private class FakeZebra(val host: String) : SetupZebra {
    @Volatile var answers = true
    @Volatile var dpi = 203
    @Volatile var model = "ZD421"
    @Volatile var serialNo: String? = "S-$host"
    @Volatile var peeler: Boolean? = null
    @Volatile var paperOut = false
    /** When set, status() waits for it (after completing [inStatus]). */
    @Volatile var statusGate: CompletableDeferred<Unit>? = null
    val inStatus = CompletableDeferred<Unit>()
    /** Thrown by send() when set. */
    @Volatile var sendError: Exception? = null
    /** Thrown by installFont() when set, once the font started going out (after its first progress
     *  report). A printer that doesn't answer fails before anything goes out. */
    @Volatile var installError: Exception? = null
    /** The fractions of each font installFont() reports as sent, in order. */
    @Volatile var installSteps: List<Double> = listOf(1.0)
    /** While equal to one of [installSteps], installFont() waits right after reporting it. */
    @Volatile var installHoldAt: Double? = null
    /** The step installFont() is waiting at. */
    @Volatile var atInstallHold: Double? = null
    @Volatile var line: FakeLine? = null
    /** Every call that reaches the printer throws this when set (a Bluetooth refusal, say). */
    @Volatile var failWith: Exception? = null
    /** The E: drive: each object's name and size. */
    val onE: MutableList<DirectoryEntry> = Collections.synchronizedList(ArrayList())
    val sent: MutableList<String> = Collections.synchronizedList(ArrayList())
    val installed: MutableList<Pair<String, ByteArray>> = Collections.synchronizedList(ArrayList())
    /** Every call, in order. */
    val calls: MutableList<String> = Collections.synchronizedList(ArrayList())

    private suspend fun use(what: String, detail: String = "") {
        calls += what
        failWith?.let { throw it }
        if (!answers) throw PrinterUnreachable(host)
        line?.connect("$host $what" + if (detail.isEmpty()) "" else " $detail")
    }

    override suspend fun identify(): HostId { use("identify"); return HostId(model, "V1", if (dpi == 300) 12 else 8, "8192", dpi) }
    override suspend fun serial(): String? { use("serial"); return serialNo }
    override suspend fun status(): HostStatus {
        use("status")
        statusGate?.let { inStatus.complete(Unit); it.await() }
        return HostStatus(paperOut, false, 0, 0, false, false, false, false, false, false, false, false, "0", false, 0)
    }
    /** Like the transport's: null, never an error, when nothing answers. */
    override suspend fun peelerPresent(): Boolean? { calls += "peeler"; return if (answers && failWith == null) peeler else null }
    override suspend fun fonts(): List<String> = fontEntries().map { it.name }
    override suspend fun fontEntries(): List<DirectoryEntry> { use("fonts"); return synchronized(onE) { onE.toList() } }
    /** Printer Setup never sends a raw query (Troubleshooting does). */
    override suspend fun query(command: String, complete: (ByteArray) -> Boolean): String { use("query", command); throw PrinterNoReply(host) }
    override suspend fun send(zpl: String) {
        use("send", zpl)
        sendError?.let { throw it }
        sent += zpl
    }
    override suspend fun installFont(name: String, bytes: ByteArray, progress: WriteProgress?) {
        use("installFont", name)
        val total = bytes.size.toLong()
        progress?.invoke(0, total) // the download started
        installError?.let { throw it }
        for (step in installSteps) {
            progress?.invoke((total * step).toLong(), total)
            while (installHoldAt == step) {
                atInstallHold = step
                delay(2)
            }
            atInstallHold = null
        }
        installed += name to bytes
        synchronized(onE) {
            onE.removeAll { it.name == name.uppercase() }
            onE += DirectoryEntry(name.uppercase(), bytes.size)
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrinterSetupViewModelTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var db: KioskDatabase
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val engine = SetupEngine()
    private val zebras = HashMap<String, FakeZebra>()
    private var scanResult: List<FoundPrinter> = emptyList()
    private lateinit var store: LabelSettingsStore
    private lateinit var builder: LabelBuilder
    private lateinit var fontsDir: File
    private val lock = PrinterLock()
    private val guard = PrinterGuard()

    private val savedHost = "10.0.0.5"
    private val saved = SavedPrinter(savedHost, "ZD421", "S1", 203)
    private val bt = FakeBluetoothPrinting()
    private val btSerial = "D8J224508535"
    private val btAddress = "AC:3F:A4:00:00:01"
    private val btPrinter = SavedPrinter(PrinterConnection.Bluetooth(btSerial, btAddress), "ZD421", btSerial, 203)

    /** A device a Bluetooth scan heard (a Zebra's name is its serial). */
    private fun found(name: String = btSerial, address: String = btAddress, rssi: Int = -52, zebra: Boolean = false) =
        FoundBluetoothPrinter(address, name, rssi, zebra)

    private fun zebra(host: String) = synchronized(zebras) { zebras.getOrPut(host) { FakeZebra(host) } }

    @Before fun setUp() = runBlocking<Unit> {
        db = KioskDatabase.inMemory(ApplicationProvider.getApplicationContext())
        fontsDir = tmp.newFolder("label-fonts")
        val meta = SyncMeta("i1", "Move A", 0, 0, 0, 0, "2026-10-21T00:00:00Z")
        db.meta().put(MetaEntity(MOVE_META_KEY, KioskJson.encodeToString(SyncMeta.serializer(), meta)))
        db.meta().put(MetaEntity(LABEL_CONTEXT_META_KEY, """{"move_name":"Move A","catalog_keys":[]}"""))
        db.labelTemplates().insertAll(listOf(LabelTemplateEntity("t1", """{"id":"t1","name":"Vegas Top","width_in":4,"height_in":2.0}""")))
        val prefs = KioskPrefs(PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "setup.preferences_pb") })
        prefs.setSetupSelection(KioskSetupSelection("i1", "Move", "s1", "Site", "source", "pre_stage", "Pre-stage"))
        store = LabelSettingsStore(prefs)
        store.setPrinter(saved)
        builder = LabelBuilder(db, engine, store, scope)
        builder.start(MutableStateFlow(SyncStatus(SyncPhase.DONE)))
    }

    @After fun tearDown() { scope.cancel(); db.close() }

    /** [screen]: the view model's own scope, for a test that closes the screen (cancels it);
     *  [nanoTime]: the clock the install's time left is measured by. */
    private fun vm(pickWaitMs: Long = 5_000, screen: CoroutineScope = scope, nanoTime: () -> Long = System::nanoTime) = PrinterSetupViewModel(
        store, builder.pick, builder.status, engine, db, fontsDir,
        scanner = { scanResult }, bluetooth = bt,
        // A network printer by its host, a Bluetooth one by its serial.
        zebraFor = { p -> zebra(p.host ?: (p.connection as PrinterConnection.Bluetooth).serial) }, printerLock = lock, printerGuard = guard,
        scopeOverride = screen, pickWaitMs = pickWaitMs, nanoTime = nanoTime,
    )

    /** A virtual clock for the install's time left: [FakeClock.ns] is what the view model reads. */
    private class FakeClock {
        @Volatile var ns = 0L
        fun advanceMs(ms: Long) { ns += ms * 1_000_000 }
    }

    /** Waits (real time: Room, DataStore and the builder run on their own threads) for [cond]. */
    private suspend fun eventually(what: String, cond: suspend () -> Boolean) {
        try {
            withTimeout(8_000) { while (!cond()) delay(20) }
        } catch (e: Exception) {
            throw AssertionError("never: $what", e)
        }
    }

    private fun PrinterSetupViewModel.row(key: CheckKey) = state.value.checks.firstOrNull { it.key == key }

    /** Runs [start] and waits for the check run it starts to finish. */
    private suspend fun PrinterSetupViewModel.checked(start: () -> Unit) {
        val before = state.value.checkRuns
        start()
        eventually("checks finished") { state.value.checkRuns > before && !state.value.checking }
    }

    @Test fun aScanListsTheFoundPrintersAndSavingOneWithANewDpiRebuildsTheLabels() = runBlocking<Unit> {
        val found = listOf(FoundPrinter("10.0.0.7", "ZT230", "SER9", 300), FoundPrinter("10.0.0.8", null, null, null))
        scanResult = found
        zebra("10.0.0.7").apply { dpi = 300; model = "ZT230"; serialNo = "SER9" }
        val vm = vm()
        vm.scan()
        eventually("scan done") { vm.state.value.found == found }
        assertNull(vm.state.value.scanMessage)

        vm.checked { vm.choose(found[0]) }
        assertEquals(SavedPrinter("10.0.0.7", "ZT230", "SER9", 300), store.settings.first().printer)
        // the builder rebuilt by itself: a plan at the new DPI
        assertTrue(engine.calls.any { it.first == "buildPlan" && it.second["dpi"]!!.jsonPrimitive.int == 300 })
        assertEquals(CheckState.OK, vm.row(CheckKey.ANSWERS)!!.state)
        assertEquals("ZT230 · 300 DPI", vm.row(CheckKey.ANSWERS)!!.detail)
        val dpi = vm.row(CheckKey.DPI)!!
        assertEquals(CheckState.WARN, dpi.state)
        assertEquals(
            "This move's Top template prints at 203 DPI only; this printer is 300 DPI. " +
                "Activate a 300 DPI version on Labels › Templates, or use a 203 DPI printer.",
            dpi.detail,
        )
        assertEquals(listOf("Vegas Top is at 203 DPI only."), dpi.notes)

        // A printer the scan couldn't identify is asked before it's saved; no serial reads as "".
        zebra("10.0.0.8").serialNo = null
        vm.checked { vm.choose(found[1]) }
        assertEquals(SavedPrinter("10.0.0.8", "ZD421", "", 203), store.settings.first().printer)
        assertEquals(CheckState.OK, vm.row(CheckKey.DPI)!!.state)
        assertEquals("Vegas Top", vm.row(CheckKey.DPI)!!.detail)
    }

    @Test fun anEmptyScanSaysSo() = runBlocking<Unit> {
        val vm = vm()
        vm.scan()
        eventually("scan done") { vm.state.value.found != null && !vm.state.value.scanning }
        assertEquals("No Zebra printers found on this network.", vm.state.value.scanMessage)
    }

    @Test fun aTypedIpIsValidatedAndOneThatDoesNotAnswerIsNotSaved() = runBlocking<Unit> {
        val vm = vm()
        vm.setIpText("10.0.300.1")
        vm.useIp()
        assertEquals("That isn't a valid IP address.", vm.state.value.chooseError)
        vm.setIpText("010.0.0.1") // a leading zero could be read as octal
        vm.useIp()
        assertEquals("That isn't a valid IP address.", vm.state.value.chooseError)

        zebra("10.0.0.9").answers = false
        vm.setIpText(" 10.0.0.9 ")
        vm.useIp()
        eventually("no answer") { vm.state.value.chooseError != null && vm.state.value.choosing == null }
        assertEquals("No Zebra printer answered at 10.0.0.9.", vm.state.value.chooseError)
        assertEquals(saved, store.settings.first().printer)

        vm.setIpText("10.0.0.10")
        vm.useIp()
        eventually("typed printer saved") { store.settings.first().printer == SavedPrinter("10.0.0.10", "ZD421", "S-10.0.0.10", 203) }
        assertNull(vm.state.value.chooseError)
    }

    @Test fun missingFontsAreListedAndInstallSendsEachInstallableFontThenRechecksClean() = runBlocking<Unit> {
        engine.planFonts = listOf("ROBOTO.TTF", "LATO.TTF")
        File(fontsDir, "roboto.ttf").writeBytes(byteArrayOf(1, 2, 3))
        File(fontsDir, "lato.ttf").writeBytes(byteArrayOf(4, 5))
        db.labelFonts().insertAll(listOf(
            LabelFontEntity("f1", "Roboto.ttf", 3, false, "roboto.ttf"),
            LabelFontEntity("f2", "LATO.TTF", 2, false, "lato.ttf"),
        ))
        builder.rebuild("fonts changed")
        eventually("plan with fonts") { builder.pick.value?.fonts?.size == 2 }
        val vm = vm()
        vm.checked { vm.checkAgain() }
        val fonts = vm.row(CheckKey.FONTS)!!
        assertEquals(CheckState.FAIL, fonts.state)
        assertEquals("Missing: ROBOTO.TTF, LATO.TTF.", fonts.detail)
        assertEquals(2, vm.state.value.fontFix!!.installable.size)

        vm.checked { vm.installFonts() }
        val z = zebra(savedHost)
        assertEquals(listOf("ROBOTO.TTF", "LATO.TTF"), z.installed.map { it.first.uppercase() })
        assertArrayEquals(byteArrayOf(1, 2, 3), z.installed[0].second)
        assertArrayEquals(byteArrayOf(4, 5), z.installed[1].second)
        assertEquals("Fonts installed.", vm.state.value.fontMessage)
        assertFalse(vm.state.value.fontError)
        assertEquals(CheckState.OK, vm.row(CheckKey.FONTS)!!.state)
        assertNull(vm.state.value.fontFix)
    }

    @Test fun aFontThatCannotBeInstalledSaysWhich() = runBlocking<Unit> {
        engine.planFonts = listOf("ROBOTO.TTF")
        db.labelFonts().insertAll(listOf(LabelFontEntity("f1", "ROBOTO.TTF", 3, false, "gone.ttf")))
        builder.rebuild("fonts changed")
        eventually("plan with fonts") { builder.pick.value?.fonts?.size == 1 }
        val vm = vm()
        vm.checked { vm.checkAgain() }
        vm.installFonts()
        eventually("install finished") { vm.state.value.fontMessage != null && !vm.state.value.installing }
        assertEquals("Couldn't install ROBOTO.TTF.", vm.state.value.fontMessage)
        assertTrue(vm.state.value.fontError)
    }

    @Test fun peelIsDisabledWhenThePrinterHasNoPeelerAndEnabledWhenItDoesNotSay() = runBlocking<Unit> {
        store.setPeel(true)
        val z = zebra(savedHost)
        z.peeler = false
        val vm = vm()
        vm.checked { vm.checkAgain() }
        assertEquals(false, vm.state.value.peeler)
        assertFalse(vm.state.value.peelAllowed)
        assertEquals("No peeler · printing in tear-off mode", vm.row(CheckKey.PEELER)!!.detail)
        // a peel setting the printer can't honor falls back to tear-off
        eventually("tear") { !store.settings.first().peel }
        vm.setPeel(true)
        delay(200)
        assertFalse(store.settings.first().peel)

        z.peeler = null
        vm.checked { vm.checkAgain() }
        assertNull(vm.state.value.peeler)
        assertTrue(vm.state.value.peelAllowed)
        assertEquals("Printer doesn't report a peeler · printing in tear-off mode", vm.row(CheckKey.PEELER)!!.detail)
        vm.setPeel(true)
        eventually("peel") { store.settings.first().peel }
        eventually("row says peel-off") { vm.row(CheckKey.PEELER)!!.detail == "Printer doesn't report a peeler · printing in peel-off mode" }
    }

    @Test fun anUnsyncedKioskSaysToSyncWithoutWaiting() = runBlocking<Unit> {
        db.meta().delete(MOVE_META_KEY)
        builder.stop()
        eventually("pick cleared") { builder.pick.value == null }
        val vm = vm(pickWaitMs = 60_000)
        val started = System.nanoTime()
        vm.checked { vm.checkAgain() }
        assertTrue((System.nanoTime() - started) / 1_000_000 < 5_000)
        assertEquals("Sync this kiosk to check its label templates.", vm.row(CheckKey.DPI)!!.detail)
        assertEquals(CheckState.WARN, vm.row(CheckKey.FONTS)!!.state)
    }

    @Test fun aFailedBuildEndsTheWaitAtOnce() = runBlocking<Unit> {
        eventually("first build") { builder.pick.value?.dpi == 203 }
        engine.planFails = true
        builder.rebuild("templates changed")
        eventually("failed pick") { builder.pick.value?.failed == true }
        val vm = vm(pickWaitMs = 60_000)
        val started = System.nanoTime()
        vm.checked { vm.checkAgain() }
        assertTrue((System.nanoTime() - started) / 1_000_000 < 5_000)
        assertEquals("Labels couldn't be made. Try syncing again.", vm.row(CheckKey.DPI)!!.detail)
    }

    @Test fun aTestLabelWaitsForTheCheckThatIsTalkingToThePrinter() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        val z = zebra(savedHost)
        val gate = CompletableDeferred<Unit>()
        z.statusGate = gate
        val vm = vm()
        vm.checkAgain()
        withTimeout(8_000) { z.inStatus.await() }
        vm.printTest(TestLabel.ALIGNMENT)
        delay(400)
        assertTrue(z.sent.isEmpty())
        assertTrue(vm.state.value.testing)
        gate.complete(Unit)
        eventually("sent after the status query") { z.sent.size == 1 && !vm.state.value.testing }
    }

    @Test fun checkAgainSavesTheModelSerialAndDpiOfAnotherPrinterAtTheSameAddress() = runBlocking<Unit> {
        val z = zebra(savedHost)
        z.model = "ZT230"; z.dpi = 300; z.serialNo = "NEW1"
        val vm = vm()
        vm.checked { vm.checkAgain() }
        assertEquals(SavedPrinter(savedHost, "ZT230", "NEW1", 300), store.settings.first().printer)

        z.model = "ZT410"; z.serialNo = null
        vm.checked { vm.checkAgain() }
        assertEquals(SavedPrinter(savedHost, "ZT410", "", 300), store.settings.first().printer)
    }

    @Test fun testLabelsAreSentWithTheCurrentOffsetsAndPrintMode() = runBlocking<Unit> {
        val vm = vm()
        eventually("pick") { builder.pick.value?.dpi == 203 }
        vm.setOffsetX("12")
        vm.setOffsetY("-3")
        eventually("offsets saved") { store.settings.first().let { it.offsetX == 12 && it.offsetY == -3 } }

        vm.printTest(TestLabel.ALIGNMENT)
        eventually("alignment sent") { vm.state.value.testMessage != null && !vm.state.value.testing }
        val z = zebra(savedHost)
        assertEquals(listOf("LT-3LS12|ALIGN 812x406 4x2 203|MMT"), z.sent)
        assertEquals("Alignment label (4x2) sent to the printer.", vm.state.value.testMessage)

        store.setPeel(true)
        eventually("peel saved") { store.settings.first().peel }
        vm.setOffsetX("99999") // clamps
        vm.printTest(TestLabel.SAMPLE)
        eventually("sample sent") { z.sent.size == 2 && !vm.state.value.testing }
        assertEquals("LT-3LS9999|SAMPLE top 203|MMP", z.sent[1])
        assertEquals("Sample label (Vegas Top) sent to the printer.", vm.state.value.testMessage)
        val sample = engine.calls.first { it.first == "sampleLabel" }.second
        assertEquals("""{"templates":[{"id":"t1","name":"Vegas Top","width_in":4,"height_in":2.0}]}""", sample["templatesJson"]!!.jsonPrimitive.content)
        eventually("clamped offset saved") { store.settings.first().offsetX == 9999 }
        // no build was started by offsets or peel
        assertEquals(1, engine.calls.count { it.first == "buildPlan" })
    }

    @Test fun aTestLabelThePrinterDoesNotTakeSaysSo() = runBlocking<Unit> {
        val vm = vm()
        eventually("pick") { builder.pick.value?.dpi == 203 }
        zebra(savedHost).answers = false
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("failed") { vm.state.value.testMessage != null && !vm.state.value.testing }
        assertEquals("Can't reach the printer at 10.0.0.5.", vm.state.value.testMessage)
        assertTrue(vm.state.value.testError)
    }

    /** The plan needs [fonts], and the synced library has each with its file (its size is the file's). */
    private suspend fun libraryFonts(vararg fonts: Pair<String, ByteArray>) {
        engine.planFonts = fonts.map { it.first }
        db.labelFonts().insertAll(fonts.mapIndexed { i, (name, bytes) ->
            val file = name.lowercase()
            File(fontsDir, file).writeBytes(bytes)
            LabelFontEntity("f${i + 1}", name, bytes.size, false, file)
        })
        builder.rebuild("fonts changed")
        eventually("plan with fonts") { builder.pick.value?.fonts?.size == fonts.size }
    }

    /** A font on the printer at another size than the library's (a download cut short) is
     *  damaged: the row names it beside the missing ones, and Install sends it again. */
    @Test fun damagedFontOffersReinstall() = runBlocking<Unit> {
        libraryFonts("ROBOTO.TTF" to byteArrayOf(1, 2, 3), "LATO.TTF" to byteArrayOf(4, 5))
        val z = zebra(savedHost)
        z.onE += DirectoryEntry("ROBOTO.TTF", 1)
        val vm = vm()
        vm.checked { vm.checkAgain() }
        val fonts = vm.row(CheckKey.FONTS)!!
        assertEquals(CheckState.FAIL, fonts.state)
        assertEquals("Missing: LATO.TTF. Damaged: ROBOTO.TTF (reinstall).", fonts.detail)
        assertEquals(listOf("ROBOTO.TTF", "LATO.TTF"), vm.state.value.fontFix!!.installable.map { it.name })
        // The button counts the damaged fonts as reinstalls (iOS's words).
        assertEquals(listOf("ROBOTO.TTF"), vm.state.value.damagedFonts)
        assertEquals("Install 1 missing font, reinstall 1 damaged font", fontInstallButtonText(vm.state.value.fontFix!!.installable, vm.state.value.damagedFonts))

        z.onE += DirectoryEntry("LATO.TTF", 2)
        vm.checked { vm.checkAgain() }
        assertEquals(CheckState.FAIL, vm.row(CheckKey.FONTS)!!.state)
        assertEquals("Damaged: ROBOTO.TTF (reinstall).", vm.row(CheckKey.FONTS)!!.detail)
        assertEquals(listOf("ROBOTO.TTF"), vm.state.value.fontFix!!.installable.map { it.name })
        assertEquals("Reinstall 1 damaged font", fontInstallButtonText(vm.state.value.fontFix!!.installable, vm.state.value.damagedFonts))

        vm.checked { vm.installFonts() }
        assertEquals(listOf("ROBOTO.TTF"), z.installed.map { it.first })
        assertArrayEquals(byteArrayOf(1, 2, 3), z.installed[0].second)
        assertEquals("Fonts installed.", vm.state.value.fontMessage)
        assertEquals(CheckState.OK, vm.row(CheckKey.FONTS)!!.state)
        assertNull(vm.state.value.fontFix)
        assertTrue(vm.state.value.damagedFonts.isEmpty())
    }

    @Test fun theFontInstallButtonCountsMissingAndDamagedFonts() {
        val roboto = KioskLabelFont("f1", "Roboto.ttf", 3)
        val lato = KioskLabelFont("f2", "LATO.TTF", 2)
        assertEquals("Install 2 missing fonts", fontInstallButtonText(listOf(roboto, lato), emptyList()))
        assertEquals("Install 1 missing font", fontInstallButtonText(listOf(roboto), emptyList()))
        assertEquals("Reinstall 1 damaged font", fontInstallButtonText(listOf(roboto), listOf("ROBOTO.TTF")))
        assertEquals("Reinstall 2 damaged fonts", fontInstallButtonText(listOf(roboto, lato), listOf("ROBOTO.TTF", "LATO.TTF")))
        assertEquals("Install 1 missing font, reinstall 1 damaged font", fontInstallButtonText(listOf(roboto, lato), listOf("ROBOTO.TTF")))
    }

    /** A font download announces its size, so Cancel never cuts one: the font going out finishes
     *  and the next one never starts (D8). */
    @Test fun cancelInstallFinishesTheCurrentFont() = runBlocking<Unit> {
        libraryFonts("ROBOTO.TTF" to byteArrayOf(1, 2, 3), "LATO.TTF" to byteArrayOf(4, 5))
        val z = zebra(savedHost)
        z.installSteps = listOf(0.5, 1.0)
        z.installHoldAt = 0.5
        val vm = vm()
        vm.checked { vm.checkAgain() }
        assertEquals(2, vm.state.value.fontFix!!.installable.size)
        val checksBefore = vm.state.value.checkRuns
        vm.installFonts()
        eventually("first font half sent") { z.atInstallHold == 0.5 }
        vm.cancelInstall()
        delay(50)
        assertTrue(vm.state.value.installing)
        assertTrue(z.installed.isEmpty())
        z.installHoldAt = null
        eventually("stopped and re-checked") {
            !vm.state.value.installing && vm.state.value.checkRuns > checksBefore && !vm.state.value.checking
        }
        assertEquals(listOf("ROBOTO.TTF"), z.installed.map { it.first })
        assertArrayEquals(byteArrayOf(1, 2, 3), z.installed[0].second)
        assertEquals(1, z.calls.count { it == "installFont" })
        assertNull(vm.state.value.fontMessage)
        assertFalse(vm.state.value.fontError)
        assertEquals("Missing: LATO.TTF.", vm.row(CheckKey.FONTS)!!.detail)
    }

    /** Progress as the bytes go out; no time left until a speed is measured (too few bytes here). */
    @Test fun installReportsProgress() = runBlocking<Unit> {
        libraryFonts("ROBOTO.TTF" to byteArrayOf(1, 2, 3, 4))
        val z = zebra(savedHost)
        z.installSteps = listOf(0.5, 1.0)
        z.installHoldAt = 0.5
        val vm = vm()
        vm.checked { vm.checkAgain() }
        assertNull(vm.state.value.installProgress)
        assertNull(vm.state.value.installEta)
        vm.installFonts()
        eventually("half sent") { z.atInstallHold == 0.5 && vm.state.value.installProgress == 0.5f }
        assertNull(vm.state.value.installEta)
        z.installHoldAt = 1.0
        eventually("all sent") { z.atInstallHold == 1.0 && vm.state.value.installProgress == 1f }
        assertNull(vm.state.value.installEta)
        z.installHoldAt = null
        eventually("installed") { !vm.state.value.installing }
        assertNull(vm.state.value.installProgress)
        assertNull(vm.state.value.installEta)
        assertEquals("Fonts installed.", vm.state.value.fontMessage)
    }

    /** A font install cut off part-way leaves the printer waiting for the rest of the font: the
     *  screen says to restart it, nothing more is sent (no re-check, test labels refused), and a
     *  check the printer answers lets sends through again (D8). */
    @Test fun aCutFontInstallSaysToRestartThePrinterUntilACheckSucceeds() = runBlocking<Unit> {
        libraryFonts("ROBOTO.TTF" to byteArrayOf(1, 2, 3))
        val z = zebra(savedHost)
        val vm = vm()
        vm.checked { vm.checkAgain() }
        z.installError = PrinterTimeout(savedHost)
        vm.installFonts()
        eventually("install failed") { !vm.state.value.installing && vm.state.value.fontMessage != null }
        assertEquals(FONT_INSTALL_CUT_TEXT, vm.state.value.fontMessage)
        assertTrue(vm.state.value.fontError)
        assertEquals(PrinterGuard.State.FONT_CUT, guard.state(saved.connection))
        val callsAfterCut = z.calls.toList()
        assertEquals("installFont", callsAfterCut.last())

        vm.printTest(TestLabel.ALIGNMENT)
        eventually("refused") { !vm.state.value.testing && vm.state.value.testMessage != null }
        assertEquals(FONT_INSTALL_CUT_TEXT, vm.state.value.testMessage)
        assertTrue(vm.state.value.testError)
        assertTrue(z.sent.isEmpty())
        assertEquals(callsAfterCut, z.calls.toList())

        // Not restarted yet: it doesn't answer, and the check says why.
        z.answers = false
        vm.checked { vm.checkAgain() }
        assertEquals(CheckState.FAIL, vm.row(CheckKey.ANSWERS)!!.state)
        assertEquals(FONT_INSTALL_CUT_TEXT, vm.row(CheckKey.ANSWERS)!!.detail)

        // Restarted: it answers, and sends go out again.
        z.answers = true
        z.installError = null
        vm.checked { vm.checkAgain() }
        assertEquals(CheckState.OK, vm.row(CheckKey.ANSWERS)!!.state)
        assertEquals(PrinterGuard.State.CLEAN, guard.state(saved.connection))
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("sent") { !vm.state.value.testing && z.sent.size == 1 }
        assertFalse(vm.state.value.testError)
    }

    /** A printer being chosen is asked under the lock and the shared guard, but its answer never
     *  lifts a cut font's stop: not another printer's, and not the saved printer's own when it is
     *  chosen again. The check after saving it does. */
    @Test fun choosingAPrinterDoesNotLiftTheSavedPrintersStop() = runBlocking<Unit> {
        val savedConnection = saved.connection
        guard.markFontCut(savedConnection)
        val z = zebra("10.0.0.10")
        val line = FakeLine()
        z.line = line
        line.hold = "serial"
        val vm = vm()
        vm.setIpText("10.0.0.10")
        vm.useIp()
        eventually("asked its serial") { line.held }
        assertEquals(listOf("identify", "serial"), z.calls.toList())
        assertEquals(PrinterGuard.State.FONT_CUT, guard.state(savedConnection))
        line.hold = null
        eventually("saved") { store.settings.first().printer?.host == "10.0.0.10" }

        val z5 = zebra(savedHost)
        val line5 = FakeLine()
        z5.line = line5
        line5.hold = "serial"
        vm.setIpText(savedHost)
        vm.useIp()
        eventually("asked the first printer's serial") { line5.held }
        assertEquals(listOf("identify", "serial"), z5.calls.toList())
        assertEquals(PrinterGuard.State.FONT_CUT, guard.state(savedConnection))
        line5.hold = null
        eventually("saved again and checked") { z5.calls.count { it == "identify" } == 2 }
        eventually("the stop lifted") { guard.state(savedConnection) == PrinterGuard.State.CLEAN }
    }

    /** The saved printer chosen again while it needs a clear: `~JX` goes before the probe's `~HI`. */
    @Test fun reChoosingTheSavedPrinterClearsBeforeItsFirstQuery() = runBlocking<Unit> {
        guard.markSendFailed(saved.connection)
        val z = zebra(savedHost)
        val vm = vm()
        vm.setIpText(savedHost)
        vm.useIp()
        eventually("saved again") { store.settings.first().printer?.serial == "S-10.0.0.5" }
        assertEquals(listOf("send", "identify"), z.calls.take(2))
        assertEquals(listOf("~JX"), z.sent.toList())
        assertEquals(PrinterGuard.State.CLEAN, guard.state(saved.connection))
    }

    /** A failed test label leaves the printer needing a clear: the next check sends `~JX` first
     *  (D16), and only once. */
    @Test fun aFailedTestLabelClearsBeforeTheNextCheck() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        val z = zebra(savedHost)
        z.sendError = PrinterUnreachable(savedHost)
        val vm = vm()
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("failed") { !vm.state.value.testing && vm.state.value.testError }
        z.sendError = null
        vm.checked { vm.checkAgain() }
        assertEquals(listOf("send", "send", "identify"), z.calls.take(3))
        assertEquals(listOf("~JX"), z.sent.toList())
        assertEquals(CheckState.OK, vm.row(CheckKey.ANSWERS)!!.state)
    }

    /** A font install the printer never took (nothing answered, so no byte went out) cuts nothing:
     *  it says which font, checks again, and labels still go out. */
    @Test fun aFontInstallThatNeverStartedSaysWhichAndKeepsSending() = runBlocking<Unit> {
        libraryFonts("ROBOTO.TTF" to byteArrayOf(1, 2, 3))
        val z = zebra(savedHost)
        val vm = vm()
        vm.checked { vm.checkAgain() }
        z.answers = false
        vm.checked { vm.installFonts() }
        assertEquals("Couldn't install ROBOTO.TTF.", vm.state.value.fontMessage)
        assertTrue(vm.state.value.fontError)
        assertEquals("No Zebra printer answered at 10.0.0.5.", vm.row(CheckKey.ANSWERS)!!.detail)
        assertEquals(PrinterGuard.State.CLEAN, guard.state(saved.connection))
        z.answers = true
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("sent") { !vm.state.value.testing && z.sent.size == 1 }
        assertFalse(vm.state.value.testError)
    }

    /** Leaving Printer Setup mid-install (the back gesture cancels the screen's scope) never cuts
     *  the font going out: it finishes, every byte of it, the printer is left clean, and the next
     *  font never starts (D8). */
    @Test fun closingTheScreenFinishesTheFontGoingOutAndStartsNoOther() = runBlocking<Unit> {
        libraryFonts("ROBOTO.TTF" to byteArrayOf(1, 2, 3), "LATO.TTF" to byteArrayOf(4, 5))
        val z = zebra(savedHost)
        z.installSteps = listOf(0.5, 1.0)
        z.installHoldAt = 0.5
        val screen = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val vm = vm(screen = screen)
        vm.checked { vm.checkAgain() }
        assertEquals(2, vm.state.value.fontFix!!.installable.size)
        vm.installFonts()
        eventually("first font half sent") { z.atInstallHold == 0.5 }
        screen.cancel()
        delay(50)
        z.installHoldAt = null
        eventually("first font finished") { z.installed.size == 1 }
        // Long enough for a next font (and the settle before a re-check) to have started.
        delay(PrinterSetupViewModel.FONT_SETTLE_MS + 300)
        assertEquals(listOf("ROBOTO.TTF"), z.installed.map { it.first })
        assertArrayEquals(byteArrayOf(1, 2, 3), z.installed[0].second)
        assertEquals(1, z.calls.count { it == "installFont" })
        assertEquals(PrinterGuard.State.CLEAN, guard.state(saved.connection))
    }

    /** A test label already going out finishes too when the screen closes: the printer gets all
     *  of it, and is left clean (no `~JX` owed). */
    @Test fun closingTheScreenFinishesATestLabelGoingOut() = withLine { line ->
        eventually("pick") { builder.pick.value?.dpi == 203 }
        val screen = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val vm = vm(screen = screen)
        line.hold = "ALIGN"
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("test label on the printer") { line.held }
        screen.cancel()
        delay(50)
        line.hold = null
        val z = zebra(savedHost)
        eventually("test label finished") { z.sent.size == 1 }
        assertTrue(z.sent[0].contains("ALIGN"))
        assertEquals(PrinterGuard.State.CLEAN, guard.state(saved.connection))
    }

    @Test fun theInstallEtaReadsInSecondsThenMinutes() {
        assertEquals("about 40 s left", installEtaText(156_000, 3_900.0))
        assertEquals("about 1 s left", installEtaText(1, 3_900.0))
        assertEquals("about 59 s left", installEtaText(230_000, 3_900.0))
        assertEquals("about 1 min left", installEtaText(234_000, 3_900.0))
        assertEquals("about 4 min left", installEtaText(1_048_576, 3_900.0))
        assertNull(installEtaText(0, 3_900.0))
        assertNull(installEtaText(10, 0.0))
    }

    // --- one printer connection at a time, app-wide ---------------------------------------------

    /** Print Labels' queue as the container wires it: each label through [lockedSender] under the
     *  shared lock and guard, onto [line]. */
    private fun printQueue(line: FakeLine): PrintQueue<String> {
        val send = lockedSender(lock, guard) { p, zpl -> line.connect("${p.host.orEmpty()} $zpl") }
        return PrintQueue(object : PrintQueueDeps<String> {
            override suspend fun settings(): LabelSettings = store.settings.first()
            override suspend fun label(asset: String): PrintStep = PrintStep.Ready("ASSET")
            override suspend fun prepare(zpl: String, settings: LabelSettings): PrintStep = PrintStep.Ready(zpl)
            override suspend fun send(printer: SavedPrinter, zpl: String) = send.send(printer, zpl)
            override suspend fun record(asset: String, scannedValue: String) = Unit
        }, now = { "2026-10-22T00:00:00Z" })
    }

    /** Runs [test] on a fresh line to the saved printer; a failing check lets go of any held
     *  connection, so a label going out (it can't be canceled) still ends and the test fails
     *  instead of hanging. */
    private fun withLine(test: suspend CoroutineScope.(FakeLine) -> Unit) = runBlocking<Unit> {
        val line = FakeLine()
        zebra(savedHost).line = line
        try {
            test(line)
        } finally {
            line.hold = null
        }
    }

    /** The container's lock is shared by Printer Setup and the Print Labels queue's send: a test
     *  label never opens a connection while a queued asset label is going out, nor the other way. */
    @Test fun setupAndPrintLabelsShareOneLock() = withLine { line ->
        eventually("pick") { builder.pick.value?.dpi == 203 }
        val queue = printQueue(line)
        val vm = vm()

        // An asset label going out holds the printer: the test label waits its turn.
        line.hold = "ASSET"
        val first = async(Dispatchers.Default) { queue.scan("a1", "A-1") }
        eventually("asset label on the printer") { line.held }
        vm.printTest(TestLabel.ALIGNMENT)
        delay(100)
        assertEquals(listOf("10.0.0.5 ASSET"), line.started.toList())
        assertTrue(vm.state.value.testing)
        line.hold = null
        assertEquals(PrintState.PRINTED, first.await().state)
        eventually("test label sent") { !vm.state.value.testing }
        assertEquals(2, line.started.size)
        assertTrue(line.started.last().contains("ALIGN"))

        // And the other way: a test label going out holds the queued asset label.
        line.held = false
        line.hold = "ALIGN"
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("test label on the printer") { line.held }
        val second = async(Dispatchers.Default) { queue.scan("a1", "A-1") }
        delay(100)
        assertEquals(3, line.started.size)
        line.hold = null
        assertEquals(PrintState.PRINTED, second.await().state)
        assertEquals("10.0.0.5 ASSET", line.started.last())
        eventually("test label done") { !vm.state.value.testing }
        assertEquals(1, line.maxOpen.get())
    }

    /** Checks hold the same lock: a queued asset label waits for the query in progress. */
    @Test fun aQueuedAssetLabelWaitsForACheckQuery() = withLine { line ->
        eventually("pick") { builder.pick.value?.dpi == 203 }
        val queue = printQueue(line)
        val vm = vm()
        line.hold = "status"
        vm.checkAgain()
        eventually("status query open") { line.held }
        val job = async(Dispatchers.Default) { queue.scan("a1", "A-1") }
        delay(100)
        assertFalse(line.started.contains("10.0.0.5 ASSET"))
        line.hold = null
        assertEquals(PrintState.PRINTED, job.await().state)
        eventually("checks finished") { !vm.state.value.checking }
        assertEquals(1, line.maxOpen.get())
    }

    // --- Bluetooth ---------------------------------------------------------------------------

    /** Picking a Bluetooth printer (D9): connect by the address picked with no serial (a renamed
     *  printer's Bluetooth name isn't its serial), `~HI` under the lock, save it by Device
     *  Information's serial and the address picked (never an address the link found it at), then
     *  check it. The link stays up to the printer just saved. */
    @Test fun bluetoothChooseSavesAndChecks() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        val renamed = found(name = "Dock 4 Zebra", zebra = true)
        val headphones = found(name = "Headphones", address = "11:22:33:44:55:66", rssi = -40)
        // The link came up at another address than the one picked.
        bt.answer = { BluetoothPrinterInfo("AC:3F:A4:00:00:99", "Zebra Technologies", "ZD421", btSerial, "V93.21.38Z", "7.3") }
        val vm = vm()
        vm.scanBluetooth()
        eventually("scanning") { bt.scanning && vm.state.value.bluetoothScanning }
        assertEquals(FindMode.BLUETOOTH, vm.state.value.findMode)
        bt.hear(renamed, headphones)
        eventually("listed") { vm.state.value.bluetoothFound == listOf(renamed, headphones) }
        assertEquals(listOf(renamed), vm.state.value.bluetoothZebras)
        assertEquals(listOf(headphones), vm.state.value.bluetoothOthers)

        vm.checked { vm.chooseBluetooth(renamed) }
        assertEquals(listOf<Pair<String?, String?>>(btAddress to null), bt.connects.toList())
        assertEquals(SavedPrinter(PrinterConnection.Bluetooth(btSerial, btAddress), "ZD421", btSerial, 203), store.settings.first().printer)
        val z = zebra(btSerial)
        assertEquals("identify", z.calls.first())
        assertEquals(2, z.calls.count { it == "identify" })
        assertEquals(CheckState.OK, vm.row(CheckKey.ANSWERS)!!.state)
        assertEquals("ZD421 · 203 DPI", vm.row(CheckKey.ANSWERS)!!.detail)
        assertEquals(CheckState.OK, vm.row(CheckKey.DPI)!!.state)
        assertFalse(vm.state.value.bluetoothScanning)
        assertNull(vm.state.value.chooseError)
        assertEquals(0, bt.closes)
    }

    /** A choice that fails after the link came up lets that printer go (an unsaved printer isn't
     *  held from other devices), unless it is the saved printer, which Print Labels uses. */
    @Test fun aBluetoothChoiceThatFailsLetsTheUnsavedPrinterGo() = runBlocking<Unit> {
        zebra(btSerial).answers = false
        val vm = vm()
        vm.chooseBluetooth(found())
        eventually("refused") { vm.state.value.chooseError != null && vm.state.value.choosing == null }
        assertEquals("No Zebra printer answered over Bluetooth as D8J224508535.", vm.state.value.chooseError)
        assertEquals(saved, store.settings.first().printer)
        assertEquals(1, bt.closes)

        store.setPrinter(btPrinter)
        vm.chooseBluetooth(found())
        eventually("refused again") { bt.connects.size == 2 && vm.state.value.choosing == null }
        assertEquals(1, bt.closes)
    }

    /** Bluetooth off: the scan, a choice and a check say so (the screen offers Turn on Bluetooth),
     *  and the scan runs again by itself once Bluetooth is on. */
    @Test fun bluetoothOffSaysSo() = runBlocking<Unit> {
        bt.availability.value = BluetoothAvailability.POWERED_OFF
        val vm = vm()
        vm.scanBluetooth()
        eventually("refused") { vm.state.value.bluetoothMessage != null && !vm.state.value.bluetoothScanning }
        assertEquals(BLUETOOTH_OFF_TEXT, vm.state.value.bluetoothMessage)
        assertEquals(BluetoothAvailability.POWERED_OFF, vm.state.value.bluetoothUnavailable)
        assertEquals(BluetoothFix.TURN_ON, bluetoothFixFor(vm.state.value.bluetoothMessage))
        assertTrue(vm.state.value.bluetoothError)

        bt.availability.value = BluetoothAvailability.READY
        eventually("scanning again") { bt.scanning && vm.state.value.bluetoothScanning }
        assertEquals(2, bt.scans)
        assertNull(vm.state.value.bluetoothMessage)
        assertNull(vm.state.value.bluetoothUnavailable)
        // Stopped with no Zebra heard: says so, as information.
        vm.stopBluetoothScan()
        eventually("stopped") { !vm.state.value.bluetoothScanning && vm.state.value.bluetoothMessage != null }
        assertEquals(NO_BLUETOOTH_PRINTERS_TEXT, vm.state.value.bluetoothMessage)
        assertFalse(vm.state.value.bluetoothError)

        // Off again: a choice and a check say so too (and nothing runs by itself while it is off).
        bt.availability.value = BluetoothAvailability.POWERED_OFF
        bt.connectError = BluetoothUnavailable(btAddress, BluetoothAvailability.POWERED_OFF)
        vm.chooseBluetooth(found())
        eventually("choice refused") { vm.state.value.choosing == null && vm.state.value.bluetoothMessage == BLUETOOTH_OFF_TEXT }
        assertNull(vm.state.value.chooseError)
        assertEquals(saved, store.settings.first().printer)

        store.setPrinter(btPrinter)
        zebra(btSerial).failWith = BluetoothUnavailable(btSerial, BluetoothAvailability.POWERED_OFF)
        vm.checked { vm.checkAgain() }
        assertEquals(CheckState.FAIL, vm.row(CheckKey.ANSWERS)!!.state)
        assertEquals(BLUETOOTH_OFF_TEXT, vm.row(CheckKey.ANSWERS)!!.detail)
        assertEquals(BluetoothAvailability.POWERED_OFF, vm.state.value.bluetoothUnavailable)
    }

    /** Bluetooth not allowed: by the link's own reading, or (API 31+) a Location permission refused
     *  beside the scan ones. Each says so with Open Settings; coming back with it allowed scans. */
    @Test fun bluetoothDeniedSaysSo() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        bt.availability.value = BluetoothAvailability.UNAUTHORIZED
        val vm = vm()
        vm.scanBluetooth()
        eventually("refused") { vm.state.value.bluetoothMessage != null && !vm.state.value.bluetoothScanning }
        assertEquals(BLUETOOTH_DENIED_TEXT, vm.state.value.bluetoothMessage)
        assertEquals(BluetoothAvailability.UNAUTHORIZED, vm.state.value.bluetoothUnavailable)
        assertEquals(BluetoothFix.ALLOW, bluetoothFixFor(vm.state.value.bluetoothMessage))
        // Allowed in Settings: Android says nothing, so coming back reads Bluetooth again.
        val refreshes = bt.refreshes
        vm.appResumed(permitted = true)
        assertTrue(bt.refreshes > refreshes)
        bt.availability.value = BluetoothAvailability.READY
        eventually("scanning again") { bt.scanning && vm.state.value.bluetoothScanning }

        vm.stopBluetoothScan()
        eventually("stopped") { !vm.state.value.bluetoothScanning }
        val scans = bt.scans
        vm.scanBluetooth(permitted = false)
        eventually("refused without a scan") { vm.state.value.bluetoothMessage == BLUETOOTH_DENIED_TEXT }
        assertEquals(BluetoothAvailability.UNAUTHORIZED, vm.state.value.bluetoothUnavailable)
        assertEquals(scans, bt.scans)
        vm.appResumed(permitted = true)
        eventually("scanning once allowed") { bt.scans == scans + 1 && vm.state.value.bluetoothScanning }

        // A test label to the saved Bluetooth printer says what to fix too.
        store.setPrinter(btPrinter)
        zebra(btSerial).failWith = BluetoothUnavailable(btSerial, BluetoothAvailability.UNAUTHORIZED)
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("test refused") { !vm.state.value.testing && vm.state.value.testMessage != null }
        assertEquals(BLUETOOTH_DENIED_TEXT, vm.state.value.testMessage)
        assertTrue(vm.state.value.testError)
    }

    /** Android finds Bluetooth devices for this app only with Location on (its BLUETOOTH_SCAN
     *  doesn't disavow location), at every API level: the scan says so (with Location settings),
     *  and runs again by itself once Location is on. */
    @Test fun locationOffSaysSo() = runBlocking<Unit> {
        bt.availability.value = BluetoothAvailability.LOCATION_OFF
        val vm = vm()
        vm.scanBluetooth()
        eventually("refused") { vm.state.value.bluetoothMessage != null && !vm.state.value.bluetoothScanning }
        assertEquals(LOCATION_OFF_TEXT, vm.state.value.bluetoothMessage)
        assertEquals(BluetoothAvailability.LOCATION_OFF, vm.state.value.bluetoothUnavailable)
        assertEquals(BluetoothFix.LOCATION, bluetoothFixFor(vm.state.value.bluetoothMessage))
        bt.availability.value = BluetoothAvailability.READY
        eventually("scanning again") { bt.scanning && vm.state.value.bluetoothScanning }
        assertNull(vm.state.value.bluetoothMessage)
    }

    /** The printer forgot this device (D10): the forget-it steps (naming the device the way
     *  Android's Connected devices lists it), and Connect tries again once that's done: the same
     *  choice, or the saved printer's checks. Nothing is saved meanwhile. */
    @Test fun pairingLostShowsRecovery() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        val vm = vm()
        val renamed = found(name = "Dock 4 Zebra", zebra = true)
        bt.connectError = BluetoothPairingLost(btAddress)
        vm.chooseBluetooth(renamed)
        eventually("refused") { vm.state.value.pairingLost != null && vm.state.value.choosing == null }
        assertEquals(pairingLostText("Dock 4 Zebra"), vm.state.value.pairingLost)
        assertEquals(BluetoothFix.FORGET, bluetoothFixFor(vm.state.value.pairingLost))
        assertNull(vm.state.value.chooseError)
        assertEquals(saved, store.settings.first().printer)

        bt.connectError = null
        vm.checked { vm.connectAgain() }
        assertNull(vm.state.value.pairingLost)
        assertEquals(btPrinter, store.settings.first().printer)
        assertEquals(CheckState.OK, vm.row(CheckKey.ANSWERS)!!.state)

        // A check meets it, here on the `~JX` a failed send left owed: the steps name the saved serial.
        guard.markSendFailed(btPrinter.connection)
        zebra(btSerial).failWith = BluetoothPairingLost(btSerial)
        vm.checked { vm.checkAgain() }
        assertEquals(pairingLostText(btSerial), vm.state.value.pairingLost)
        assertEquals(CheckState.FAIL, vm.row(CheckKey.ANSWERS)!!.state)
        assertEquals("No Zebra printer answered over Bluetooth as D8J224508535.", vm.row(CheckKey.ANSWERS)!!.detail)

        zebra(btSerial).failWith = null
        vm.checked { vm.connectAgain() }
        assertNull(vm.state.value.pairingLost)
        assertEquals(CheckState.OK, vm.row(CheckKey.ANSWERS)!!.state)

        // A test label meets it: the sheet shows the steps (it offers Connect, the checks), and
        // once the printer answers a check again the sheet's message goes with everything it offered.
        zebra(btSerial).failWith = BluetoothPairingLost(btSerial)
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("test refused") { !vm.state.value.testing && vm.state.value.testMessage != null }
        assertEquals(pairingLostText(btSerial), vm.state.value.testMessage)
        assertTrue(vm.state.value.testError)
        assertEquals(pairingLostText(btSerial), vm.state.value.pairingLost)
        assertTrue(printerReachProblem(vm.state.value.testMessage)!!.offersConnect)
        // Refused again: the message stays.
        vm.checked { vm.connectAgain() }
        assertEquals(pairingLostText(btSerial), vm.state.value.testMessage)
        assertEquals(pairingLostText(btSerial), vm.state.value.pairingLost)
        zebra(btSerial).failWith = null
        vm.checked { vm.connectAgain() }
        assertNull(vm.state.value.pairingLost)
        assertNull(vm.state.value.testMessage)
        assertFalse(vm.state.value.testError)
        assertEquals(CheckState.OK, vm.row(CheckKey.ANSWERS)!!.state)
        // Another printer chosen clears it too.
        zebra(btSerial).failWith = BluetoothPairingLost(btSerial)
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("test refused again") { !vm.state.value.testing && vm.state.value.testMessage != null }
        zebra(btSerial).failWith = null
        vm.checked { vm.chooseBluetooth(renamed) }
        assertNull(vm.state.value.testMessage)
        assertFalse(vm.state.value.testError)
    }

    /** A Bluetooth scan drops Connect (it would retry nothing), so the test label sheet's
     *  pairing-lost steps go with it: reopening the sheet shows no Connect that does nothing. Any
     *  other test message stays. */
    @Test fun aBluetoothScanTakesTheSheetsConnectWithIt() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        store.setPrinter(btPrinter)
        val vm = vm()
        zebra(btSerial).failWith = BluetoothPairingLost(btSerial)
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("test refused") { !vm.state.value.testing && vm.state.value.testMessage != null }
        assertEquals(pairingLostText(btSerial), vm.state.value.testMessage)
        assertTrue(printerReachProblem(vm.state.value.testMessage)!!.offersConnect)

        vm.scanBluetooth()
        eventually("scanning") { bt.scanning && vm.state.value.bluetoothScanning }
        assertNull(vm.state.value.pairingLost)
        assertNull("the sheet's Connect went with the screen's", vm.state.value.testMessage)
        assertFalse(vm.state.value.testError)
        vm.stopBluetoothScan()
        eventually("stopped") { !vm.state.value.bluetoothScanning }

        // A refused prompt drops it too.
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("refused again") { !vm.state.value.testing && vm.state.value.testMessage == pairingLostText(btSerial) }
        vm.scanBluetooth(permitted = false)
        assertNull(vm.state.value.testMessage)
        assertNull(vm.state.value.pairingLost)

        // A test message that offers no Connect stays.
        zebra(btSerial).failWith = null
        zebra(btSerial).sendError = PrinterUnreachable(btSerial)
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("not taken") { !vm.state.value.testing && vm.state.value.testMessage != null }
        val other = vm.state.value.testMessage
        vm.scanBluetooth()
        eventually("scanning again") { bt.scanning && vm.state.value.bluetoothScanning }
        assertEquals(other, vm.state.value.testMessage)
        assertTrue(vm.state.value.testError)
        vm.stopBluetoothScan()
        eventually("stopped again") { !vm.state.value.bluetoothScanning }
    }

    /** A device whose Device Information gives no serial is refused (iOS's words): it couldn't be
     *  found, or confirmed, again by it. Nothing is asked of it or saved, and the link lets it go. */
    @Test fun aDeviceThatReportsNoSerialIsRefused() = runBlocking<Unit> {
        assertEquals("This printer didn't report a serial number, so it can't be saved over Bluetooth.", NO_BLUETOOTH_SERIAL_TEXT)
        val vm = vm()
        for (serial in listOf(null, "  ")) {
            bt.answer = { address -> BluetoothPrinterInfo(address.orEmpty(), "Zebra Technologies", "ZD421", serial, "V93.21.38Z", "7.3") }
            val closes = bt.closes
            vm.chooseBluetooth(found(name = "Dock 4 Zebra", zebra = true))
            eventually("refused") { vm.state.value.chooseError != null && vm.state.value.choosing == null }
            assertEquals(NO_BLUETOOTH_SERIAL_TEXT, vm.state.value.chooseError)
            assertEquals(saved, store.settings.first().printer)
            assertEquals(closes + 1, bt.closes)
        }
        assertTrue(synchronized(zebras) { zebras.values.all { it.calls.isEmpty() } })
    }

    /** Bluetooth's permissions are asked for when it is picked, and a refused prompt stays refused:
     *  on API 31+ the link reads READY once the nearby-devices permissions are allowed even with
     *  Location refused, but nothing scans (Android would hide what it hears) until the permissions
     *  are allowed. A device without Bluetooth LE is never asked. */
    @Test fun aRefusedPromptStaysRefusedWhenTheLinkReadsReady() = runBlocking<Unit> {
        bt.availability.value = BluetoothAvailability.UNAUTHORIZED
        val vm = vm()
        var asked = 0
        vm.pickBluetooth(listOf("android.permission.ACCESS_FINE_LOCATION")) { asked++ }
        assertEquals(1, asked)
        assertEquals(FindMode.BLUETOOTH, vm.state.value.findMode)
        assertEquals(0, bt.scans)
        // The prompt's answer: Nearby devices allowed, Location refused.
        vm.scanBluetooth(permitted = false)
        assertEquals(BLUETOOTH_DENIED_TEXT, vm.state.value.bluetoothMessage)
        // Back in front: Bluetooth is read again, and the link (Location aside) reads READY.
        vm.appResumed(permitted = false)
        bt.availability.value = BluetoothAvailability.READY
        delay(300)
        assertEquals(0, bt.scans)
        assertEquals(BLUETOOTH_DENIED_TEXT, vm.state.value.bluetoothMessage)
        assertEquals(BluetoothFix.ALLOW, bluetoothFixFor(vm.state.value.bluetoothMessage))
        // Allowed in Settings, then back: it scans.
        vm.appResumed(permitted = true)
        eventually("scanning") { bt.scans == 1 && vm.state.value.bluetoothScanning }
        assertNull(vm.state.value.bluetoothMessage)

        vm.stopBluetoothScan()
        eventually("stopped") { !vm.state.value.bluetoothScanning }
        bt.availability.value = BluetoothAvailability.UNSUPPORTED
        vm.pickBluetooth(listOf("android.permission.BLUETOOTH_SCAN")) { asked++ }
        assertEquals(1, asked)
        eventually("no Bluetooth LE") { vm.state.value.bluetoothMessage == "This device doesn't support Bluetooth LE." }
        assertNull(bluetoothFixFor(vm.state.value.bluetoothMessage))
    }

    /** Bluetooth off under a check: the Answers row says so (with its button). Once it is on again
     *  that stale row goes and the link warms up in the background, but no check runs by itself
     *  (Jimmy's rule, and iOS: the checks run only on a tap), and no scan starts for it. */
    @Test fun aCheckRefusalClearsAndRelinksOnceBluetoothIsOn() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        store.setPrinter(btPrinter)
        val vm = vm()
        vm.scanBluetooth()
        eventually("scanning") { bt.scanning && vm.state.value.bluetoothScanning }
        vm.stopBluetoothScan()
        eventually("stopped") { !vm.state.value.bluetoothScanning }
        val scans = bt.scans
        bt.availability.value = BluetoothAvailability.POWERED_OFF
        zebra(btSerial).failWith = BluetoothUnavailable(btSerial, BluetoothAvailability.POWERED_OFF)
        vm.checked { vm.checkAgain() }
        assertEquals(BLUETOOTH_OFF_TEXT, vm.row(CheckKey.ANSWERS)!!.detail)
        assertEquals(BluetoothFix.TURN_ON, bluetoothFixFor(vm.row(CheckKey.ANSWERS)!!.detail))
        assertEquals(BluetoothAvailability.POWERED_OFF, vm.state.value.bluetoothUnavailable)

        zebra(btSerial).failWith = null
        val runs = vm.state.value.checkRuns
        val connects = bt.connects.size
        val asked = zebra(btSerial).calls.size
        bt.availability.value = BluetoothAvailability.READY
        eventually("the link warmed up again") { bt.connects.size == connects + 1 }
        eventually("the stale row went") { vm.state.value.checks.isEmpty() }
        assertNull(vm.state.value.bluetoothUnavailable)
        delay(300)
        assertEquals("no check ran by itself", runs, vm.state.value.checkRuns)
        assertEquals("nothing was asked of the printer", asked, zebra(btSerial).calls.size)
        assertEquals(scans, bt.scans)
        assertFalse(vm.state.value.checking)
        // Check again is the crew's: it works as before.
        vm.checked { vm.checkAgain() }
        assertEquals(CheckState.OK, vm.row(CheckKey.ANSWERS)!!.state)
    }

    /** READY landing while the checks are asking the printer isn't lost: the deferred rescan (or
     *  relink) runs once they end, and a permission answer that arrives meanwhile is applied then. */
    @Test fun aDeferredRescanSurvivesReadyArrivingDuringChecks() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        val z = zebra(savedHost)
        val gate = CompletableDeferred<Unit>()
        z.statusGate = gate
        val vm = vm()
        bt.availability.value = BluetoothAvailability.POWERED_OFF
        vm.scanBluetooth()
        eventually("refused") { vm.state.value.bluetoothMessage == BLUETOOTH_OFF_TEXT && !vm.state.value.bluetoothScanning }
        val scans = bt.scans
        vm.checkAgain()
        withTimeout(8_000) { z.inStatus.await() }
        bt.availability.value = BluetoothAvailability.READY
        delay(200)
        assertEquals("no scan while a check asks the printer", scans, bt.scans)
        gate.complete(Unit)
        eventually("the deferred scan ran once the checks ended") { bt.scans == scans + 1 && vm.state.value.bluetoothScanning }
        assertNull(vm.state.value.bluetoothMessage)
        vm.stopBluetoothScan()
        eventually("stopped") { !vm.state.value.bluetoothScanning }

        // The permission prompt's answer during a check run isn't dropped.
        val again = CompletableDeferred<Unit>()
        val z2 = FakeZebra(savedHost)
        synchronized(zebras) { zebras[savedHost] = z2 }
        z2.statusGate = again
        vm.checkAgain()
        withTimeout(8_000) { z2.inStatus.await() }
        val before = bt.scans
        vm.scanBluetooth(permitted = true)
        delay(200)
        assertEquals(before, bt.scans)
        again.complete(Unit)
        eventually("the prompt's answer applied") { bt.scans == before + 1 && vm.state.value.bluetoothScanning }
    }

    /** Bluetooth off refused a scan and then a check: once it is on, the check's relink runs, and
     *  the scan it also stopped runs once that connect ends (never beside it: the connect would
     *  end the scan), so the stale "Turn on Bluetooth" message and its button go. */
    @Test fun aRescanPendingBesideARelinkRunsOnceTheLinkIsUp() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        store.setPrinter(btPrinter)
        val vm = vm()
        bt.availability.value = BluetoothAvailability.POWERED_OFF
        vm.scanBluetooth()
        eventually("scan refused") { vm.state.value.bluetoothMessage == BLUETOOTH_OFF_TEXT && !vm.state.value.bluetoothScanning }
        zebra(btSerial).failWith = BluetoothUnavailable(btSerial, BluetoothAvailability.POWERED_OFF)
        vm.checked { vm.checkAgain() }
        assertEquals(BLUETOOTH_OFF_TEXT, vm.row(CheckKey.ANSWERS)!!.detail)

        zebra(btSerial).failWith = null
        val gate = CompletableDeferred<Unit>()
        bt.connectGate = gate
        val scans = bt.scans
        val connects = bt.connects.size
        bt.availability.value = BluetoothAvailability.READY
        eventually("the link warming up") { bt.connects.size == connects + 1 }
        delay(200)
        assertEquals("no scan beside the connect", scans, bt.scans)
        gate.complete(Unit)
        eventually("the stopped scan ran once the link was up") { bt.scans == scans + 1 && vm.state.value.bluetoothScanning }
        assertNull(vm.state.value.bluetoothMessage)
        assertNull(vm.state.value.bluetoothUnavailable)
        assertEquals(connects + 1, bt.connects.size)
        vm.stopBluetoothScan()
        eventually("stopped") { !vm.state.value.bluetoothScanning }
    }

    /** A check run replaced by a newer one ends without writing its ending: it neither reads as
     *  finished while the newer run asks the printer nor runs what waited for the checks (a scan
     *  Bluetooth stopped), as iOS's `run == checkRun`. */
    @Test fun aReplacedCheckRunLeavesTheScreenToTheNewerRun() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        val z = zebra(savedHost)
        z.statusGate = CompletableDeferred()
        val vm = vm()
        bt.availability.value = BluetoothAvailability.POWERED_OFF
        vm.scanBluetooth()
        eventually("refused") { vm.state.value.bluetoothMessage == BLUETOOTH_OFF_TEXT && !vm.state.value.bluetoothScanning }
        val scans = bt.scans
        vm.checkAgain()
        withTimeout(8_000) { z.inStatus.await() }
        bt.availability.value = BluetoothAvailability.READY
        delay(100)
        // Check again while the first run asks the printer: the first is replaced.
        val z2 = FakeZebra(savedHost)
        val gate2 = CompletableDeferred<Unit>()
        z2.statusGate = gate2
        synchronized(zebras) { zebras[savedHost] = z2 }
        val runs = vm.state.value.checkRuns
        vm.checkAgain()
        withTimeout(8_000) { z2.inStatus.await() }
        delay(300)
        assertTrue("the newer run is still checking", vm.state.value.checking)
        assertEquals("the replaced run didn't count as finished", runs, vm.state.value.checkRuns)
        assertEquals("no scan while the newer run asks the printer", scans, bt.scans)
        gate2.complete(Unit)
        eventually("the newer run ended and settled") { !vm.state.value.checking && bt.scans == scans + 1 }
        assertEquals(runs + 1, vm.state.value.checkRuns)
        vm.stopBluetoothScan()
        eventually("stopped") { !vm.state.value.bluetoothScanning }
    }

    /** D4: opening Printer Setup with a saved Bluetooth printer starts the link in the background
     *  (one at a time), so the first check or test label needn't wait for it. Nothing waits for
     *  it, nothing is checked, and a network printer starts nothing. */
    @Test fun openingWithASavedBluetoothPrinterConnectsInTheBackground() = runBlocking<Unit> {
        val network = vm()
        network.open()?.join()
        assertTrue(bt.connects.isEmpty())

        store.setPrinter(btPrinter)
        val gate = CompletableDeferred<Unit>()
        bt.connectGate = gate
        val vm = vm()
        val connecting = vm.open()!!
        eventually("connecting") { bt.connects.size == 1 }
        assertEquals(listOf<Pair<String?, String?>>(btAddress to btSerial), bt.connects.toList())
        // Never blocking: the screen works meanwhile, and opening again joins the same connect.
        vm.enterIp()
        assertEquals(FindMode.IP, vm.state.value.findMode)
        assertNull(vm.open())
        vm.appResumed(permitted = true)
        gate.complete(Unit)
        connecting.join()
        assertTrue(bt.link.value.connected)
        assertEquals(1, bt.connects.size)
        assertTrue(vm.state.value.checks.isEmpty())
        assertNull(vm.state.value.pairingLost)
        assertNull(vm.state.value.bluetoothMessage)
        assertTrue(synchronized(zebras) { zebras.values.all { it.calls.isEmpty() } })
        // Coming back with nothing showing starts no new connect (the first resume is the open).
        vm.appResumed(permitted = true)
        delay(100)
        assertEquals(1, bt.connects.size)
    }

    /** A refusal on open shows in Printer Setup's own Bluetooth messages: a printer that forgot
     *  this device gets the steps with Connect (which checks it); Bluetooth not allowed says so with
     *  Open Settings; Bluetooth off says so with Turn on Bluetooth. Any other failure (the printer
     *  off) says nothing until a check or test label does. Back in the app with Bluetooth refused,
     *  it connects again, as it does when Bluetooth reads ready again. */
    @Test fun aRefusalOnOpenShowsInPrinterSetup() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        store.setPrinter(btPrinter)

        bt.connectError = BluetoothPairingLost(btSerial)
        val forgotten = vm()
        forgotten.open()!!.join()
        assertEquals(pairingLostText(btSerial), forgotten.state.value.pairingLost)
        assertNull(forgotten.state.value.bluetoothMessage)
        bt.connectError = null
        forgotten.checked { forgotten.connectAgain() }
        assertEquals(CheckState.OK, forgotten.row(CheckKey.ANSWERS)!!.state)
        assertNull(forgotten.state.value.pairingLost)

        bt.connectError = BluetoothUnavailable(btSerial, BluetoothAvailability.UNAUTHORIZED)
        val denied = vm()
        denied.appResumed(permitted = true) // the first resume opens the screen
        eventually("denied on open") { denied.state.value.bluetoothMessage == BLUETOOTH_DENIED_TEXT }
        assertEquals(BluetoothAvailability.UNAUTHORIZED, denied.state.value.bluetoothUnavailable)
        assertEquals(BluetoothFix.ALLOW, bluetoothFixFor(denied.state.value.bluetoothMessage))
        assertNull(denied.state.value.pairingLost)
        // Allowed in Settings, back in the app: connected, and the message goes.
        bt.connectError = null
        val before = bt.connects.size
        denied.appResumed(permitted = true)
        eventually("connected again") { bt.connects.size == before + 1 && denied.state.value.bluetoothMessage == null }
        assertNull(denied.state.value.bluetoothUnavailable)

        bt.close()
        bt.availability.value = BluetoothAvailability.POWERED_OFF
        bt.connectError = BluetoothUnavailable(btSerial, BluetoothAvailability.POWERED_OFF)
        val off = vm()
        off.open()!!.join()
        assertEquals(BLUETOOTH_OFF_TEXT, off.state.value.bluetoothMessage)
        assertTrue(off.state.value.bluetoothError)
        assertEquals(BluetoothFix.TURN_ON, bluetoothFixFor(off.state.value.bluetoothMessage))
        // Bluetooth turned on (quick settings, say): it connects again and the message goes.
        bt.connectError = null
        val tries = bt.connects.size
        bt.availability.value = BluetoothAvailability.READY
        eventually("relinked once Bluetooth is on") { bt.connects.size == tries + 1 && off.state.value.bluetoothMessage == null }
        // A check says Bluetooth's state in its own row instead of the link's message.
        bt.availability.value = BluetoothAvailability.POWERED_OFF
        bt.connectError = BluetoothUnavailable(btSerial, BluetoothAvailability.POWERED_OFF)
        val checked = vm()
        checked.open()!!.join()
        assertEquals(BLUETOOTH_OFF_TEXT, checked.state.value.bluetoothMessage)
        zebra(btSerial).failWith = BluetoothUnavailable(btSerial, BluetoothAvailability.POWERED_OFF)
        checked.checked { checked.checkAgain() }
        assertNull(checked.state.value.bluetoothMessage)
        assertEquals(BLUETOOTH_OFF_TEXT, checked.row(CheckKey.ANSWERS)!!.detail)
        zebra(btSerial).failWith = null

        bt.connectError = PrinterUnreachable(btSerial)
        bt.availability.value = BluetoothAvailability.READY
        val away = vm()
        away.open()!!.join()
        assertNull(away.state.value.bluetoothMessage)
        assertNull(away.state.value.pairingLost)
        assertNull(away.state.value.chooseError)

        // Back in the app with Bluetooth on again but the printer away: the old message goes.
        bt.connectError = BluetoothUnavailable(btSerial, BluetoothAvailability.POWERED_OFF)
        val later = vm()
        later.appResumed(permitted = true)
        eventually("off on open") { later.state.value.bluetoothMessage == BLUETOOTH_OFF_TEXT }
        bt.connectError = PrinterUnreachable(btSerial)
        val count = bt.connects.size
        later.appResumed(permitted = true)
        eventually("tried again") { bt.connects.size == count + 1 && later.state.value.bluetoothMessage == null }
        assertNull(later.state.value.bluetoothUnavailable)

        // In Bluetooth find mode the scan's own message wins: the link's refusal says nothing there.
        bt.connectError = BluetoothUnavailable(btSerial, BluetoothAvailability.POWERED_OFF)
        bt.availability.value = BluetoothAvailability.POWERED_OFF
        val scanning = vm()
        scanning.scanBluetooth()
        eventually("the scan's message") { scanning.state.value.bluetoothMessage == BLUETOOTH_OFF_TEXT }
        scanning.open()!!.join()
        assertEquals(FindMode.BLUETOOTH, scanning.state.value.findMode)
        assertEquals(BLUETOOTH_OFF_TEXT, scanning.state.value.bluetoothMessage)
        bt.connectError = null
        bt.availability.value = BluetoothAvailability.READY
    }

    /** What the Bluetooth scan says when it ends with no Zebra listed, by how it ended: its full
     *  30 s of a ready Bluetooth or Stop say none was found; one Android wouldn't run says so (as
     *  information); one another Bluetooth call cut short says nothing; and one asked while
     *  Bluetooth is turning on waits for it. */
    @Test fun theScanSaysWhyNothingIsListedByHowItEnded() = runBlocking<Unit> {
        val vm = vm()
        val headphones = found(name = "Headphones", address = "11:22:33:44:55:66", rssi = -40)
        vm.scanBluetooth()
        eventually("scanning") { bt.scanning && vm.state.value.bluetoothScanning }
        bt.hear(headphones)
        eventually("heard") { vm.state.value.bluetoothFound == listOf(headphones) }
        bt.endScan() // a printer call took the radio
        eventually("ended") { !vm.state.value.bluetoothScanning }
        assertNull(vm.state.value.bluetoothMessage)
        assertEquals(listOf(headphones), vm.state.value.bluetoothFound)

        vm.scanBluetooth()
        eventually("scanning") { bt.scanning }
        bt.finishScan()
        eventually("ended") { !vm.state.value.bluetoothScanning }
        assertEquals(NO_BLUETOOTH_PRINTERS_TEXT, vm.state.value.bluetoothMessage)
        assertFalse(vm.state.value.bluetoothError)

        vm.scanBluetooth()
        eventually("scanning") { bt.scanning }
        bt.hear(found())
        eventually("heard a Zebra") { vm.state.value.bluetoothZebras.isNotEmpty() }
        bt.finishScan()
        eventually("ended") { !vm.state.value.bluetoothScanning }
        assertNull(vm.state.value.bluetoothMessage)

        vm.scanBluetooth()
        eventually("scanning") { bt.scanning }
        bt.endScan(BluetoothScanEnd.FAILED) // Android refused to scan again so soon
        eventually("ended") { !vm.state.value.bluetoothScanning }
        assertEquals(SCAN_ENDED_EARLY_TEXT, vm.state.value.bluetoothMessage)
        assertFalse(vm.state.value.bluetoothError)
        assertNull(bluetoothFixFor(vm.state.value.bluetoothMessage))

        // Turning on: the scan waits, then runs its course once Bluetooth is ready.
        bt.availability.value = BluetoothAvailability.UNKNOWN
        vm.scanBluetooth()
        eventually("waiting") { bt.scanning && vm.state.value.bluetoothScanning }
        delay(200)
        assertTrue(vm.state.value.bluetoothScanning)
        assertNull(vm.state.value.bluetoothMessage)
        bt.availability.value = BluetoothAvailability.READY
        bt.hear(found())
        eventually("heard once ready") { vm.state.value.bluetoothZebras.isNotEmpty() }
        vm.stopBluetoothScan()
        eventually("stopped") { !vm.state.value.bluetoothScanning }
        assertNull(vm.state.value.bluetoothMessage)
    }

    /** While a check is asking the printer, Bluetooth can't be picked: the check's query would end
     *  its scan without a word. A scan running when the checks start stops, keeping its list. */
    @Test fun noBluetoothScanWhileACheckAsksThePrinter() = runBlocking<Unit> {
        eventually("pick") { builder.pick.value?.dpi == 203 }
        val z = zebra(savedHost)
        val gate = CompletableDeferred<Unit>()
        z.statusGate = gate
        val vm = vm()
        vm.scanBluetooth()
        eventually("scanning") { bt.scanning && vm.state.value.bluetoothScanning }
        bt.hear(found())
        eventually("listed") { vm.state.value.bluetoothFound == listOf(found()) }
        vm.checkAgain()
        withTimeout(8_000) { z.inStatus.await() }
        assertFalse(vm.state.value.bluetoothScanning)
        assertEquals(listOf(found()), vm.state.value.bluetoothFound)
        assertFalse(vm.state.value.bluetoothScanAllowed)
        val scans = bt.scans
        vm.pickBluetooth(emptyList()) {}
        vm.scanBluetooth()
        delay(200)
        assertEquals(scans, bt.scans)
        gate.complete(Unit)
        eventually("checked") { !vm.state.value.checking }
        assertTrue(vm.state.value.bluetoothScanAllowed)
    }

    /** The time left is reckoned from the font's first progress report (waiting for the printer
     *  isn't install time), and measured only once a meaningful amount has gone out and been
     *  timed: a network install shows nothing before that. The clock is the view model's own
     *  (virtual here), so the numbers are exact. */
    @Test fun installEtaStartsAtTheFirstReportAndWaitsForEnoughBytes() = runBlocking<Unit> {
        libraryFonts("ROBOTO.TTF" to ByteArray(400_000))
        val z = zebra(savedHost)
        z.installSteps = listOf(0.02, 0.03, 0.05, 1.0)
        z.installHoldAt = 0.02
        val clock = FakeClock()
        val vm = vm(nanoTime = clock::ns)
        vm.checked { vm.checkAgain() }
        // Something else holds the printer for 30 s (of the clock's) before the font can start.
        val held = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val holder = async(Dispatchers.Default) { lock.withLock { held.complete(Unit); release.await() } }
        withTimeout(8_000) { held.await() }
        vm.installFonts()
        delay(100)
        clock.advanceMs(30_000)
        release.complete(Unit)
        eventually("8 KB sent") { z.atInstallHold == 0.02 && vm.state.value.installProgress == 0.02f }
        assertNull(vm.state.value.installEta)
        clock.advanceMs(1_200)
        z.installHoldAt = 0.03
        eventually("12 KB sent") { z.atInstallHold == 0.03 && vm.state.value.installProgress == 0.03f }
        // Over a second on, but only 12 KB measured: still nothing shown.
        assertNull(vm.state.value.installEta)
        z.installHoldAt = 0.05
        eventually("20 KB sent") { z.atInstallHold == 0.05 && vm.state.value.installProgress == 0.05f }
        // 20 KB in 1.2 s since the first report: 22.8 s for the 380 KB left. Timed from before the
        // 30 s wait for the printer, it would read over 9 minutes.
        assertEquals("about 23 s left", vm.state.value.installEta)
        z.installHoldAt = null
        eventually("installed") { !vm.state.value.installing }
        holder.await()
    }

    /** A Bluetooth install guesses the ZD421's measured 3.9 KB/s until it has measured its own
     *  speed (iOS's rule; a network install guesses nothing), then trusts what it measured, and a
     *  later font of the same install starts from that. */
    @Test fun aBluetoothInstallGuessesItsSpeedUntilMeasured() = runBlocking<Unit> {
        libraryFonts("ROBOTO.TTF" to ByteArray(390_000), "LATO.TTF" to ByteArray(39_000))
        store.setPrinter(btPrinter)
        val z = zebra(btSerial)
        z.installSteps = listOf(0.1, 0.2, 1.0)
        z.installHoldAt = 0.1
        val clock = FakeClock()
        val vm = vm(nanoTime = clock::ns)
        vm.checked { vm.checkAgain() }
        assertEquals(2, vm.state.value.fontFix!!.installable.size)
        vm.installFonts()
        eventually("39 KB sent") { z.atInstallHold == 0.1 && vm.state.value.installProgress == 0.1f }
        // No time has passed on the clock: the guess covers the 351 KB left plus the 39 KB after
        // it at 3.9 KB/s (100 s).
        assertEquals("about 2 min left", vm.state.value.installEta)
        // 78 KB in 3 s: measured at 26 KB/s from here on (13.5 s for the 351 KB left).
        clock.advanceMs(3_000)
        z.installHoldAt = 0.2
        eventually("78 KB sent") { z.atInstallHold == 0.2 && vm.state.value.installProgress == 0.2f }
        assertEquals("about 14 s left", vm.state.value.installEta)
        clock.advanceMs(12_000)
        z.installHoldAt = 1.0
        eventually("all sent") { z.atInstallHold == 1.0 && vm.state.value.installProgress == 1f }
        assertEquals("about 2 s left", vm.state.value.installEta)
        // The next font starts from the speed the first measured, not the guess.
        z.installHoldAt = 0.1
        eventually("the second font started") { vm.state.value.installFont?.name == "LATO.TTF" && z.atInstallHold == 0.1 }
        assertEquals("about 2 s left", vm.state.value.installEta)
        z.installHoldAt = null
        eventually("installed") { !vm.state.value.installing }
    }

    /** Cancel shows it's stopping, and which font is going out, until that font has finished. */
    @Test fun cancelSaysStoppingUntilTheFontGoingOutFinishes() = runBlocking<Unit> {
        libraryFonts("ROBOTO.TTF" to byteArrayOf(1, 2, 3), "LATO.TTF" to byteArrayOf(4, 5))
        val z = zebra(savedHost)
        z.installSteps = listOf(0.5, 1.0)
        z.installHoldAt = 0.5
        val vm = vm()
        vm.checked { vm.checkAgain() }
        vm.installFonts()
        eventually("first font half sent") { z.atInstallHold == 0.5 && vm.state.value.installFont != null }
        assertEquals(InstallingFont("ROBOTO.TTF", 1, 2), vm.state.value.installFont)
        assertEquals("Installing ROBOTO.TTF (1 of 2)…", vm.state.value.installStatus)
        assertFalse(vm.state.value.installStopping)
        vm.cancelInstall()
        assertTrue(vm.state.value.installStopping)
        assertEquals("Stopping after ROBOTO.TTF…", vm.state.value.installStatus)
        z.installHoldAt = null
        eventually("stopped") { !vm.state.value.installing }
        assertFalse(vm.state.value.installStopping)
        assertNull(vm.state.value.installFont)
        assertEquals(1, z.calls.count { it == "installFont" })
    }

    @Test fun theFrontKindDefaultsTheAlignmentLabelTo2x1WithoutATemplateSize() {
        assertEquals(AlignmentSize(2.0, 1.0, 300), alignmentSizeFor(LabelKind.FRONT, 300, null))
        assertEquals("2x1", AlignmentSize(2.0, 1.0, 300).label)
        assertEquals(600, AlignmentSize(2.0, 1.0, 300).widthDots)
        assertEquals("2.25x1.5", AlignmentSize(2.25, 1.5, 203).label)
    }
}
