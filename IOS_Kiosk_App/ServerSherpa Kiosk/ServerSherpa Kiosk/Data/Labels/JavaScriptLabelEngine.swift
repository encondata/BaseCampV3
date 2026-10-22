import Foundation
import JavaScriptCore
import os

/// Runs the bundle (Resources/labelgen.js) in JavaScriptCore, the iOS counterpart of Android's
/// `LabelGenerator`. The context starts on the first call and stays up with the bundle loaded;
/// calls run one at a time (a print waits for the batch in progress), each on the context's own
/// thread, with a time limit.
///
/// JavaScriptCore can't interrupt a running script, so a call that runs out of time (or whose
/// caller is cancelled while it runs) is abandoned: its context, virtual machine and thread are
/// left to finish on their own, the result is dropped, and the next call starts a fresh context.
/// Every context gets its own `JSVirtualMachine` (contexts on one VM share its lock, so a runaway
/// would block the new one) and its own thread; only the call holding the gate is ever sent to a
/// context, so no call waits behind an abandoned one.
final class JavaScriptLabelEngine: LabelEngine, @unchecked Sendable {
    private struct State {
        var current: LabelJSContext?
        var serial = 0
    }

    private let timeoutSeconds: @Sendable (String) -> Double
    private let startTimeoutSeconds: Double
    private let bundleSource: @Sendable () -> String?
    private let gate = LabelEngineGate()
    private let state = OSAllocatedUnfairLock(initialState: State())

    private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "ServerSherpa Kiosk", category: "labels")

    /// `timeoutSeconds` is each call's limit by function name; `bundleSource` reads the bundle's
    /// text (nil when it is missing), on the engine's thread.
    init(
        timeoutSeconds: @escaping @Sendable (String) -> Double = LabelScripts.defaultTimeoutSeconds,
        startTimeoutSeconds: Double = 30,
        bundleSource: @escaping @Sendable () -> String? = JavaScriptLabelEngine.appBundle
    ) {
        self.timeoutSeconds = timeoutSeconds
        self.startTimeoutSeconds = startTimeoutSeconds
        self.bundleSource = bundleSource
    }

    deinit {
        state.withLock { $0.current }?.close()
    }

    /// The bundle the app ships.
    static let appBundle: @Sendable () -> String? = {
        guard let url = Bundle.main.url(forResource: LabelScripts.bundleName, withExtension: LabelScripts.bundleExtension) else {
            return nil
        }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    func call(_ fn: String, _ argsJson: String) async throws -> String {
        guard LabelScripts.functions.contains(fn) else { throw LabelEngineError.notAllowed(fn) }
        return try await exclusively(fn) { $0.invoke(fn, argsJson) }
    }

    /// Starts the context if it isn't up yet; false when it can't start.
    func isSupported() async -> Bool {
        if state.withLock({ $0.current }) != nil { return true }
        do {
            _ = try await exclusively("isSupported") { _ in .success("") }
            return true
        } catch {
            return false
        }
    }

    #if DEBUG
    /// Test-only: evaluates `script` in the current context through the same gate, start and
    /// time limit (`timeoutSeconds("_evaluateForTesting")`) as `call`. Never in release builds.
    func _evaluateForTesting(_ script: String) async throws -> String {
        try await exclusively("_evaluateForTesting") { $0.evaluate(script) }
    }
    #endif

    /// Runs `work` on the started context, one call at a time.
    private func exclusively(_ fn: String, _ work: @escaping @Sendable (LabelJSContext) -> Result<String, LabelEngineError>) async throws -> String {
        try await gate.acquire()
        do {
            let answer = try await once(fn, work)
            await gate.release()
            return answer
        } catch {
            await gate.release()
            throw error
        }
    }

    /// One try. Any failure retires the context (as Android shuts its sandbox down on every
    /// failure but a plain cancellation; here a cancelled call may still be running, and a fresh
    /// context costs one bundle load).
    private func once(_ fn: String, _ work: @escaping @Sendable (LabelJSContext) -> Result<String, LabelEngineError>) async throws -> String {
        let context = try await started(fn)
        do {
            return try await Self.run(fn, on: context, seconds: timeoutSeconds(fn), work)
        } catch {
            if !(error is CancellationError) {
                Self.log.warning("label generator call \(fn, privacy: .public) failed; starting over: \(String(describing: error), privacy: .public)")
            }
            retire(context)
            throw error
        }
    }

    /// The current context, or a fresh one with the bundle loaded and its version checked.
    private func started(_ fn: String) async throws -> LabelJSContext {
        if let current = state.withLock({ $0.current }) { return current }
        let serial = state.withLock { s in
            s.serial += 1
            return s.serial
        }
        let context = LabelJSContext(name: "labelgen-\(serial)")
        let source = bundleSource
        do {
            _ = try await Self.run(fn, on: context, seconds: startTimeoutSeconds) { c in
                guard let bundle = source() else { return .failure(.unsupported) }
                return c.load(bundle).map { "" }
            }
        } catch {
            if LabelEngineError.isUnsupported(error) {
                Self.log.error("the label generator couldn't start")
            }
            context.close()
            throw error
        }
        state.withLock { $0.current = context }
        return context
    }

    private func retire(_ context: LabelJSContext) {
        state.withLock { s in
            if s.current === context { s.current = nil }
        }
        context.close()
    }

    /// `work` on `context`'s thread, answered when it finishes, when `seconds` pass
    /// (`.timeout(fn)`), or when the caller is cancelled, whichever comes first.
    private static func run(
        _ fn: String, on context: LabelJSContext, seconds: Double,
        _ work: @escaping @Sendable (LabelJSContext) -> Result<String, LabelEngineError>
    ) async throws -> String {
        try Task.checkCancellation()
        let answer = OnceAnswer()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                answer.install(continuation)
                context.thread.perform { answer.resume(work(context).mapError { $0 }) }
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + seconds) {
                    answer.resume(.failure(LabelEngineError.timeout(fn)))
                }
            }
        } onCancel: {
            answer.resume(.failure(CancellationError()))
        }
    }
}

