package com.serversherpa.kiosk.data.labels

import android.content.Context
import android.util.Log
import androidx.javascriptengine.EvaluationFailedException
import androidx.javascriptengine.JavaScriptIsolate
import androidx.javascriptengine.JavaScriptSandbox
import androidx.javascriptengine.SandboxUnsupportedException
import com.google.common.util.concurrent.ListenableFuture
import java.util.concurrent.ExecutionException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
}

/** This device can't run the label generator (its system WebView has no JavaScript sandbox). */
class LabelEngineUnsupportedException : Exception("label generation isn't supported on this device")

/**
 * The scripts that run a surface call in the sandbox. A JSON string is a valid JavaScript string
 * literal (ES2019), so the arguments travel as one literal. Where the sandbox can't take a large
 * script in one evaluation (no EVALUATE_WITHOUT_TRANSACTION_LIMIT: the script crosses Binder,
 * about 1 MB), the arguments are pushed in pieces into a global first, then joined for the call.
 */
internal object LabelScripts {
    /** The surface's functions (kiosk/src/labelgen/index.ts); nothing else is ever evaluated. */
    val FUNCTIONS = setOf("buildPlan", "renderLabels", "sampleLabel", "applyPrintSettings", "withPrintMode", "alignmentTestZpl")

    /** The surface version this app speaks (`labelgen.version`). */
    const val VERSION = "1"

    private const val ARGS = "globalThis.__labelgenArgs"

    fun call(fn: String, argsJson: String, chunkChars: Int): List<String> {
        require(fn in FUNCTIONS) { "not a label generator function: $fn" }
        if (argsJson.length <= chunkChars) return listOf("labelgen.$fn(${literal(argsJson)})")
        return buildList {
            add("$ARGS = []; 0")
            chunks(argsJson, chunkChars).forEach { add("$ARGS.push(${literal(it)}); 0") }
            add("labelgen.$fn($ARGS.splice(0).join(''))")
        }
    }

    private fun literal(text: String) = JsonPrimitive(text).toString()

    /** Pieces of at most [size] chars, never splitting a surrogate pair. */
    private fun chunks(text: String, size: Int): List<String> {
        val out = ArrayList<String>()
        var start = 0
        while (start < text.length) {
            var end = minOf(start + size, text.length)
            if (end < text.length && Character.isHighSurrogate(text[end - 1])) end--
            out += text.substring(start, end)
            start = end
        }
        return out
    }
}

/**
 * Runs the bundle in a Jetpack JavaScriptEngine sandbox: an isolated V8 from the system WebView.
 * The sandbox connects on the first call and stays up with the bundle loaded; calls run one at
 * a time (a print waits for the batch in progress). A dead isolate or sandbox is dropped and the
 * next call starts a fresh one.
 */
class LabelGenerator(
    context: Context,
    private val bundle: () -> String = { context.assets.open(BUNDLE).bufferedReader().use { it.readText() } },
) : LabelEngine {
    private val app = context.applicationContext
    private val mutex = Mutex()
    private var sandbox: JavaScriptSandbox? = null
    private var isolate: JavaScriptIsolate? = null
    private var unlimited = false

    override fun isSupported(): Boolean = JavaScriptSandbox.isSupported()

    override suspend fun call(fn: String, argsJson: String): String = mutex.withLock {
        require(fn in LabelScripts.FUNCTIONS) { "not a label generator function: $fn" }
        if (!isSupported()) throw LabelEngineUnsupportedException()
        try {
            val iso = isolate()
            val scripts = LabelScripts.call(fn, argsJson, if (unlimited) Int.MAX_VALUE else CHUNK_CHARS)
            var result = ""
            for (s in scripts) result = iso.evaluateJavaScriptAsync(s).await()
            result
        } catch (e: CancellationException) {
            throw e
        } catch (e: LabelEngineUnsupportedException) {
            throw e
        } catch (e: EvaluationFailedException) {
            // The surface never throws, so this is the script itself; the isolate lives on.
            throw e
        } catch (e: Exception) {
            // A dead or killed isolate (memory, a crashed sandbox) or a failed start: the next
            // call connects again from scratch.
            Log.w(TAG, "label generator call $fn failed; starting over", e)
            reset()
            throw e
        }
    }

    private suspend fun isolate(): JavaScriptIsolate {
        isolate?.let { return it }
        val box = sandbox ?: connect().also { sandbox = it }
        unlimited = box.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_EVALUATE_WITHOUT_TRANSACTION_LIMIT)
        val iso = box.createIsolate()
        try {
            // The bundle (about 90 KB) fits one evaluation either way.
            iso.evaluateJavaScriptAsync(bundle()).await()
            val version = iso.evaluateJavaScriptAsync("String(globalThis.labelgen && labelgen.version)").await()
            check(version == LabelScripts.VERSION) { "label generator surface $version, expected ${LabelScripts.VERSION}" }
        } catch (e: Exception) {
            iso.close()
            throw e
        }
        isolate = iso
        return iso
    }

    private suspend fun connect(): JavaScriptSandbox = try {
        JavaScriptSandbox.createConnectedInstanceAsync(app).await()
    } catch (e: SandboxUnsupportedException) {
        throw LabelEngineUnsupportedException()
    }

    private fun reset() {
        runCatching { isolate?.close() }
        isolate = null
        runCatching { sandbox?.close() }
        sandbox = null
    }

    companion object {
        const val BUNDLE = "labelgen.js"
        private const val TAG = "LabelGenerator"
        /** Script piece size without EVALUATE_WITHOUT_TRANSACTION_LIMIT: strings cross Binder as
         *  UTF-16, so 128K chars is 256 KB, well under the 1 MB transaction buffer. */
        const val CHUNK_CHARS = 128 * 1024
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
