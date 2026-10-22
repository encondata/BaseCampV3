package com.serversherpa.kiosk.data.labels

import android.content.Context
import android.util.Log
import androidx.javascriptengine.IsolateStartupParameters
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

    /** The most assets one `renderLabels` call should carry on this engine (a generator connects
     *  first to know). */
    suspend fun maxBatch(): Int = Int.MAX_VALUE
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
        sandboxConnector(context.applicationContext),
        bundle = { withContext(Dispatchers.IO) { context.applicationContext.assets.open(BUNDLE).bufferedReader().use { it.readText() } } },
        supported = { JavaScriptSandbox.isSupported() },
    )

    private val mutex = Mutex()
    @Volatile private var isolate: JsIsolate? = null

    override fun isSupported(): Boolean = supported()

    /** Smaller batches where every crossing goes in pieces. Only the connected sandbox knows, so
     *  this connects first (never an unbounded guess before the first call). */
    override suspend fun maxBatch(): Int = withIsolate("maxBatch") { if (it.unlimited) Int.MAX_VALUE else LIMITED_BATCH }

    override suspend fun call(fn: String, argsJson: String): String {
        require(fn in LabelScripts.FUNCTIONS) { "not a label generator function: $fn" }
        return withIsolate(fn) { iso ->
            if (iso.unlimited) iso.evaluate(LabelScripts.direct(fn, argsJson))
            else LabelScripts.bounded(fn, argsJson, PIECE_CHARS, iso::evaluate)
        }
    }

    /** Runs [work] on the connected isolate, one at a time; a dead sandbox gets one more try. */
    private suspend fun <T> withIsolate(fn: String, work: suspend (JsIsolate) -> T): T {
        if (!isSupported()) throw LabelEngineUnsupportedException()
        return mutex.withLock {
            try {
                once(fn, work)
            } catch (e: LabelEngineDeadException) {
                Log.w(TAG, "label generator stopped during $fn; trying once more", e)
                once(fn, work)
            }
        }
    }

    /** One try; any failure but a plain cancellation shuts the sandbox down. */
    private suspend fun <T> once(fn: String, work: suspend (JsIsolate) -> T): T = try {
        val iso = isolate ?: withTimeout(connectTimeoutMs) { start() }.also { isolate = it }
        withTimeout(timeoutMs(fn)) { work(iso) }
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

        /** The isolate's heap cap, where the sandbox takes one: generous (a build plans and
         *  renders in chunks, tens of MB at most), so a runaway ends as a terminated isolate,
         *  tried once more, rather than taking the sandbox process down. */
        const val MAX_HEAP_BYTES = 512L * 1024 * 1024

        /** Generous for the build (a plan of a large move on a slow handheld), short for the
         *  print helpers (milliseconds of work: a print never waits long on a stuck sandbox). */
        fun defaultTimeoutMs(fn: String): Long = when (fn) {
            "buildPlan" -> 120_000L
            "renderLabels" -> 60_000L
            else -> 5_000L
        }
    }
}

/**
 * Connects through an asynchronous sandbox factory (on the device,
 * `JavaScriptSandbox.createConnectedInstanceAsync`). The library binds ONE sandbox per process:
 * until that sandbox is closed, every other connect fails ("Binding to already bound service").
 *
 * So a connect given up on (its caller cancelled, or past the connect deadline) is left to
 * finish, never cancelled (cancelling the future unbinds without freeing the library's binding
 * flag), and whatever sandbox it delivers is closed on arrival. The next connect waits for it
 * first. An "already bound" failure counts as a dead sandbox: the call is tried once more, and
 * every later call tries again.
 *
 * [closeSandbox] must be safe to call twice. [open] makes the isolate on a connected sandbox;
 * when it throws, the sandbox is closed. Connects never overlap (the generator's lock).
 */
internal class FutureConnector<S : Any>(
    private val connectAsync: () -> ListenableFuture<S>,
    private val closeSandbox: (S) -> Unit,
    private val open: (S) -> JsIsolate,
) : JsConnector {
    /** A connect nobody waits for any more, still binding. */
    @Volatile private var abandoned: ListenableFuture<S>? = null

    override suspend fun connect(): JsIsolate {
        abandoned?.let { pending ->
            val late = try {
                pending.awaitOrClose(closeSandbox)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null // it failed: nothing bound
            }
            late?.let(closeSandbox)
            abandoned = null
        }
        val sandbox = try {
            val future = connectAsync()
            future.awaitOrClose(closeSandbox, onAbandon = { abandoned = future })
        } catch (e: CancellationException) {
            throw e
        } catch (e: SandboxUnsupportedException) {
            throw LabelEngineUnsupportedException()
        } catch (e: IllegalStateException) {
            if (e.message?.contains("already bound") == true) throw LabelEngineDeadException(e)
            throw e
        }
        return try {
            open(sandbox)
        } catch (e: Exception) {
            closeSandbox(sandbox)
            throw e
        }
    }
}

/** The device's sandbox. Its isolate is made synchronously (`createIsolate`), so only the
 *  connect can be left in flight. */
private fun sandboxConnector(app: Context) = FutureConnector(
    connectAsync = { JavaScriptSandbox.createConnectedInstanceAsync(app) },
    closeSandbox = { runCatching { it.close() } },
    open = { sandbox ->
        val unlimited = sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_EVALUATE_WITHOUT_TRANSACTION_LIMIT)
        val params = IsolateStartupParameters()
        if (sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_MAX_HEAP_SIZE)) {
            params.maxHeapSizeBytes = LabelGenerator.MAX_HEAP_BYTES
        }
        SandboxIsolate(sandbox, sandbox.createIsolate(params), unlimited)
    },
)

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
private suspend fun <T> ListenableFuture<T>.await(): T = awaitOrClose(close = {})

/**
 * [await] for a future that delivers something to close. When the caller stops waiting (it was
 * cancelled, or it was cancelled just as the value arrived), the future runs on and [close] gets
 * what it delivers; [onAbandon] says so at once.
 */
internal suspend fun <T> ListenableFuture<T>.awaitOrClose(close: (T) -> Unit, onAbandon: () -> Unit = {}): T =
    suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { onAbandon() }
        addListener({
            val value = try {
                get()
            } catch (e: ExecutionException) {
                cont.resumeWithException(e.cause ?: e)
                return@addListener
            } catch (e: Exception) {
                cont.resumeWithException(e)
                return@addListener
            }
            // Called when the caller was already cancelled or is cancelled before it resumes.
            cont.resume(value) { _ -> close(value) }
        }, Runnable::run)
    }