/// One JSContext on its own virtual machine, owned by its own thread. `load`, `invoke` and
/// `evaluate` run on `thread` only.
private final class LabelJSContext: @unchecked Sendable {
    let thread: LabelEngineThread
    private var context: JSContext?
    private var labelgen: JSValue?

    init(name: String) {
        thread = LabelEngineThread(name: name)
    }

    /// The thread finishes what it is running and exits.
    func close() {
        thread.stop()
    }

    /// A fresh VM and context with `bundle` run and its surface version checked.
    func load(_ bundle: String) -> Result<Void, LabelEngineError> {
        guard let vm = JSVirtualMachine(), let context = JSContext(virtualMachine: vm) else {
            return .failure(.unsupported)
        }
        context.name = thread.name
        context.evaluateScript(bundle, withSourceURL: URL(string: "labelgen.js"))
        if context.exception != nil { return .failure(.unsupported) }
        let version = context.evaluateScript(LabelScripts.versionScript)
        guard context.exception == nil, version?.isString == true, version?.toString() == LabelScripts.version,
              let labelgen = context.objectForKeyedSubscript("labelgen"), labelgen.isObject else {
            return .failure(.unsupported)
        }
        self.context = context
        self.labelgen = labelgen
        return .success(())
    }

    /// `labelgen[fn](argsJson)`: the arguments travel as one JS string value, never as source.
    func invoke(_ fn: String, _ argsJson: String) -> Result<String, LabelEngineError> {
        guard let context, let labelgen else { return .failure(.unsupported) }
        context.exception = nil
        return text(of: labelgen.invokeMethod(fn, withArguments: [argsJson]), in: context, fn)
    }

    func evaluate(_ script: String) -> Result<String, LabelEngineError> {
        guard let context else { return .failure(.unsupported) }
        context.exception = nil
        return text(of: context.evaluateScript(script), in: context, "a script")
    }

