import Testing
import Foundation
@testable import ServerSherpa_Kiosk

private final class InstalledAppFixtureBundle {}

/// When the kiosk asks the Devices site for a newer build, and what Home and Settings are left
/// holding: after sign-in, on foreground once 6 hours have passed, one request at a time, a
/// Later that lasts until another offer, and failures that say why.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct UpdateCheckerTests {
    private nonisolated static let devices = "https://devices.dev.serversherpa.com"
    private nonisolated static let itms = "itms-services://?action=download-manifest&url=https%3A%2F%2Fdevices.dev.serversherpa.com%2Fm.plist"
    private nonisolated static let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private final class Harness {
        let api = FakeDevicesApi()
        let clock = MutableBox(UpdateCheckerTests.t0)
        let devicesUrl = MutableBox<String?>(UpdateCheckerTests.devices)
        let signedIn = MutableBox(true)
        let checker: UpdateChecker

        @MainActor init(profile: ProfileKind = .adhoc) {
            let installed = InstalledApp(bundleId: "Server-Sherpas.ServerSherpa-Kiosk", versionName: "1.0", build: "1", profile: profile)
            let clock = clock, devicesUrl = devicesUrl, signedIn = signedIn
            checker = UpdateChecker(api: api, installed: installed, devicesUrl: { devicesUrl.value },
                                    signedIn: { signedIn.value }, now: { clock.value })
        }
    }

    /// Another answer's link: every answer mints a new manifest token, so the link differs.
    private nonisolated static let itmsB = "itms-services://?action=download-manifest&url=https%3A%2F%2Fdevices.dev.serversherpa.com%2Fm.plist%3Ft%3DB"

    private static func available(_ version: String = "1.2.0", build: String = "7", url: String = itms) -> UpdateAnswer {
        UpdateAnswer(status: "available", versionName: version, build: build, notes: "Fixes", installUrl: url, size: 1234)
    }

    private static func offer(_ version: String = "1.2.0", build: String = "7", url: String = itms) -> UpdateOffer {
        .available(version: version, build: build, notes: "Fixes", size: 1234, installUrl: URL(string: url)!)
    }

    @Test func checkNowStoresTheOffer() async {
        let h = Harness()
        h.api.enqueue(Self.available())
        await h.checker.checkNow()
        #expect(h.checker.state == .done(Self.offer()))
        #expect(h.checker.lastChecked == Self.t0)
        #expect(h.checker.homeOffer == Self.offer())
        #expect(h.api.queries == [UpdateQuery(bundleId: "Server-Sherpas.ServerSherpa-Kiosk", build: "1", profile: .adhoc)])
    }

    @Test func signedOutNeverChecks() async {
        let h = Harness()
        h.signedIn.value = false
        await h.checker.checkNow()
        await h.checker.checkIfDue()
        #expect(h.api.callCount == 0)
        #expect(h.checker.state == .idle)
        #expect(h.checker.lastChecked == nil)
    }

    @Test func foregroundInsideSixHoursDoesNotCheck() async {
        let h = Harness()
        await h.checker.checkIfDue()                         // never checked: due
        #expect(h.api.callCount == 1)
        h.clock.value = Self.t0.addingTimeInterval(5 * 3600 + 59 * 60)
        await h.checker.checkIfDue()
        #expect(h.api.callCount == 1)
        h.clock.value = Self.t0.addingTimeInterval(6 * 3600)
        await h.checker.checkIfDue()
        #expect(h.api.callCount == 2)
        #expect(UpdateChecker.interval == 6 * 3600)
    }

    @Test func overlappingChecksSendOneRequest() async {
        let h = Harness()
        h.api.hold()
        h.api.enqueue(Self.available())
        let checker = h.checker
        let started = MutableBox(0), finished = MutableBox(0)
        // Two Check for updates taps and a foreground, all asked for while the first request is out.
        let legs: [Task<Void, Never>] = [
            Task { started.value += 1; await checker.checkNow(); finished.value += 1 },
            Task { started.value += 1; await checker.checkNow(); finished.value += 1 },
            Task { started.value += 1; await checker.checkIfDue(); finished.value += 1 },
        ]
        #expect(await waitUntil { started.value == 3 && h.api.callCount == 1 && checker.state == .checking })
        // Each leg is parked on the one request (none returned early), and none sent another.
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(20))
        #expect(finished.value == 0)
        #expect(h.api.callCount == 1)
        h.api.release()
        for leg in legs { await leg.value }
        #expect(finished.value == 3)
        #expect(h.api.callCount == 1)
        #expect(h.checker.state == .done(Self.offer()))
    }

    /// A failed check doesn't count toward the 6 hours: the next foreground tries again, while
    /// Settings' Last checked still shows the failed attempt.
    @Test func aFailedCheckIsRetriedOnTheNextForeground() async {
        let h = Harness()
        h.api.enqueue(error: ApiError.network())
        await h.checker.checkIfDue()
        #expect(h.checker.state == .failed("Can't reach devices.dev.serversherpa.com."))
        #expect(h.checker.lastChecked == Self.t0)
        h.clock.value = Self.t0.addingTimeInterval(60)
        await h.checker.checkIfDue()
        #expect(h.api.callCount == 2)
        #expect(h.checker.state == .done(.upToDate))
        #expect(h.checker.lastChecked == Self.t0.addingTimeInterval(60))
        h.clock.value = Self.t0.addingTimeInterval(120)
        await h.checker.checkIfDue()                         // answered a minute ago: not due
        #expect(h.api.callCount == 2)
    }

    /// A sign-out between Check for updates queuing its run and the run starting: the run does
    /// nothing (no Checking, no failure, no Last checked, no request). The sign-out is queued on the
    /// main actor first; `checkNow` runs inline up to its first suspension and queues its run after
    /// it, so the sign-out lands in between.
    @Test func resetBeforeTheRunStartsLeavesNothing() async {
        for url in [nil, Self.devices] {
            let h = Harness()
            h.devicesUrl.value = url
            let checker = h.checker
            let signOut = Task { checker.reset() }
            await checker.checkNow()
            await signOut.value
            #expect(h.checker.state == .idle, "devices url \(url ?? "nil")")
            #expect(h.checker.lastChecked == nil)
            #expect(h.api.callCount == 0)
        }
    }

    @Test func laterHidesHomeUntilAnotherOffer() async {
        let h = Harness()
        h.api.enqueue(Self.available())
        await h.checker.checkNow()
        h.checker.later()
        #expect(h.checker.homeOffer == nil)
        #expect(h.checker.state == .done(Self.offer()))      // Settings still shows it

        // The same version and build again, with a new link (every answer has a new token): still hidden.
        h.api.enqueue(Self.available(url: Self.itmsB))
        await h.checker.checkNow()
        #expect(h.checker.homeOffer == nil)
        #expect(h.checker.state == .done(Self.offer(url: Self.itmsB)))

        // Same version, another build: shown.
        h.api.enqueue(Self.available("1.2.0", build: "8", url: Self.itmsB))
        await h.checker.checkNow()
        #expect(h.checker.homeOffer == Self.offer("1.2.0", build: "8", url: Self.itmsB))

        h.checker.later()
        h.api.enqueue(Self.available("1.3.0", build: "9"))
        await h.checker.checkNow()
        #expect(h.checker.homeOffer == Self.offer("1.3.0", build: "9"))
    }

    /// Update never opens a kept link (it expires 30 minutes after its answer): the tap checks
    /// again and opens the new answer's link.
    @Test func updateTapFetchesAFreshLink() async {
        let h = Harness()
        h.api.enqueue(Self.available())
        await h.checker.checkNow()
        #expect(h.checker.homeOffer == Self.offer())

        h.clock.value = Self.t0.addingTimeInterval(31 * 60)
        h.api.enqueue(Self.available(url: Self.itmsB))
        let url = await h.checker.freshInstallUrl()
        #expect(h.api.callCount == 2)
        #expect(url == URL(string: Self.itmsB)!)
        #expect(h.checker.lastChecked == Self.t0.addingTimeInterval(31 * 60))
    }

    @Test func updateTapThatFindsNoUpdateOpensNothing() async {
        let h = Harness()
        h.api.enqueue(Self.available())
        await h.checker.checkNow()
        h.api.enqueue(UpdateAnswer(status: "up_to_date"))
        #expect(await h.checker.freshInstallUrl() == nil)
        #expect(h.checker.state == .done(.upToDate))
        #expect(h.checker.homeOffer == nil)
    }

    @Test func updateTapNeverReturnsANonItmsLink() async {
        let h = Harness()
        h.api.enqueue(Self.available())
        await h.checker.checkNow()
        for bad in ["https://devices.dev.serversherpa.com/m.plist", "javascript:alert(1)", "itms://x", ""] {
            h.api.enqueue(Self.available(url: bad))
            #expect(await h.checker.freshInstallUrl() == nil, "\(bad)")
            #expect(h.checker.state == .done(.waiting(message: "This update's install link isn't valid. Check again later.")))
        }
        // The scheme is matched without regard to case.
        let upper = "ITMS-SERVICES://?action=download-manifest&url=x"
        h.api.enqueue(Self.available(url: upper))
        #expect(await h.checker.freshInstallUrl() == URL(string: upper)!)
    }

    @Test func updateTapThatFailsOpensNothingAndKeepsTheOffer() async {
        let h = Harness()
        h.api.enqueue(Self.available())
        await h.checker.checkNow()
        h.api.enqueue(error: ApiError.network())
        #expect(await h.checker.freshInstallUrl() == nil)
        #expect(h.checker.state == .failed("Can't reach devices.dev.serversherpa.com."))
        #expect(h.checker.lastOffer == Self.offer())
        #expect(h.checker.homeOffer == Self.offer())
    }

    @Test func updateTapSignedOutSendsNothing() async {
        let h = Harness()
        h.signedIn.value = false
        #expect(await h.checker.freshInstallUrl() == nil)
        #expect(h.api.callCount == 0)
    }

    /// A tap while a check is out joins it: one request, and the link it brings.
    @Test func updateTapJoinsACheckInFlight() async {
        let h = Harness()
        h.api.hold()
        h.api.enqueue(Self.available(url: Self.itmsB))
        let checker = h.checker
        let running = Task { await checker.checkNow() }
        #expect(await waitUntil { h.api.callCount == 1 })
        let tap = Task { await checker.freshInstallUrl() }
        try? await Task.sleep(for: .milliseconds(20))
        h.api.release()
        await running.value
        #expect(await tap.value == URL(string: Self.itmsB)!)
        #expect(h.api.callCount == 1)
    }

    @Test func registerFirstShowsOnHome() async {
        let h = Harness(profile: .none)
        h.api.enqueue(Self.available())                      // not Ad Hoc: register first
        await h.checker.checkNow()
        #expect(h.checker.homeOffer == .registerFirst(message: "Add this iPhone on devices.dev.serversherpa.com first."))

        h.api.enqueue(UpdateAnswer(status: "register_first", message: "Add it on the site."))
        await h.checker.checkNow()
        #expect(h.checker.homeOffer == .registerFirst(message: "Add it on the site."))
    }

    @Test func waitingStaysOffHome() async {
        let h = Harness()
        h.api.enqueue(UpdateAnswer(status: "preparing", message: "Getting it ready."))
        await h.checker.checkNow()
        #expect(h.checker.state == .done(.waiting(message: "Getting it ready.")))
        #expect(h.checker.homeOffer == nil)

        h.api.enqueue(UpdateAnswer(status: "up_to_date"))
        await h.checker.checkNow()
        #expect(h.checker.state == .done(.upToDate))
        #expect(h.checker.homeOffer == nil)
    }

    @Test func noDevicesUrlFailsWithoutARequest() async {
        let h = Harness()
        h.devicesUrl.value = nil
        await h.checker.checkNow()
        #expect(h.checker.state == .failed("This kiosk's API address doesn't start with api., so the Devices site can't be found."))
        #expect(h.api.callCount == 0)
        #expect(h.checker.devicesHost == nil)

        // a changed API URL counts on the next check
        h.devicesUrl.value = Self.devices
        await h.checker.checkNow()
        #expect(h.api.callCount == 1)
        #expect(h.checker.state == .done(.upToDate))
    }

    @Test func failuresSayWhy() async {
        let h = Harness()
        #expect(h.checker.devicesHost == "devices.dev.serversherpa.com")
        h.api.enqueue(error: ApiError.network())
        await h.checker.checkNow()
        #expect(h.checker.state == .failed("Can't reach devices.dev.serversherpa.com."))

        h.api.enqueue(error: ApiError(status: 503, code: "main_api_unavailable",
                                      detail: ["message": "Sign-in is unavailable right now. Try again in a minute."]))
        await h.checker.checkNow()
        #expect(h.checker.state == .failed("Sign-in is unavailable right now. Try again in a minute."))

        h.api.enqueue(error: ApiError(status: 500, code: "x"))
        await h.checker.checkNow()
        #expect(h.checker.state == .failed("The Devices site answered 500."))
    }

    /// A Devices 401/403 (it couldn't verify the token with the main API) says so in the app's
    /// words, not the server's.
    @Test func unauthorizedSaysTheSignInWasNotConfirmed() async {
        let h = Harness()
        for status in [401, 403] {
            h.api.enqueue(error: ApiError(status: status, code: "invalid_token", detail: ["message": "Token rejected by upstream."]))
            await h.checker.checkNow()
            #expect(h.checker.state == .failed("The Devices site couldn't confirm this sign-in. Try again later."), "\(status)")
        }
    }

    @Test func failureKeepsTheLastOffer() async {
        let h = Harness()
        h.api.enqueue(Self.available())
        await h.checker.checkNow()
        h.api.enqueue(error: ApiError.network())
        await h.checker.checkNow()
        #expect(h.checker.state == .failed("Can't reach devices.dev.serversherpa.com."))
        #expect(h.checker.homeOffer == Self.offer())
    }

    @Test func resetForgetsEverything() async {
        let h = Harness()
        h.api.enqueue(Self.available())
        await h.checker.checkNow()
        h.checker.later()
        h.checker.reset()
        #expect(h.checker.state == .idle)
        #expect(h.checker.lastChecked == nil)
        #expect(h.checker.homeOffer == nil)

        // the next sign-in checks at once, and a Later from before is gone
        h.api.enqueue(Self.available())
        await h.checker.checkIfDue()
        #expect(h.api.callCount == 2)
        #expect(h.checker.homeOffer == Self.offer())
    }

    /// A sign-out while a check is out: its answer, when it comes, is dropped.
    @Test func resetDropsACheckInFlight() async {
        let h = Harness()
        h.api.hold()
        h.api.enqueue(Self.available())
        let checker = h.checker
        let running = Task { await checker.checkNow() }
        #expect(await waitUntil { h.api.callCount == 1 })
        h.checker.reset()
        h.api.release()
        await running.value
        #expect(h.checker.state == .idle)
        #expect(h.checker.lastChecked == nil)
        #expect(h.checker.homeOffer == nil)
    }

    /// The installed app as the update query sends it: bundle id, version, build and the
    /// profile in the bundle (none when it has no `embedded.mobileprovision`).
    @Test func installedAppReadsTheBundle() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("installed-\(UUID().uuidString).app")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let info: [String: Any] = ["CFBundleIdentifier": "com.example.kiosk", "CFBundleShortVersionString": "1.2.0",
                                   "CFBundleVersion": "7", "CFBundlePackageType": "APPL"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: dir.appendingPathComponent("Info.plist"))
        let bare = try #require(Bundle(url: dir))
        #expect(InstalledApp.current(bundle: bare) == InstalledApp(bundleId: "com.example.kiosk", versionName: "1.2.0", build: "7", profile: .none))

        let withProfile = dir.deletingLastPathComponent().appendingPathComponent("installed-\(UUID().uuidString).app")
        try FileManager.default.copyItem(at: dir, to: withProfile)
        defer { try? FileManager.default.removeItem(at: withProfile) }
        let adhoc = try #require(Bundle(for: InstalledAppFixtureBundle.self).url(forResource: "adhoc", withExtension: "mobileprovision"))
        try FileManager.default.copyItem(at: adhoc, to: withProfile.appendingPathComponent("embedded.mobileprovision"))
        #expect(InstalledApp.current(bundle: try #require(Bundle(url: withProfile))).profile == .adhoc)
    }

    #if DEBUG
    /// `-uiTestUpdate <status>` picks the sample answer; `available` is the sample build.
    @Test func theSampleAnswersTheLaunchArgument() async throws {
        #expect(SampleDevicesApi.status(in: ["app", "-uiTestUpdate", "register_first"]) == "register_first")
        #expect(SampleDevicesApi.status(in: ["app", "-uiTestUpdate"]) == nil)
        #expect(SampleDevicesApi.status(in: ["app"]) == nil)
        let q = UpdateQuery(bundleId: "b", build: "1", profile: .adhoc)
        let answer = try await SampleDevicesApi(status: "available").checkUpdates(q)
        #expect(updateOffer(answer, profile: .adhoc, devicesUrl: Self.devices) == .available(
            version: "1.2.0", build: "7", notes: "Faster sync.\nFixes the scan box on iPhone.", size: 48_200_000,
            installUrl: URL(string: "itms-services://?action=download-manifest&url=https%3A%2F%2Fdevices.dev.serversherpa.com%2Fota%2Fsample%2Fmanifest.plist")!))
        #expect(try await SampleDevicesApi(status: "preparing").checkUpdates(q).status == "preparing")
    }
    #endif
}
