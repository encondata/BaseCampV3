package com.serversherpa.kiosk.data.labels

import android.content.Context
import android.util.Log
import androidx.javascriptengine.IsolateTerminatedException
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import androidx.javascriptengine.SandboxDeadException
import androidx.javascriptengine.SandboxUnsupportedException
import com.google.common.util.concurrent.ListenableFuture
import java.util.concurrent.ExecutionException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive

/**
 * The label generator (assets/labelgen.js, built from kiosk/src/labelgen). [call] runs one
 * surface function: [fn] with its arguments as one JSON object, answering the function's JSON
 * (a result or `{"error": ...}`).
 */
interface LabelEngine {
    suspend fun call(fn: String, argsJson: String): String

    /** False when this device can't run the generator at all. */
    fun isSupported(): Boolean = true

    /** The most assets one `renderLabels` call should carry on this engine. */
    fun maxBatch(): Int = Int.MAX_VALUE
}

/** This device can't run the label generator (its system WebView has no JavaScript sandbox). */
class LabelEngineUnsupportedException : Exception("label generation isn't supported on this device")

/** The generator's isolate or sandbox died (killed, out of memory, crashed). */
class LabelEngineDeadException(cause: Throwable? = null) : Exception("the label generator stopped", cause)

/** A generator call took too long; the sandbox was shut down so the next call starts fresh. */
class LabelEngineTimeoutException(fn: String) : Exception("the label generator took too long ($fn)")

/** One JavaScript isolate with the means to run a script in it. [unlimited]: scripts and results
 *  of any size cross in one evaluation (EVALUATE_WITHOUT_TRANSACTION_LIMIT). */
internal interface JsIsolate {
    val unlimited: Boolean
    suspend fun evaluate(script: String): String
    /** Closes the isolate and its sandbox: whatever it was running stops. */
    fun close()
}

/** Connects a fresh sandbox and isolate; throws [LabelEngineUnsupportedException] when it can't. */
internal fun interface JsConnector {
    suspend fun connect(): JsIsolate
}

/**
 * The scripts that run a surface call in the sandbox. A JSON string is a valid JavaScript string
 * literal (ES2019), so text travels as literals.
 *
 * Without EVALUATE_WITHOUT_TRANSACTION_LIMIT both the script and the result cross Binder as
 * UTF-16 strings, which must stay well under the transaction buffer (about 1 MB per process,
 * shared). [bounded] keeps every crossing within `pieceChars` chars either way: large
 * arguments are pushed in escaped pieces into a global and joined there; the result is kept in
 * a global and read back in slices. No piece or slice splits a surrogate pair.
 */
internal object LabelScripts {
    /** The surface's functions (kiosk/src/labelgen/index.ts); nothing else is ever called. */
    val FUNCTIONS = setOf("buildPlan", "renderLabels", "sampleLabel", "applyPrintSettings", "withPrintMode", "alignmentTestZpl")

    /** The surface version this app speaks (`labelgen.version`). */
    const val VERSION = "1"
    const val VERSION_SCRIPT = "String(globalThis.labelgen && labelgen.version)"

    const val ARGS = "globalThis.__labelgenArgs"
    const val RESULT = "globalThis.__labelgenResult"

    /** One evaluation, for an engine without size limits. */
    fun direct(fn: String, argsJson: String): String {
        require(fn in FUNCTIONS) { "not a label generator function: $fn" }
        return "labelgen.$fn(${literal(argsJson)})"
    }

    /** The call in evaluations that each send and return at most about [pieceChars] chars. */
    suspend fun bounded(fn: String, argsJson: String, pieceChars: Int, evaluate: suspend (String) -> String): String {
        require(fn in FUNCTIONS) { "not a label generator function: $fn" }
        val whole = literal(argsJson)
        val argsExpr = if (whole.length <= pieceChars) whole else {
            evaluate("$ARGS = []; 0")
            for (piece in pieces(argsJson, pieceChars)) evaluate("$ARGS.push(${literal(piece)}); 0")
            "$ARGS.splice(0).join('')"
        }
        val length = evaluate("$RESULT = labelgen.$fn($argsExpr); String($RESULT.length)").toIntOrNull()
            ?: throw IllegalStateException("the label generator gave no result length")
        val out = StringBuilder(length)
        while (out.length < length) {
            val slice = evaluate(slice(out.length, pieceChars))
            check(slice.isNotEmpty()) { "the label generator's result ended early" }
            out.append(slice)
        }
        evaluate("$RESULT = null; 0")
        check(out.length == length) { "the label generator's result came back the wrong length" }
        return out.toString()
    }

