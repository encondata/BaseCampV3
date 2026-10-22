# Android Internet Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a developer-only Internet Test switch on the Android kiosk. It conditions the app's own traffic like Apple's Network Link Conditioner, on two dials: Internet (portal) and Local network (network Zebra printers). With the switch off, the app keeps its original routes untouched.

**Architecture:** all the code lives in one package, `com.serversherpa.kiosk.nettest`.
- **Pure model:** a link profile, presets, settings and expiry.
- **A blocking link shaper:** delay, speed and TCP-like drop stalls.
- **Internet path:** an OkHttp network interceptor plus a DNS delay on a conditioned client derived from the original.
- **Local path:** a delegating socket factory and socket.
- **`InternetTestRoutes`:** a process-wide router. It returns the original object when a link isn't conditioned.
- **`InternetTest` controller:** persists settings in the shared DataStore, applies the turn-off rules, and installs the router's state.
- **Compose UI:** the Developer section, the top-bar chip and the footer item.

Existing files change only at lines marked `// INTERNET-TEST`.

**Tech Stack:** Kotlin 2.0.21, Jetpack Compose, OkHttp 4.12.0, DataStore Preferences, kotlinx-serialization, kotlinx-coroutines; tests on JUnit4, kotlinx-coroutines-test, MockWebServer 4.12.0, Robolectric 4.14.1 and Compose ui-test.

**Spec:** `docs/superpowers/specs/2026-10-21-android-internet-test-design.md`. Read it before any task. The section numbers below (§) are its sections.

## Global Constraints

