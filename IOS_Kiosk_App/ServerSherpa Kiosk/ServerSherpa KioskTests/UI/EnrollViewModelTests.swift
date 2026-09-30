import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// Android EnrollViewModelTest, case for case, plus the save-error mapping and the roster-rebuild re-check.
@MainActor
struct EnrollViewModelTests {
    private let store: KioskStore
    private let prefs = KioskPrefs(defaults: freshDefaults())
    private let api = FakeKioskApi()

    init() throws {
        store = KioskStore(modelContainer: try KioskSchema.container(inMemory: true))
    }

    private let rack = KioskAssetRow(id: "a1", assetId: "A-1", name: "Rack", rfid: nil, serialNumber: "SN1", makeModel: "Dell")
    private let tagged = KioskAssetRow(id: "a2", assetId: "A-2", name: "Tagged", rfid: "000000000000000000100348", serialNumber: "SN2", makeModel: "HP")

    private func build(_ assets: [KioskAssetRow]? = nil) async throws -> EnrollViewModel {
        let assets = assets ?? [rack, tagged]
        try await store.replaceRoster(assets: assets, people: [], containers: [], trucks: [],
                                      meta: SyncMeta(initiativeId: "i1", initiativeName: "Move", assets: assets.count, people: 0, containers: 0, trucks: 0, syncedAt: "now"))
        prefs.setupSelection = KioskSetupSelection(initiativeId: "i1", initiativeName: "Move", siteId: "s1", siteName: "Site", siteRole: "source", scanStatus: "pre_stage", scanLabel: "Pre-stage")
        let identity = Identity(prefs: prefs, secrets: MemorySecretStore())
        let vm = EnrollViewModel(store: store, api: api, prefs: prefs, identity: identity, flash: FlashController(), sound: nil,
                                 clock: { 0 })
        await vm.loadRoster()
        return vm
    }

    @Test func stepOneMatchesAssetOrSerialOnlyAndRefusesTags() async throws {
        let vm = try await build()
        await vm.onScan("100348")
        #expect(vm.asset == nil)
        #expect(vm.error == "That's an RFID tag. Scan the asset's serial or ID first.")
        await vm.onScan("nope"); #expect(vm.error == "No asset found for \"nope\".")
        await vm.onScan("sn1"); #expect(vm.asset?.id == "a1")
    }

    @Test func stepTwoPadsSavesAndUpdatesLocalRoster() async throws {
        let vm = try await build()
        await vm.onScan("A-1"); vm.setTagValue("10 03 49")
        #expect(vm.tagPreview == "000000000000000000100349")
        await vm.submitTag("10 03 49")
        #expect(vm.asset == nil)                                   // back to step one
        #expect(vm.toast == "Enrolled Rack → 100349")
        #expect(try await store.assets().first { $0.id == "a1" }?.rfid == "000000000000000000100349")
        #expect(vm.enrollments.count == 1)
        #expect(vm.enrollments[0].replaced == false)
    }

    /// An asset that walks in wearing a tag stops at the gate: its tag is on
    /// screen, a scan there cannot retag it, and the box opens only on Update.
    @Test func anAssetWithATagWaitsForUpdateBeforeItWillTakeANewOne() async throws {
        let vm = try await build()
        await vm.onScan("A-2")
        #expect(vm.asset?.id == "a2")
        #expect(vm.awaitingUpdate)
        #expect(vm.currentTag == "000000000000000000100348")

        // A tag read at the gate is refused, not applied.
        await vm.onScan("100350")
        #expect(vm.error == "Tagged already has a tag. Tap Update RFID Value to replace it.")
        #expect(vm.awaitingUpdate)
        #expect(vm.enrollments.isEmpty)
        #expect(api.calls.filter { $0 == "rfid" }.isEmpty)

        vm.confirmUpdate()
        #expect(!vm.awaitingUpdate)
        await vm.submitTag("100350")
        #expect(vm.enrollments.count == 1)
        #expect(vm.enrollments[0].replaced)
    }