    /** Chars [from]..[from]+[size] of the kept result, one short when that would split a pair. */
    fun slice(from: Int, size: Int): String =
        "(function (s, i, n) { var e = Math.min(i + n, s.length); " +
            "if (e < s.length && e > i + 1) { var c = s.charCodeAt(e - 1); if (c >= 0xD800 && c <= 0xDBFF) e--; } " +
            "return s.slice(i, e); })($RESULT, $from, $size)"

    fun literal(text: String) = JsonPrimitive(text).toString()

    /** Pieces of [text] whose literals are at most [budget] chars (escapes and quotes counted),
     *  never splitting a surrogate pair. */
    fun pieces(text: String, budget: Int): List<String> {
        require(budget >= 2 + MAX_ESCAPE) { "piece budget too small: $budget" }
        val out = ArrayList<String>()
        var start = 0
        while (start < text.length) {
            var used = 2 // the quotes
            var end = start
            while (end < text.length) {
                val pair = Character.isHighSurrogate(text[end]) && end + 1 < text.length && Character.isLowSurrogate(text[end + 1])
                val cost = if (pair) 2 else escapedLength(text[end])
                if (used + cost > budget) break
                used += cost
                end += if (pair) 2 else 1
            }
            out += text.substring(start, end)
            start = end
        }
        return out
    }

    /** The most chars one char takes in a kotlinx JSON literal (`\u001f`). */
    private const val MAX_ESCAPE = 6

    private fun escapedLength(c: Char): Int = when {
        c == '"' || c == '\\' -> 2
        c < ' ' -> MAX_ESCAPE // upper bound: \n is 2, \u0001 is 6
        else -> 1
    }
}

/**
 * Runs the bundle in a Jetpack JavaScriptEngine sandbox: an isolated V8 from the system WebView.
 * The sandbox connects on the first call and stays up with the bundle loaded; calls run one at
 * a time (a print waits for the batch in progress). Every call has a time limit: on timeout the
 * sandbox is shut down (that is what stops a running script) and the next call starts a fresh
 * one. A dead sandbox is replaced and the call tried once more.
 */