- Only the kiosk app's own traffic is conditioned. No VPN, and no change to other apps (§2).
- **Off is a true bypass.** While a link isn't conditioned, its callers get the very same `OkHttpClient` (`===`) or `SocketFactory` (`===`) they get today, with nothing added (§4.5, §6).
- The tool ships in every build. Nothing is debug-only (§3).
- Conditions apply only while someone is signed in (`AuthState.Authed`). The start-up restore (`SessionStore.doRefresh`), sign-in and pairing always go direct (§4.1).
- **Turn-off rules (§4.2):**
  - any sign-out (at the START of `AppContainer.logout()`, before its portal calls);
  - auth turning `Anon` (session ended, or a start-up restore that finds nobody);
  - two hours after switch-on (`7_200_000` ms; the clock starts at switch-on, survives restarts, isn't extended by edits, and a clock moved backward counts as expired);
  - a portal Clear Setup (`Heartbeat.setupCleared`);
  - a `MoveSetupGuard` setup drop;
  - Developer mode turned off.
- Reset app leaves Internet Test alone (§4.2).
- Preset values are exactly §5's table. They're in kbps here (Apple's Mbps × 1000).
- Drops are never instant errors. They're stalls, and at high loss timeouts (§4.4).
- Conditioning never moves blocking reads onto the caller's thread. The conditioned path returns an already-read response body (§4.5).
- Every existing-file change carries `// INTERNET-TEST` on its line (§8).
- American English in all copy and comments.
- **Build and test commands** (run from `Android_Kiosk_App/`, in the foreground with a 600 s timeout):
  - `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"; export ANDROID_HOME=~/Library/Android/sdk`
  - one test class: `./gradlew testDebugUnitTest --tests '<class>'`
  - all tests: `./gradlew testDebugUnitTest assembleDebug`

## Review Focus

These are the five failure modes the spec implies but doesn't spell out. Each has a test in the owning task.

1. **A socket closed while a conditioned sleep is in progress.** Example: the printer session's watchdog fires during a 100% Loss stall. The blocked call must end within about 100 ms with an `IOException`, not sleep on (Task 4).
2. **Bad Custom values:** blank, 0, negative, a drop over 100 or a delay over 60 s. They're clamped (blank or ≤0 speed means no limit; drop 0–100; delay and DNS delay 0–60,000 ms), never a crash (Task 1). The UI only accepts digits and one decimal point for drop (Task 7).
3. **Switching while a call is in flight.** The in-flight call finishes under the conditions it started with. The next call goes direct, and the conditioned client's pooled connections are evicted (Task 3, Task 5).
4. **An unreadable saved setting** (corrupt JSON, or an unknown preset id) loads as the switch off with defaults, never a crash (Task 1).
5. **The printer scan's 64 concurrent probes.** Each pays its own handshake, and none throws from shared state (Task 4).

---

### Task 1: Link profile, presets, settings and expiry (pure model)

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/LinkProfile.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/Presets.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/InternetTestSettings.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/nettest/ModelTest.kt`

(All paths in this plan are under `Android_Kiosk_App/`.)

**Interfaces:**
- Produces:
  - `@Serializable data class LinkProfile(val downKbps: Int? = null, val upKbps: Int? = null, val downDelayMs: Int = 0, val upDelayMs: Int = 0, val downDropPct: Double = 0.0, val upDropPct: Double = 0.0, val dnsDelayMs: Int = 0)`. Here `null` speed means no limit. `fun clamped(): LinkProfile` applies the Review Focus 2 rules, with speeds capped at 1,000,000 kbps.
  - `enum class Preset(val id: String, val label: String, val profile: LinkProfile?)`, with `OFF` and `CUSTOM` having a null profile.
  - `enum class Dial(val presets: List<Preset>)`, values `INTERNET`, `LOCAL`.
  - `@Serializable data class DialSetting(val preset: String = "off", val custom: LinkProfile = DEFAULT_CUSTOM)`
  - `@Serializable data class InternetTestSettings(val enabled: Boolean = false, val armedAtMs: Long? = null, val internet: DialSetting = DialSetting(), val local: DialSetting = DialSetting())`, with:
    - `fun dial(d: Dial): DialSetting`
    - `fun activeProfile(d: Dial): LinkProfile?`: null when `!enabled` or the preset is OFF; CUSTOM gives `custom.clamped()`; otherwise the preset's profile.
    - `fun encode(): String`
    - `companion fun decode(text: String?): InternetTestSettings`: null, corrupt or unknown gives `InternetTestSettings()`, and an unknown preset id reads as `"off"`.
  - `val DEFAULT_CUSTOM = LinkProfile(256, 128, 300, 300, 5.0, 5.0)`
  - `const val TEST_LIFETIME_MS = 7_200_000L`
  - `fun isExpired(armedAtMs: Long?, nowMs: Long): Boolean`: true when null, when `nowMs < armedAtMs`, or when `nowMs - armedAtMs >= TEST_LIFETIME_MS`.
  - `fun turnsOffAtMs(armedAtMs: Long): Long = armedAtMs + TEST_LIFETIME_MS`

Preset values (§5, in kbps):

| enum | id | label | down kbps | down ms | down % | up kbps | up ms | up % | dns ms |
|---|---|---|---|---|---|---|---|---|---|
| OFF | off | Off | — | | | | | | |
| WIFI | wifi | Wi-Fi | 40000 | 1 | 0 | 33000 | 1 | 0 | 0 |
| WIFI_AC | wifi-ac | Wi-Fi 802.11ac | 250000 | 1 | 0 | 100000 | 1 | 0 | 0 |
| LTE | lte | LTE | 50000 | 50 | 0 | 10000 | 50 | 0 | 0 |
| DSL | dsl | DSL | 2000 | 5 | 0.05 | 256 | 5 | 0.039 | 0 |
| THREE_G | 3g | 3G | 780 | 100 | 0 | 330 | 100 | 0 | 0 |
| EDGE | edge | Edge | 240 | 400 | 0 | 200 | 400 | 0 | 0 |
| VERY_BAD | very-bad | Very Bad Network | 1000 | 500 | 10 | 1000 | 500 | 10 | 0 |
| HIGH_LATENCY_DNS | high-latency-dns | High Latency DNS | null | 0 | 0 | null | 0 | 0 | 3000 |
| LOSS_100 | loss-100 | 100% Loss | null | 0 | 100 | null | 0 | 100 | 0 |
| CUSTOM | custom | Custom | — | | | | | | |

`Dial.INTERNET.presets` is OFF, WIFI, WIFI_AC, LTE, DSL, THREE_G, EDGE, VERY_BAD, HIGH_LATENCY_DNS, LOSS_100, CUSTOM. `Dial.LOCAL.presets` is OFF, WIFI, VERY_BAD, LOSS_100, CUSTOM.

- [ ] **Step 1: Write the failing tests** (`ModelTest`):
  - `presetsMatchApple`: every row above, value for value, plus the two dial lists in order.
  - `clampRules`: `LinkProfile(downKbps = 0, upKbps = -5, downDelayMs = 90_000, upDelayMs = -1, downDropPct = 140.0, upDropPct = -2.0, dnsDelayMs = 70_000).clamped() == LinkProfile(null, null, 60_000, 0, 100.0, 0.0, 60_000)`
  - `activeProfileRules`: switch off gives null on both dials. On with internet `3g` gives THREE_G's profile. On with local `off` gives null. CUSTOM gives `custom.clamped()`.
  - `roundTripAndCorruptJson`: `decode(s.encode()) == s`. `decode("{not json")` and `decode(null)` both give `InternetTestSettings()`. A JSON with `"preset":"zzz"` decodes to preset `"off"`.
  - `expiryRules`: `isExpired(null, 5) == true`. `isExpired(1_000, 1_000 + 7_199_999) == false`. `isExpired(1_000, 1_000 + 7_200_000) == true`. `isExpired(10_000, 9_999) == true`.
- [ ] **Step 2: Run** `./gradlew testDebugUnitTest --tests 'com.serversherpa.kiosk.nettest.ModelTest'`. Expect it to fail because the classes don't exist yet.
- [ ] **Step 3: Implement** the three files. Serialization uses the app's existing kotlinx-serialization setup (`KioskJson` or a local `Json { ignoreUnknownKeys = true }`). The files stay free of Android imports.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5: Commit** `feat(android): Internet Test model: Apple's presets, settings, two-hour expiry`.

### Task 2: The link shaper (delay, speed, TCP-like drops)

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/LinkShaper.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/nettest/LinkShaperTest.kt`

**Interfaces:**
- Consumes: `LinkProfile` (Task 1).
- Produces:
  - `fun interface Sleeper { fun sleep(ms: Long) }`: a blocking sleep. `ThreadSleeper` uses `Thread.sleep`.
  - `class LinkShaper(val profile: LinkProfile, private val random: java.util.Random, private val sleeper: Sleeper)`, with:
    - `fun connect(timeoutMs: Long): Boolean`: the handshake. Returns false after sleeping out `timeoutMs` when every attempt drops.
    - `fun sendBurst()`: sleeps `upDelayMs`.
    - `fun receiveBurst()`: sleeps `downDelayMs`.
    - `fun paceUp(bytes: Int, timeoutMs: Long): Boolean` and `fun paceDown(bytes: Int, timeoutMs: Long): Boolean`: false when drop stalls on one chunk exceed `timeoutMs`, after sleeping out to `timeoutMs`.
    - `fun roundTripMs(): Long = upDelayMs + downDelayMs`
  - Constants: `SEGMENT_BYTES = 1460`, `RTO_START_MS = 1_000L`, `RTO_MAX_MS = 60_000L`, `FAST_RETRANSMIT_MIN_MS = 200L`.

Algorithm (the tests pin it):
- **Speed:** each chunk of up to 1,460 bytes costs `bytes × 8 / kbps` ms (no cost when speed is null). Sub-10 ms costs accumulate and are slept once they reach 10 ms, plus a final flush at the end of each `pace*` call.
- **Drops on a chunk:** each try drops with probability `dropPct / 100`.
  - The first drop of a run costs `max(FAST_RETRANSMIT_MIN_MS, roundTripMs())`, like a fast retransmit.
  - Each further consecutive drop of the same chunk costs `min(RTO_MAX_MS, RTO_START_MS × 2^(n−1))`, where n is the count of consecutive drops after the first.
  - The run resets on a delivered chunk.
  - When a chunk's accumulated stall would pass `timeoutMs`, sleep only up to `timeoutMs` and return false.
- **Connect:** sleep `roundTripMs()`. Each attempt then drops with `1 − (1 − up%/100)(1 − down%/100)`. Dropped attempts wait 1 s, 2 s, 4 s and so on (SYN retries), up to `timeoutMs` in all, then return false.

- [ ] **Step 1: Write the failing tests** with a recording `Sleeper` (it sums the requested ms in a `LongArray` and doesn't sleep) and `java.util.Random(42)`:
  - `speedOnly`: 3G down, `paceDown(97_500, 30_000)` returns true and records 1,000 ms ±10 (97,500 × 8 / 780).
  - `noLimitCostsNothing`: `LinkProfile()`, `paceDown(1_000_000, 30_000)` records 0.
  - `burstDelays`: EDGE, `sendBurst()` records 400 and `receiveBurst()` records 400.
  - `connectRoundTrip`: LTE, `connect(15_000)` is true and records 100.
  - `isolatedDrop`: `LinkProfile(downDelayMs = 100, upDelayMs = 100, downDropPct = 50.0)`. Use a scripted `Random` subclass whose `nextDouble()` returns 0.1 then 0.9. One chunk records exactly 200 ms of stall (`max(200, 200)`) plus its speed cost.
  - `consecutiveDropsBackOff`: `LinkProfile(downDropPct = 50.0)` (no delay, so the first stall is the 200 ms floor). Script five drops then a delivery. The stalls are `[200, 1000, 2000, 4000, 8000]`.
  - `totalLossHitsTimeout`: LOSS_100, `paceDown(10, 5_000)` returns false and records exactly 5,000. `connect(15_000)` returns false and records exactly 15,000.
- [ ] **Step 2: Run** `--tests 'com.serversherpa.kiosk.nettest.LinkShaperTest'`. Expect FAIL.
- [ ] **Step 3: Implement** `LinkShaper.kt` as specified.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(android): Internet Test link shaper: delay, speed and TCP-like drop stalls`.

### Task 3: The Internet path (conditioned OkHttp client) and the router

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/PortalShaping.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/InternetTestRoutes.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/nettest/PortalShapingTest.kt`

**Interfaces:**
- Consumes: `LinkProfile`, `LinkShaper`, `Sleeper`.
- Produces:
  - `object InternetTestRoutes`, with:
    - `@Volatile internal var internet: LinkProfile?`
    - `@Volatile internal var local: LinkProfile?` (local is used in Task 4)
    - `internal var sleeper: Sleeper = ThreadSleeper`
    - `internal var random: java.util.Random = java.util.Random()`
    - `fun portal(client: OkHttpClient): OkHttpClient`: returns `client` itself when `internet == null`. Otherwise returns a conditioned client built from `client`, cached by the base's identity (`===`): one cached pair, rebuilt when the base differs.
    - `internal fun evictPortal()`: evicts the conditioned client's pool.
    - `internal fun resetForTests()`
  - `internal class ConditionedPortal(base: OkHttpClient, profile: () -> LinkProfile?, random: () -> Random, sleeper: Sleeper)`, with `val client: OkHttpClient`, built as `base.newBuilder().connectionPool(ConnectionPool()).dns(DelayedDns(...)).addNetworkInterceptor(LinkInterceptor(...)).build()`, and `fun evict()`.

Interceptor behavior (a network interceptor):
- It captures the profile once at the start of the call. A null profile (the switch turned off since routing) passes through untouched.
- **New connection** (a `chain.connection()` not seen before, tracked in a weak identity set): `shaper.connect(chain.connectTimeoutMillis())`. False means throw `SocketTimeoutException("connect timed out")`.
- **Request:** `sendBurst()`. A request body is replaced by one that writes the original into a `Buffer`, then to the sink in `SEGMENT_BYTES` chunks with `paceUp`. False means throw `SocketTimeoutException("timeout")`.
- **Response:** `receiveBurst()`, then read the whole body in chunks with `paceDown(..., chain.readTimeoutMillis())`. False means throw `SocketTimeoutException("timeout")`. Return the response with a fully buffered body (`Buffer.asResponseBody(contentType, length)`).
- **DNS:** `DelayedDns` sleeps `dnsDelayMs` and then calls `Dns.SYSTEM`.

- [ ] **Step 1: Write the failing tests** against MockWebServer (real `ThreadSleeper`, short client timeouts):
  - `offReturnsTheSameClient`: `internet = null`, so `portal(base) === base`.
  - `onReturnsDerivedClientSharingCookiesAndTimeouts`: `portal(base) !== base`, `.cookieJar === base.cookieJar`, `.connectTimeoutMillis == base.connectTimeoutMillis`, and a second call returns the same cached instance.
  - `delayIsMeasurable`: `LinkProfile(downDelayMs = 300, upDelayMs = 300)`, a GET through `portal(base)` takes ≥ 600 ms (plus the 600 ms handshake on the first call), and the direct `base` takes < 300 ms.
  - `bodyIsAlreadyRead`: execute a conditioned GET for a 50 KB body, `server.shutdown()`, then `body.string()` still returns all 50 KB. That proves no socket read is left for the caller's thread.
  - `totalLossTimesOutNotInstantly`: LOSS_100 with a base whose connect timeout is 1 s. The call throws `SocketTimeoutException` after ≥ 1,000 ms, and the server recorded 0 requests.
  - `uploadPaced`: `LinkProfile(upKbps = 80)`, a 10 KB POST body takes ≥ 1,000 ms and arrives byte for byte.
  - `inFlightKeepsItsConditions` (Review Focus 3): start a call with a 500 ms down delay, set `internet = null` mid-call. The call still takes ≥ 500 ms, the next `portal(base)` is `base`, and after `evictPortal()` the conditioned pool's `connectionCount() == 0`.
  - `dnsDelayApplied`: `LinkProfile(dnsDelayMs = 300)`. A new connection to `http://localhost:<port>` (a host name, so DNS is consulted) takes ≥ 300 ms. A second call on the pooled connection doesn't pay it again.
- [ ] **Step 2: Run** `--tests 'com.serversherpa.kiosk.nettest.PortalShapingTest'`. Expect FAIL.
- [ ] **Step 3: Implement** `PortalShaping.kt` and `InternetTestRoutes.kt` (portal half; `local()` is added in Task 4).
- [ ] **Step 4: Run.** Expect PASS. Tests call `InternetTestRoutes.resetForTests()` in `@After`.
- [ ] **Step 5: Commit** `feat(android): Internet Test Internet path: a conditioned client derived from the original`.

### Task 4: The Local network path (conditioned sockets) and the printer hook

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/LocalShaping.kt`
- Modify: `app/src/main/java/com/serversherpa/kiosk/nettest/InternetTestRoutes.kt` (add `local()`)
- Modify: `app/src/main/java/com/serversherpa/kiosk/data/printer/NetworkZebra.kt`, in `zebraSession()` only: `val factory = InternetTestRoutes.local(socketFactory) // INTERNET-TEST` and `factory.createSocket()` (also marked).
- Test: `app/src/test/java/com/serversherpa/kiosk/nettest/LocalShapingTest.kt`

**Interfaces:**
- Consumes: `LinkShaper`, `InternetTestRoutes.local`/`sleeper`/`random`.
- Produces:
  - a member function `InternetTestRoutes.local(factory: SocketFactory): SocketFactory`, which returns `factory` itself when `local == null`, otherwise `ConditionedSocketFactory(factory, profile, random, sleeper)`.
  - `internal class ConditionedSocketFactory(delegate: SocketFactory, profile: LinkProfile, random: Random, sleeper: Sleeper) : SocketFactory`. `createSocket()` returns `ConditionedSocket(delegate.createSocket(), LinkShaper(profile, random, sleeper))`. The connecting overloads create, then `connect`.
  - `internal class ConditionedSocket(inner: Socket, shaper: LinkShaper) : Socket()`:
    - It delegates `connect`, `getInputStream`, `getOutputStream`, `soTimeout`, `shutdownInput`, `shutdownOutput`, `close`, `isConnected`, `isClosed`, `inetAddress`, `port`, `localPort` and `toString` to `inner`.
    - `connect(addr, t)` runs `shaper.connect(t)`. False means throw `SocketTimeoutException("connect timed out")`. Otherwise it calls `inner.connect(addr, t)`.
    - **Bursts:** the first write after connect or after a read costs `sendBurst()`. The first read after a write costs `receiveBurst()`.
    - **Pacing:** each write and read is paced with `paceUp` and `paceDown`. A read's timeout is the socket's current `soTimeout`, and 0 means `Long.MAX_VALUE`. A read whose burst delay or stalls pass `soTimeout` throws `SocketTimeoutException` after `soTimeout`, as a slow real link would.
    - **Interrupted sleeps:** every sleep is interruptible by `close()`. A socket-scoped `Sleeper` waits on a latch that `close()` releases, then throws `SocketException("Socket closed")`.

- [ ] **Step 1: Write the failing tests**, using `NetworkZebraTest`'s loopback `FakePrinter` pattern (copy it locally; don't import test code from another class):
  - `offReturnsTheSameFactory`: `local = null`, so `local(f) === f`.
  - `delegatesToTheGivenFactory`: a spy factory counting `createSocket()`. One `NetworkZebra(host, socketFactory = spy).identify()` with `local = WIFI` gives a count of 1, and the reply parses.
  - `totalLossTripsPrinterTimeouts`: `local = LOSS_100`. `NetworkZebra(..., timeouts = ZebraTimeouts(connectMs = 300, totalMs = 500)).identify()` throws `PrinterUnreachable` within 300 ms + 100 ms.
  - `watchdogCloseUnblocksAStall` (Review Focus 1): `local = LinkProfile(downDelayMs = 10_000)`. On a connected `ConditionedSocket`, a thread blocked in `read()` gets an `IOException` within 100 ms of `close()` on another thread.
  - `readHonorsSoTimeout`: `local = LinkProfile(downDelayMs = 2_000)`, `soTimeout = 300`. `read()` throws `SocketTimeoutException` after 300 ms ±100.
  - `scanConcurrency` (Review Focus 5): 64 threads each `createSocket()` + `connect` to a loopback `ServerSocket` with `local = LinkProfile(downDelayMs = 50, upDelayMs = 50)`. All 64 succeed, and each takes ≥ 100 ms.
- [ ] **Step 2: Run** `--tests 'com.serversherpa.kiosk.nettest.LocalShapingTest'` plus `com.serversherpa.kiosk.data.printer.*`. Expect the new tests to FAIL and the printer tests to stay green.
- [ ] **Step 3: Implement** `LocalShaping.kt`, `local()`, and the two marked lines in `zebraSession()`.
- [ ] **Step 4: Run** both. Expect PASS, with the printer tests unchanged.
- [ ] **Step 5: Commit** `feat(android): Internet Test Local network path: conditioned printer sockets`.

### Task 5: The controller: settings, turn-off rules, routing state

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/InternetTest.kt`
- Test: `app/src/test/java/com/serversherpa/kiosk/nettest/InternetTestControllerTest.kt`

**Interfaces:**
- Consumes: Task 1 model, `InternetTestRoutes`, `AuthState` (`data/auth/KioskAuth.kt`).
- Produces `class InternetTest(private val store: DataStore<Preferences>, private val scope: CoroutineScope, private val clock: () -> Long = System::currentTimeMillis)`, with:
  - `val settings: StateFlow<InternetTestSettings>`, loaded from string key `ss.kiosk.netTest` and starting at `InternetTestSettings()`.
  - `suspend fun setEnabled(on: Boolean)`: on sets `armedAtMs = clock()`. Off sets `armedAtMs = null` and calls `InternetTestRoutes.evictPortal()`.
  - `suspend fun choosePreset(dial: Dial, preset: Preset)`: refused, with no change, when the preset isn't in `dial.presets`.
  - `suspend fun setCustom(dial: Dial, profile: LinkProfile)`: stores `profile.clamped()`.
  - `suspend fun turnOff()`: idempotent.
  - `suspend fun beforeSignOut() = turnOff()`
  - `suspend fun onSetupDropped() = turnOff()`
  - `fun start(auth: StateFlow<AuthState>, devMode: Flow<Boolean>, setupCleared: Flow<String>)`
  - `fun turnsOffAtMs(): Long?`

`start()` launches in `scope`:
- **Routing:** combine settings with `auth is Authed`. When enabled, signed in and not expired, install `internet = activeProfile(INTERNET)` and `local = activeProfile(LOCAL)`. Otherwise install both null.
- **Auth:** any emission of `AuthState.Anon` (whether from Loading or Authed) means `turnOff()`.
- **Developer mode:** `devMode` emitting false while enabled means `turnOff()`.
- **Clear Setup:** each `setupCleared` emission means `turnOff()`.
- **Timer:** while enabled, wait until `turnsOffAtMs()` on a coroutine delay (`delay(at - clock())`), then `turnOff()`. At start, enabled but `isExpired(armedAtMs, clock())` means `turnOff()` immediately.

- [ ] **Step 1: Write the failing tests** (`runTest`, a test DataStore as in `TestContainer.kt`, a mutable fake clock, `MutableStateFlow<AuthState>`, `MutableSharedFlow<String>`, `MutableStateFlow(true)` for devMode):
  - `enableWhileSignedInInstallsRoutes`: Authed, `setEnabled(true)`, `choosePreset(INTERNET, THREE_G)`, `choosePreset(LOCAL, VERY_BAD)`. Then `InternetTestRoutes.internet == THREE_G.profile` and `.local == VERY_BAD.profile`.
  - `notSignedInMeansDirect`: auth Loading with the switch saved on and not expired gives `internet == null` and `local == null`, so the restore goes direct.
  - `anonTurnsOff`: Loading to Anon. The switch is off and persisted (decode from the store gives `enabled == false`).
  - `signOutTurnsOff`: `beforeSignOut()` leaves the switch off, and the routes are null at once.
  - `devModeOffTurnsOff`, `setupClearedTurnsOff`, `onSetupDroppedTurnsOff`.
  - `twoHourTimer`: enable at clock 0. Advance 7,199,999 ms and it's still on. Advance 1 ms more and it's off.
  - `editsDontExtend`: enable at 0, `choosePreset` at 3,600,000. It's off at 7,200,000.
  - `restartPastTwoHoursStartsOff`: save `enabled = true, armedAtMs = 0` and start a new controller with clock 7,200,000. It's off.
  - `backwardClockExpires`: save `armedAtMs = 10_000` and start with clock 9,000. It's off.
  - `offPresetOnOneDial`: enabled with internet OFF and local VERY_BAD gives `internet == null` and `local != null`.
  - `unreadableSettingLoadsOff` (Review Focus 4): put `"{bad"` under `ss.kiosk.netTest`. Settings equal `InternetTestSettings()` and the routes are null.
- [ ] **Step 2: Run** `--tests 'com.serversherpa.kiosk.nettest.InternetTestControllerTest'`. Expect FAIL.
- [ ] **Step 3: Implement** `InternetTest.kt`.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(android): Internet Test controller: settings, two-hour limit and turn-off rules`.

### Task 6: Wiring into the app (portal routes and turn-off hooks)

**Files** (each changed line marked `// INTERNET-TEST`):
- `app/src/main/java/com/serversherpa/kiosk/AppContainer.kt`:
  - `val internetTest = InternetTest(dataStore, scope)` after `prefs`;
  - `OkHttpKioskApi(httpClient, config, session, route = InternetTestRoutes::portal)`;
  - in `start()`: `internetTest.start(auth.state, prefs.devMode, heartbeat.setupCleared)` and `MoveSetupGuard(auth.state, prefs, scope, onDropped = internetTest::onSetupDropped)`;
  - first line of `logout()`: `internetTest.beforeSignOut()`. `SessionStore` stays on `httpClient`, unchanged.
- `app/src/main/java/com/serversherpa/kiosk/data/api/OkHttpKioskApi.kt`: the constructor parameter `private val route: (OkHttpClient) -> OkHttpClient = { it }` and, in `execute()`, `route(client).newCall(request)`.
- `app/src/main/java/com/serversherpa/kiosk/data/auth/MoveSetupGuard.kt`: the constructor parameter `private val onDropped: suspend () -> Unit = {}`, called right after `prefs.clearSetup()`.
- `app/src/main/java/com/serversherpa/kiosk/ui/screens/timeclock/TimeclockScreen.kt:136`: `InternetTestRoutes.portal(container.httpClient).newCall(...)`.
- Test: `app/src/test/java/com/serversherpa/kiosk/nettest/InternetTestWiringTest.kt`

**Interfaces:**
- Consumes: Tasks 3 and 5.
- Produces `AppContainer.internetTest: InternetTest`, which Task 7 uses.

- [ ] **Step 1: Write the failing tests** (Robolectric, `testContainer()` pointed at a MockWebServer URL with `prefs.setApiUrl(server.url("/").toString().trimEnd('/'))`). If `c.start()` isn't safe under Robolectric (it touches `ProcessLifecycleOwner`, DataWedge and RFID), start only what the test needs:
  - `c.internetTest.start(c.auth.state, c.prefs.devMode, c.heartbeat.setupCleared)` then `c.auth.restore()`;
  - for the move guard, `MoveSetupGuard(c.auth.state, c.prefs, scope, onDropped = c.internetTest::onSetupDropped).start()`.

  `RemovalGuardTest` (Task 8) and review then confirm the `AppContainer` lines themselves.
  - `offIsIdentity`: with a fresh container, `InternetTestRoutes.portal(c.httpClient) === c.httpClient`, and a scripted `api.systemStatus()` reaches the server with no added delay.
  - `restoreGoesDirectUnderTotalLoss`: save Internet Test on with internet LOSS_100 (armed now), script `/auth/refresh` 200 with a `SessionData` body, and `c.start()`. Auth becomes `Authed` within 2 s and the switch is still on.
  - `signOutIsQuickUnderTotalLoss`: signed in, switch on, internet LOSS_100. `c.logout()` finishes within 2 s, the server received `/kiosk/sign-out` and `/auth/logout`, and the switch is off.
  - `moveGuardDropTurnsOff`: signed in as a move session for a different move than the saved setup. The setup is cleared and the switch is off.
  - `resetAppLeavesItOn`: switch on, `c.resetApp(clearLocalData = {})`, the switch is still on.
  - `existingApiTestsUntouched`: run `OkHttpKioskApiAuthTest` and `OkHttpKioskApiEndpointsTest` unchanged. The default `route` keeps them direct.
- [ ] **Step 2: Run** `--tests 'com.serversherpa.kiosk.nettest.InternetTestWiringTest'`. Expect FAIL.
- [ ] **Step 3: Make the marked changes.**
- [ ] **Step 4: Run** the wiring test plus `com.serversherpa.kiosk.data.*` and `com.serversherpa.kiosk.AppResetTest`. Expect PASS.
- [ ] **Step 5: Commit** `feat(android): wire Internet Test into the portal client, sign-out and setup clears`.

### Task 7: The Developer section, the chip and the footer item

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/InternetTestSection.kt`
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/InternetTestIndicators.kt`
- Modify (marked): `app/src/main/java/com/serversherpa/kiosk/ui/screens/settings/DeveloperPanel.kt`: `InternetTestSection()` immediately after `if (!devMode) return@Column`.
- Modify (marked): `app/src/main/java/com/serversherpa/kiosk/ui/shell/KioskShell.kt`:
  - in the top bar, before the Sign out button, `NetTestChip(onClick = { nav.navigate(Routes.settings("developer")) })`;
  - in the footer, after the Dev mode item, `netTestFootValue()?.let { FootItem("Net test", it, valueColor = c.accent) }`.
- Test: `app/src/test/java/com/serversherpa/kiosk/nettest/InternetTestUiTest.kt` (Robolectric, `qualifiers = "w360dp-h800dp"`).

**Interfaces:**
- Consumes: `LocalAppContainer.current.internetTest` (Task 6), `SettingsRow`, `KioskChip(text, ChipTone.AMBER)`, `LocalKioskColors`.
- Produces:
  - `@Composable fun InternetTestSection()`
  - `@Composable fun NetTestChip(onClick: () -> Unit)`: renders nothing while off.
  - `@Composable fun netTestFootValue(): String?`: null while off, otherwise `"<internet label> · <local label>"`.

Copy (exact):
- Title "Internet Test".
- Hint: "Slows this app's own traffic to test bad networks. Off: the app uses its normal connections, untouched. Turns itself off after 2 hours, or when you sign out or setup is cleared."
- While on: "Turns off at <time>", with time in `h:mm a` in the device's zone.
- Dial titles "Internet" and "Local network", with captions "portal: sync, uploads, heartbeat" and "network Zebra printers".
- Each dial shows its presets as selectable chips in `Dial.presets` order, labeled with `Preset.label`.
- Summary lines, `↓ {speed} · {delay} ms · {drop}% drop` and `↑ …`:
  - speed is `{n} kbps` under 1,000, else `{n/1000} Mbps` (trimmed, so "40 Mbps" and "2 Mbps"), and `no limit` when null;
  - drop is written without trailing zeros ("0.05", "10", "0");
  - High Latency DNS adds a third line, `DNS +3000 ms`;
  - Off shows "Not conditioned".
- Custom shows a grid with columns "Download" and "Upload" and rows "Speed (kbps)", "Delay (ms)" and "Drop (%)". The boxes take digits only, with one decimal point allowed in Drop (Review Focus 2). Values save through `setCustom` as they're edited.
- Chip text "Net test".

- [ ] **Step 1: Write the failing tests:**
  - `sectionHiddenWithoutDevMode`: the DeveloperPanel with dev mode off has no "Internet Test" text.
  - `switchShowsDials`: dev mode on, turn the switch on, and "Internet", "Local network" and "Turns off at" appear.
  - `presetSummary`: choose 3G and find the texts `↓ 780 kbps · 100 ms · 0% drop` and `↑ 330 kbps · 100 ms · 0% drop`.
  - `customBoxesRemember`: choose Custom on Local network, type 64 into the Download Speed box, recompose a new section, and the box shows 64 with `settings.value.local.custom.downKbps == 64`.
  - `dropBoxRejectsLetters`: type "1a.5.2" and it keeps "1.52" with at most one decimal point.
  - `chipAndFooterOnlyWhileOn`: the KioskShell, signed in. With the switch off there's no "Net test". With it on (3G and Custom), the chip shows and the footer reads `3G · Custom`.
  - `chipOpensDeveloperSettings`: clicking the chip navigates to `Routes.settings("developer")` (assert on a `TestNavHostController`'s current route).
- [ ] **Step 2: Run** `--tests 'com.serversherpa.kiosk.nettest.InternetTestUiTest'`. Expect FAIL.
- [ ] **Step 3: Implement** the two files and the marked lines, matching the approved mockup (`.superpowers/brainstorm/24359-1792642549/content/netcond-layout.html`, option B) with the app's tokens.
- [ ] **Step 4: Run** the UI test plus `com.serversherpa.kiosk.ui.shell.*` and `com.serversherpa.kiosk.ui.screens.settings.*`. Expect PASS.
- [ ] **Step 5: Commit** `feat(android): Internet Test section, Net test chip and footer item`.

### Task 8: The removal guard and REMOVAL.md

**Files:**
- Create: `app/src/main/java/com/serversherpa/kiosk/nettest/REMOVAL.md`
- Test: `app/src/test/java/com/serversherpa/kiosk/nettest/RemovalGuardTest.kt`

**Interfaces:**
- Consumes: every marked line from Tasks 4, 6 and 7.

- [ ] **Step 1: Write the failing test:**
  - `RemovalGuardTest.touchPointsAreKnown` walks `src/main/java` outside `nettest/` for files containing `nettest` or `INTERNET-TEST`. It asserts the set equals exactly these seven files: `AppContainer.kt`, `data/api/OkHttpKioskApi.kt`, `data/auth/MoveSetupGuard.kt`, `data/printer/NetworkZebra.kt`, `ui/screens/timeclock/TimeclockScreen.kt`, `ui/screens/settings/DeveloperPanel.kt` and `ui/shell/KioskShell.kt`.
  - The same test asserts every line in those files that mentions `InternetTest`, `internetTest` or `nettest` also carries `// INTERNET-TEST`, and fails with the offending file:line otherwise.
  - Imports count as such lines, so mark them too.
- [ ] **Step 2: Run** `--tests 'com.serversherpa.kiosk.nettest.RemovalGuardTest'`. Expect FAIL until REMOVAL.md and any missing markers are in.
- [ ] **Step 3: Write REMOVAL.md** with the removal steps: delete `nettest/` in main and test; delete every `// INTERNET-TEST` line; restore the two lines in `zebraSession()` and `OkHttpKioskApi.execute()` to their original forms (`socketFactory.createSocket()` and `client.newCall(request)`); then run `./gradlew testDebugUnitTest assembleDebug`. Note that the saved `ss.kiosk.netTest` value is simply never read again.
- [ ] **Step 4: Run** the guard test, then the whole suite: `./gradlew testDebugUnitTest assembleDebug`. Expect all green.
- [ ] **Step 5: Commit** `test(android): Internet Test removal guard and REMOVAL.md`.