    /// The same asset scanned twice: the second pass shows what this kiosk just
    /// put on it rather than quietly opening the box for another tag.
    @Test func anAssetEnrolledThisSessionComesBackToTheGate() async throws {
        let vm = try await build()
        await vm.onScan("A-1"); await vm.submitTag("100349")
        #expect(vm.enrollments.count == 1)

        await vm.onScan("A-1")
        #expect(vm.awaitingUpdate)
        #expect(vm.enrolledHere)
        #expect(vm.currentTag == "000000000000000000100349")
        await vm.onScan("100351")
        #expect(vm.error == "You just enrolled Rack. Tap Update RFID Value to change its tag.")
    }

    /// The duplicate-tag gate, without a round trip: the roster's own copy, and
    /// the tag this session already handed out.
    @Test func aTagAlreadyInUseNeverReachesThePortal() async throws {
        let vm = try await build()
        await vm.onScan("A-1")
        await vm.submitTag("100348")
        #expect(vm.error == "That tag is on Tagged. Scan a different tag.")
        #expect(api.calls.filter { $0 == "rfid" }.isEmpty)
        #expect(vm.asset?.id == "a1")                              // stays on step two

        // And the same tag twice in a row on another asset.
        await vm.submitTag("100349")
        await vm.onScan("SN2"); vm.confirmUpdate()
        await vm.submitTag("100349")
        #expect(vm.error == "You just enrolled that tag on Rack. Scan a different tag.")
        #expect(api.calls.filter { $0 == "rfid" }.count == 1)
    }

    @Test func errorsMapToCopy() async throws {
        api.rfidResult = { _, _ in throw ApiError(status: 409, code: "rfid_in_use", detail: ["code": "rfid_in_use", "asset_name": "Other rack"]) }
        let vm = try await build()
        await vm.onScan("A-1"); await vm.submitTag("100349")
        #expect(vm.error == "That tag is already on Other rack.")
        #expect(vm.asset?.id == "a1")                              // stays on step two
        await vm.submitTag("bad-tag")
        #expect(vm.error == "That tag has characters we can't store — letters and numbers only.")
    }

    @Test func everySaveErrorHasItsCopy() {
        #expect(saveErrorText(ApiError(status: 409, code: "rfid_in_use")) == "That tag is already on another asset.")
        #expect(saveErrorText(ApiError(status: 422, code: "bad_rfid")) == "That tag has characters we can't store — letters and numbers only.")
        #expect(saveErrorText(ApiError(status: 422, code: "rfid_too_long")) == "That tag is longer than 24 characters.")
        #expect(saveErrorText(ApiError(status: 423, code: "read_only_mode")) == "The portal is in read-only mode. Try again shortly.")
        #expect(saveErrorText(ApiError(status: 423, code: "x")) == "The portal is in read-only mode. Try again shortly.")
        #expect(saveErrorText(ApiError.network()) == "Can't reach the portal. The tag was not saved.")
        #expect(saveErrorText(ApiError(status: 500, code: "boom")) == "Couldn't save the tag (boom).")
        #expect(saveErrorText(URLError(.timedOut)) == "Couldn't save the tag (unknown_error).")
    }