class LabelGenerator internal constructor(
    private val connector: JsConnector,
    private val bundle: suspend () -> String,
    private val supported: () -> Boolean,
    private val timeoutMs: (String) -> Long = ::defaultTimeoutMs,
    private val connectTimeoutMs: Long = CONNECT_TIMEOUT_MS,
) : LabelEngine {
    constructor(context: Context) : this(
        SandboxConnector(context.applicationContext),
        bundle = { withContext(Dispatchers.IO) { context.applicationContext.assets.open(BUNDLE).bufferedReader().use { it.readText() } } },
        supported = { JavaScriptSandbox.isSupported() },
    )

    private val mutex = Mutex()
    @Volatile private var isolate: JsIsolate? = null

    override fun isSupported(): Boolean = supported()

    /** Smaller batches where every crossing goes in pieces (known once connected). */
    override fun maxBatch(): Int = if (isolate?.unlimited == false) LIMITED_BATCH else Int.MAX_VALUE

    override suspend fun call(fn: String, argsJson: String): String {
        require(fn in LabelScripts.FUNCTIONS) { "not a label generator function: $fn" }
        if (!isSupported()) throw LabelEngineUnsupportedException()
        return mutex.withLock {
            try {
                once(fn, argsJson)
            } catch (e: LabelEngineDeadException) {
                Log.w(TAG, "label generator stopped during $fn; trying once more", e)
                once(fn, argsJson)
            }
        }
    }

    /** One try; any failure but a plain cancellation shuts the sandbox down. */
    private suspend fun once(fn: String, argsJson: String): String = try {
        val iso = isolate ?: withTimeout(connectTimeoutMs) { start() }.also { isolate = it }
        withTimeout(timeoutMs(fn)) {
            if (iso.unlimited) iso.evaluate(LabelScripts.direct(fn, argsJson))
            else LabelScripts.bounded(fn, argsJson, PIECE_CHARS, iso::evaluate)
        }
    } catch (e: TimeoutCancellationException) {
        if (!currentCoroutineContext().isActive) throw e // the caller's own deadline, not ours
        Log.w(TAG, "label generator call $fn timed out; shutting the sandbox down")
        reset()
        throw LabelEngineTimeoutException(fn)
    } catch (e: CancellationException) {
        throw e
    } catch (e: LabelEngineUnsupportedException) {
        throw e
    } catch (e: Exception) {
        Log.w(TAG, "label generator call $fn failed; starting over", e)
        reset()
        throw e
    }

    private suspend fun start(): JsIsolate {
        val iso = connector.connect()
        try {
            // The bundle (about 90 KB) fits one evaluation either way.
            iso.evaluate(bundle())
            val version = iso.evaluate(LabelScripts.VERSION_SCRIPT)
            check(version == LabelScripts.VERSION) { "label generator surface $version, expected ${LabelScripts.VERSION}" }
        } catch (e: Exception) {
            iso.close()
            throw e
        }
        return iso
    }

    private fun reset() {
        isolate?.let { runCatching { it.close() } }
        isolate = null
    }

    companion object {
        const val BUNDLE = "labelgen.js"
        private const val TAG = "LabelGenerator"

        /** Chars per crossing without EVALUATE_WITHOUT_TRANSACTION_LIMIT: strings cross Binder
         *  as UTF-16, so 64K chars is 128 KB, a fraction of the shared 1 MB buffer. */
        const val PIECE_CHARS = 64 * 1024

        /** Assets per renderLabels call without EVALUATE_WITHOUT_TRANSACTION_LIMIT: about 75K
         *  chars of labels, two slices back. */
        const val LIMITED_BATCH = 50

        const val CONNECT_TIMEOUT_MS = 30_000L

        /** Generous for the build (a plan of a large move on a slow handheld), short for the
         *  print helpers (milliseconds of work: a print never waits long on a stuck sandbox). */
        fun defaultTimeoutMs(fn: String): Long = when (fn) {
            "buildPlan" -> 120_000L
            "renderLabels" -> 60_000L
            else -> 5_000L
        }
    }
}

private class SandboxConnector(private val app: Context) : JsConnector {
    override suspend fun connect(): JsIsolate {
        val sandbox = try {
            JavaScriptSandbox.createConnectedInstanceAsync(app).await()
        } catch (e: SandboxUnsupportedException) {
            throw LabelEngineUnsupportedException()
        }
        return try {
            val unlimited = sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_EVALUATE_WITHOUT_TRANSACTION_LIMIT)
            SandboxIsolate(sandbox, sandbox.createIsolate(), unlimited)
        } catch (e: Exception) {
            sandbox.close()
            throw e
        }
    }
}

private class SandboxIsolate(
    private val sandbox: JavaScriptSandbox,
    private val isolate: JavaScriptIsolate,
    override val unlimited: Boolean,
) : JsIsolate {
    override suspend fun evaluate(script: String): String = try {
        isolate.evaluateJavaScriptAsync(script).await()
    } catch (e: IsolateTerminatedException) {
        throw LabelEngineDeadException(e)
    } catch (e: SandboxDeadException) {
        throw LabelEngineDeadException(e)
    }

    override fun close() {
        runCatching { isolate.close() }
        runCatching { sandbox.close() }
    }
}

/** A ListenableFuture as a suspend call; the failure is the future's own cause. */
private suspend fun <T> ListenableFuture<T>.await(): T = suspendCancellableCoroutine { cont ->
    addListener({
        try {
            cont.resume(get())
        } catch (e: ExecutionException) {
            cont.resumeWithException(e.cause ?: e)
        } catch (e: Exception) {
            cont.resumeWithException(e)
        }
    }, Runnable::run)
}
