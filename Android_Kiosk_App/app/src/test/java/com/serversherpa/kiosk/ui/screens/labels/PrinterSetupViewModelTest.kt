package com.serversherpa.kiosk.ui.screens.labels

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.serversherpa.kiosk.core.labels.LabelKind
import com.serversherpa.kiosk.core.labels.SavedPrinter
import com.serversherpa.kiosk.core.model.KioskSetupSelection
import com.serversherpa.kiosk.core.printer.HostId
import com.serversherpa.kiosk.core.printer.HostStatus
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
import com.serversherpa.kiosk.data.printer.FoundPrinter
import com.serversherpa.kiosk.data.printer.PrinterUnreachable
import com.serversherpa.kiosk.data.sync.SyncMeta
import com.serversherpa.kiosk.data.sync.SyncPhase
import com.serversherpa.kiosk.data.sync.SyncStatus
import java.io.File
import java.util.Collections
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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
    val onE: MutableList<String> = Collections.synchronizedList(ArrayList())
    val sent: MutableList<String> = Collections.synchronizedList(ArrayList())
    val installed: MutableList<Pair<String, ByteArray>> = Collections.synchronizedList(ArrayList())

    private fun check() { if (!answers) throw PrinterUnreachable(host) }
    override suspend fun identify(): HostId { check(); return HostId(model, "V1", if (dpi == 300) 12 else 8, "8192", dpi) }
    override suspend fun serial(): String? { check(); return serialNo }
    override suspend fun status(): HostStatus {
        check()
        statusGate?.let { inStatus.complete(Unit); it.await() }
        return HostStatus(paperOut, false, 0, 0, false, false, false, false, false, false, false, false, "0", false, 0)
    }
    override suspend fun peelerPresent(): Boolean? = if (answers) peeler else null
    override suspend fun fonts(): List<String> { check(); return synchronized(onE) { onE.toList() } }
    override suspend fun send(zpl: String) { check(); sent += zpl }
    override suspend fun installFont(name: String, bytes: ByteArray) { check(); installed += name to bytes; onE += name.uppercase() }
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

    private val saved = SavedPrinter("10.0.0.5", "ZD421", "S1", 203)

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

    private fun vm(pickWaitMs: Long = 5_000) = PrinterSetupViewModel(
        store, builder.pick, builder.status, engine, db, fontsDir,
        scanner = { scanResult }, zebraAt = ::zebra, scopeOverride = scope, pickWaitMs = pickWaitMs,
    )

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
        val z = zebra(saved.host)
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
        val z = zebra(saved.host)
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
        val z = zebra(saved.host)
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
        val z = zebra(saved.host)
        z.model = "ZT230"; z.dpi = 300; z.serialNo = "NEW1"
        val vm = vm()
        vm.checked { vm.checkAgain() }
        assertEquals(SavedPrinter(saved.host, "ZT230", "NEW1", 300), store.settings.first().printer)

        z.model = "ZT410"; z.serialNo = null
        vm.checked { vm.checkAgain() }
        assertEquals(SavedPrinter(saved.host, "ZT410", "", 300), store.settings.first().printer)
    }

    @Test fun testLabelsAreSentWithTheCurrentOffsetsAndPrintMode() = runBlocking<Unit> {
        val vm = vm()
        eventually("pick") { builder.pick.value?.dpi == 203 }
        vm.setOffsetX("12")
        vm.setOffsetY("-3")
        eventually("offsets saved") { store.settings.first().let { it.offsetX == 12 && it.offsetY == -3 } }

        vm.printTest(TestLabel.ALIGNMENT)
        eventually("alignment sent") { vm.state.value.testMessage != null && !vm.state.value.testing }
        val z = zebra(saved.host)
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
        zebra(saved.host).answers = false
        vm.printTest(TestLabel.ALIGNMENT)
        eventually("failed") { vm.state.value.testMessage != null && !vm.state.value.testing }
        assertEquals("Can't reach the printer at 10.0.0.5.", vm.state.value.testMessage)
        assertTrue(vm.state.value.testError)
    }

    @Test fun theFrontKindDefaultsTheAlignmentLabelTo2x1WithoutATemplateSize() {
        assertEquals(AlignmentSize(2.0, 1.0, 300), alignmentSizeFor(LabelKind.FRONT, 300, null))
        assertEquals("2x1", AlignmentSize(2.0, 1.0, 300).label)
        assertEquals(600, AlignmentSize(2.0, 1.0, 300).widthDots)
        assertEquals("2.25x1.5", AlignmentSize(2.25, 1.5, 203).label)
    }
}