    private func text(of value: JSValue?, in context: JSContext, _ what: String) -> Result<String, LabelEngineError> {
        if let exception = context.exception {
            context.exception = nil
            return .failure(.evaluationFailed(exception.toString() ?? "\(what) threw"))
        }
        guard let value, value.isString, let text = value.toString() else {
            return .failure(.evaluationFailed("\(what) answered no text"))
        }
        return .success(text)
    }
}

/// A dedicated thread running its own run loop (JavaScriptCore schedules its garbage collection
/// timers on the run loop of the thread that made the VM). Never a Swift concurrency thread.
private final class LabelEngineThread: @unchecked Sendable {
    let name: String
    private let lock = NSLock()
    private var runLoop: CFRunLoop?
    private var pending: [() -> Void] = []
    private var stopping = false
    /// Set by the stop block, on the thread itself.
    private var finished = false

    init(name: String) {
        self.name = name
        let thread = Thread { [self] in main() }
        thread.name = name
        thread.stackSize = 8 << 20
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    /// Runs `block` on the thread after whatever it is running now.
    func perform(_ block: @escaping () -> Void) {
        lock.withLock {
            guard !stopping else { return }
            enqueue { autoreleasepool { block() } }
        }
    }

    /// The thread exits once the work it has is done (for a runaway script: never).
    func stop() {
        lock.withLock {
            guard !stopping else { return }
            stopping = true
            enqueue { [self] in
                finished = true
                CFRunLoopStop(CFRunLoopGetCurrent())
            }
        }
    }

    /// Under `lock`.
    private func enqueue(_ block: @escaping () -> Void) {
        if let runLoop {
            CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue, block)
            CFRunLoopWakeUp(runLoop)
        } else {
            pending.append(block)
        }
    }

    private func main() {
        // A port keeps the run loop waiting for work rather than returning at once.
        let port = NSMachPort()
        RunLoop.current.add(port, forMode: .default)
        lock.withLock {
            let current: CFRunLoop = CFRunLoopGetCurrent()
            runLoop = current
            for block in pending {
                CFRunLoopPerformBlock(current, CFRunLoopMode.defaultMode.rawValue, block)
            }
            pending = []
        }
        while !finished {
            autoreleasepool { _ = RunLoop.current.run(mode: .default, before: .distantFuture) }
        }
        RunLoop.current.remove(port, forMode: .default)
    }
}

/// One call's answer: the first of the work, the deadline and a cancellation wins; the rest are
/// dropped. A resume before the continuation is installed is kept for it.
private final class OnceAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<String, Error>?
    private var early: Result<String, Error>?
    private var done = false

    func install(_ continuation: CheckedContinuation<String, Error>) {
        let ready: Result<String, Error>? = lock.withLock {
            if let early {
                self.early = nil
                return early
            }
            self.continuation = continuation
            return nil
        }
        if let ready { continuation.resume(with: ready) }
    }

    func resume(_ result: Result<String, Error>) {
        let waiting: CheckedContinuation<String, Error>? = lock.withLock {
            guard !done else { return nil }
            done = true
            guard let continuation else {
                early = result
                return nil
            }
            self.continuation = nil
            return continuation
        }
        waiting?.resume(with: result)
    }
}

/// One call at a time, first come first served; a caller cancelled while it waits stops waiting.
private actor LabelEngineGate {
    private var busy = false
    private var waiters: [(id: UInt64, continuation: CheckedContinuation<Void, Error>)] = []
    private var nextId: UInt64 = 0

    func acquire() async throws {
        if !busy {
            busy = true
            return
        }
        nextId += 1
        let id = nextId
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiters.append((id, continuation))
                }
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    /// Hands the gate to the next waiter, or frees it.
    func release() {
        if waiters.isEmpty {
            busy = false
        } else {
            waiters.removeFirst().continuation.resume()
        }
    }

    private func cancel(_ id: UInt64) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        waiters.remove(at: index).continuation.resume(throwing: CancellationError())
    }
}