    private final class Bodies: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [KioskRfidEnrollIn] = []
        func add(_ b: KioskRfidEnrollIn) { lock.lock(); all.append(b); lock.unlock() }
        var list: [KioskRfidEnrollIn] { lock.lock(); defer { lock.unlock() }; return all }
    }

    @Test func theSavePostCarriesTheSelectionCheckpointAndAFreshId() async throws {
        let bodies = Bodies()
        api.rfidResult = { id, b in bodies.add(b); return KioskRfidEnroll(assetId: id, rfidTag: b.rfidTag) }
        let vm = try await build()
        await vm.onScan("A-1"); await vm.submitTag("100349")
        await vm.onScan("A-1"); vm.confirmUpdate(); await vm.submitTag("100352")
        let sent = bodies.list
        #expect(sent.count == 2)
        #expect(sent[0].rfidTag == "000000000000000000100349")
        #expect(sent[0].scanStatus == "pre_stage"); #expect(sent[0].siteId == "s1"); #expect(sent[0].initiativeId == "i1")
        #expect(sent[0].serial.hasPrefix("kiosk-ios-"))
        #expect(UUID(uuidString: sent[0].clientScanId) != nil)
        #expect(sent[0].clientScanId == sent[0].clientScanId.lowercased())
        #expect(sent[0].clientScanId != sent[1].clientScanId)
        #expect(vm.enrollments.count == 2)
        #expect(vm.enrollments[0].replaced)
    }

    @Test func noRosterOrNoSetupSaysSoInsteadOfDroppingTheScan() async throws {
        let vm = try await build([])
        await vm.onScan("A-1")
        #expect(vm.error == "No move data on this kiosk. Sync from Kiosk Setup.")
        #expect(vm.asset == nil)
    }

    /// The re-check inside the send: a roster rebuilt after step two began hands the tag to another asset.
    @Test func aTagTakenByAnAssetAddedToTheRosterMidEnrollIsRefusedBeforeThePost() async throws {
        let vm = try await build()
        await vm.onScan("A-1")
        try await store.replaceRoster(assets: [rack, KioskAssetRow(id: "a3", assetId: "A-3", name: "Late", rfid: "000000000000000000100360", serialNumber: "SN3", makeModel: "X")],
                                      people: [], containers: [], trucks: [],
                                      meta: SyncMeta(initiativeId: "i1", initiativeName: "Move", assets: 2, people: 0, containers: 0, trucks: 0, syncedAt: "now"))
        await vm.loadRoster()
        await vm.submitTag("100360")
        #expect(vm.error == "That tag is on Late. Scan a different tag.")
        #expect(api.calls.filter { $0 == "rfid" }.isEmpty)
    }

    /// Holds the fake's POST open until `release()`.
    private final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var cont: CheckedContinuation<Void, Never>?
        private var released = false
        func wait() async {
            await withCheckedContinuation { c in
                lock.lock()
                if released { lock.unlock(); c.resume() } else { cont = c; lock.unlock() }
            }
        }
        func release() { lock.lock(); released = true; let c = cont; cont = nil; lock.unlock(); c?.resume() }
    }

    /// A scan that arrives while the save is in flight is dropped (Android's saving guard), not queued behind it.
    @Test func aScanArrivingMidSaveIsDropped() async throws {
        let gate = Gate()
        api.rfidGate = { await gate.wait() }
        let vm = try await build()
        await vm.onScan("A-1")
        vm.scan("100349")
        for _ in 0..<100 where api.calls.filter({ $0 == "rfid" }).isEmpty { await Task.yield() }
        #expect(vm.saving)
        vm.scan("100349")                                          // the double-read
        vm.scan("A-1")
        gate.release()
        await vm.onScan("")                                        // wait for the send to finish
        for _ in 0..<100 where vm.saving { await Task.yield() }
        #expect(api.calls.filter { $0 == "rfid" }.count == 1)
        #expect(vm.error == nil)
        #expect(vm.enrollments.count == 1)
    }

    /// Once the save completes the screen is at step one, ready for the next asset.
    @Test func afterTheSaveTheScreenIsReadyForTheNextAsset() async throws {
        let gate = Gate()
        api.rfidGate = { await gate.wait() }
        let vm = try await build()
        await vm.onScan("A-1")
        vm.scan("100349")
        for _ in 0..<100 where api.calls.filter({ $0 == "rfid" }).isEmpty { await Task.yield() }
        gate.release()
        for _ in 0..<200 where vm.saving || vm.asset != nil { await Task.yield() }
        #expect(vm.asset == nil); #expect(!vm.saving)
        await vm.onScan("SN2")
        #expect(vm.asset?.id == "a2")
    }

    @Test func cancelReturnsToStepOne() async throws {
        let vm = try await build()
        await vm.onScan("A-2"); vm.cancel()
        #expect(vm.asset == nil); #expect(!vm.awaitingUpdate); #expect(vm.currentTag == nil)
    }
}
