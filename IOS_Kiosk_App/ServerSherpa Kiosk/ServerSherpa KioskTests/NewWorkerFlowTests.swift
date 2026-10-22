import Foundation
import Testing
@testable import ServerSherpa_Kiosk

private let NW_ANA = RolodexRow(personId: "p-ana", firstName: "Ana", lastName: "Ortiz", displayName: "Ana Ortiz", jobTitle: "Rigger",
                                status: "active", statusLabel: "Active", hasPhoto: true, photoUrl: "https://s3.test/ana.jpg", photoVersion: "v1")
private let NW_MARCUS = RolodexRow(personId: "p-marcus", firstName: "Marcus", lastName: "Reed", displayName: "Marcus Reed", jobTitle: "Mover",
                                   status: "active", statusLabel: "Active")
/// The create's answer: Marcus's page, no photo yet.
private func nwMarcus() -> RolodexDetail {
    RolodexDetail(row: NW_MARCUS, email: "marcus@example.com", phone: "(312) 555-0199", canEdit: true, canChangeStatus: true)
}
private let WORKER_MATCH = RolodexMatch(personId: "p-ana", displayName: "Ana Ortiz", jobTitle: "Rigger", company: "Summit Crew",
                                        isWorker: true, photoVersion: "v1", matchedOn: ["name"])
private let STAFF_MATCH = RolodexMatch(personId: "p-sam", displayName: "Marcus Reed", jobTitle: "Dispatcher", isWorker: false,
                                       hasAccount: true, matchedOn: ["name", "phone"])
private let EMAIL_MATCH = RolodexMatch(personId: "p-mr", displayName: "Marc Reedy", isWorker: true, matchedOn: ["email"])

/// The New worker flow (plan Task 10; Android NewWorkerFlowTest): details, the duplicate check,
/// the photo step and its "Continue without photo" confirmation, Create worker (Review Focus 3)
/// and a photo upload that fails after the create (Review Focus 5).
@MainActor @Suite(.timeLimit(.minutes(1)))
struct NewWorkerFlowTests {
    private let api = FakeKioskApi()
    private let store: KioskStore
    private let owner = RolodexModel.Owner(personId: "admin1", apiUrl: "https://api.test")

    init() throws {
        store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        api.rolodexWorkersResult = { RolodexList(generatedAt: "now", workers: [NW_ANA]) }
        api.rolodexCreateResult = { _ in nwMarcus() }
        api.rolodexPhotoResult = { id, _ in RolodexPhotoOut(photoUrl: "https://s3.test/\(id)-2.jpg", photoVersion: "nv1") }
    }

    private func loaded() async -> RolodexModel {
        let who = owner
        let m = RolodexModel(api: api, store: store, owner: { who })
        await m.load()
        return m
    }

    /// The flow open, with Marcus Reed's details typed.
    private func typed(_ m: RolodexModel) -> RolodexNewWorkerFlow {
        m.startNewWorker()
        let f = m.newWorker
        f.form.firstName = " Marcus "
        f.form.lastName = "Reed"
        f.form.jobTitle = "Mover"
        f.form.phone = "(312) 555-0199"
        f.form.email = "marcus@example.com"
        return f
    }

    /// Past the details (no duplicates): the photo step.
    private func onPhotoStep(_ m: RolodexModel) async -> RolodexNewWorkerFlow {
        let f = typed(m)
        await f.next()
        return f
    }

    /// On "Position your photo" with a picture.
    private func onCropStep(_ m: RolodexModel) async -> RolodexNewWorkerFlow {
        let f = await onPhotoStep(m)
        await f.use(photoTestJpeg())
        return f
    }

    // MARK: starting

    @Test func onlyAnAdminOnlineWithTheListCanStartANewWorker() async throws {
        let nobody = RolodexModel(api: api, store: store, owner: { nil })
        #expect(!nobody.canStartNewWorker)
        nobody.startNewWorker()
        #expect(!nobody.newWorker.active)

        let m = await loaded()
        #expect(m.canStartNewWorker)
        m.startNewWorker()
        #expect(m.newWorker.active && m.newWorker.stage == .details && m.newWorker.form == RolodexEdit())

        api.rolodexWorkersResult = { throw ApiError.network() }
        let offline = await loaded()
        #expect(offline.offline && !offline.canStartNewWorker)
    }

    // MARK: details and duplicates

    @Test func nextChecksForDuplicatesThenOpensThePhotoStep() async throws {
        let m = await loaded()
        let f = typed(m)
        await f.next()
        #expect(api.rolodexDuplicateBodies == [RolodexDuplicatesIn(firstName: "Marcus", lastName: "Reed",
                                                                   email: "marcus@example.com", phone: "(312) 555-0199")])
        #expect(f.stage == .photo && !f.showMatches && !f.allowDuplicate && f.errorText == nil)
        #expect(api.rolodexCreateBodies.isEmpty)
    }

    @Test func nextChecksTheFormFirst() async throws {
        let m = await loaded()
        let f = typed(m)
        f.form.lastName = "  "
        await f.next()
        #expect(f.errorText == "First and last name are required.")
        f.form.lastName = "Reed"
        f.form.email = "marcus@example"
        await f.next()
        #expect(f.errorText == "Enter a valid email address.")
        #expect(f.stage == .details && api.rolodexDuplicateBodies.isEmpty)
    }

    @Test func aFailedCheckStaysOnTheDetailsAsTyped() async throws {
        let m = await loaded()
        let f = typed(m)
        let form = f.form
        api.rolodexDuplicatesResult = { _ in throw ApiError.network() }
        await f.next()
        #expect(f.stage == .details && !f.checking && f.form == form)
        #expect(f.errorText == "No connection. Try again when you're back online.")
    }

    @Test func aWorkerMatchOffersOpenAndCreateAnyway() async throws {
        let m = await loaded()
        api.rolodexDuplicatesResult = { _ in [WORKER_MATCH] }
        let f = typed(m)
        await f.next()
        #expect(f.showMatches && f.matches == [WORKER_MATCH] && f.stage == .details)
        #expect(RolodexNewWorkerFlow.canOpen(WORKER_MATCH))
        #expect(RolodexNewWorkerFlow.note(for: WORKER_MATCH) == nil)
        #expect(f.canCreateAnyway && f.blockText == nil)

        await f.createAnyway()
        #expect(!f.showMatches && f.allowDuplicate && f.stage == .photo)
        // without the confirmation, nothing is created without a photo
        await f.createWithoutPhoto()
        #expect(api.rolodexCreateBodies.isEmpty)
        f.continueWithoutPhoto()
        await f.createWithoutPhoto()
        #expect(api.rolodexCreateBodies.map(\.allowDuplicate) == [true])
    }

    @Test func openGoesToTheWorkerInsteadOfCreatingAnother() async throws {
        let m = await loaded()
        api.rolodexDuplicatesResult = { _ in [WORKER_MATCH] }
        api.rolodexWorkerResult = { _ in RolodexDetail(row: NW_ANA, canEdit: true) }
        let f = typed(m)
        await f.next()
        await f.openMatch(WORKER_MATCH)
        #expect(!f.active && f.takeOpened() == "p-ana" && f.takeOpened() == nil)
        #expect(m.selectedId == "p-ana" && m.detail?.personId == "p-ana")
        #expect(api.rolodexCreateBodies.isEmpty)
        #expect(f.form == RolodexEdit())
    }

    @Test func aMatchThatIsNotAWorkerHasNoOpen() async throws {
        let m = await loaded()
        api.rolodexDuplicatesResult = { _ in [STAFF_MATCH] }
        let f = typed(m)
        await f.next()
        #expect(f.showMatches)
        #expect(RolodexNewWorkerFlow.note(for: STAFF_MATCH) == "Already in the portal, not a worker. Add the worker role there.")
        #expect(!RolodexNewWorkerFlow.canOpen(STAFF_MATCH))
        await f.openMatch(STAFF_MATCH)
        #expect(f.active && f.showMatches && m.selectedId == nil)
        // a name or phone match can still be created anyway
        #expect(f.canCreateAnyway)
    }

    @Test func anEmailMatchBlocksCreateAnyway() async throws {
        let m = await loaded()
        api.rolodexDuplicatesResult = { _ in [STAFF_MATCH, EMAIL_MATCH] }
        let f = typed(m)
        await f.next()
        #expect(f.blockText == "That email belongs to Marc Reedy. Change or clear the email.")
        #expect(!f.canCreateAnyway)
        await f.createAnyway()
        #expect(f.showMatches && !f.allowDuplicate && f.stage == .details)
        f.dismissMatches()
        #expect(!f.showMatches && f.stage == .details)

        // with the email cleared, Next checks again and goes on
        f.form.email = ""
        api.rolodexDuplicatesResult = { _ in [] }
        await f.next()
        #expect(f.stage == .photo && api.rolodexDuplicateBodies.last?.email == nil)
    }

    // MARK: the photo step

    @Test func continueWithoutPhotoAsksFirstThenCreatesWithPhotoSkipped() async throws {
        let m = await loaded()
        let f = await onPhotoStep(m)
        f.continueWithoutPhoto()
        #expect(f.confirmNoPhoto)
        #expect(f.confirmTitle == "Create Marcus Reed without a photo?")
        // the default choice goes back to the camera
        f.takePhotoInstead()
        #expect(!f.confirmNoPhoto && f.stage == .photo && f.active)
        #expect(api.rolodexCreateBodies.isEmpty)

        f.continueWithoutPhoto()
        f.confirmNoPhoto = false   // the alert closes itself before its button's work runs
        await f.createWithoutPhoto()
        #expect(api.rolodexCreateBodies == [RolodexCreateIn(firstName: "Marcus", lastName: "Reed", jobTitle: "Mover", phone: "(312) 555-0199",
                                                            email: "marcus@example.com", allowDuplicate: false, photoSkipped: true)])
        #expect(api.rolodexPhotos.isEmpty)
        #expect(!f.active && !f.confirmNoPhoto && f.takeOpened() == "p-marcus")
        #expect(m.selectedId == "p-marcus" && m.detail == nwMarcus())
        #expect(m.photo.failureText(for: "p-marcus") == nil)
    }

    @Test func aPictureThatIsNotAnImageStaysOnThePhotoStep() async throws {
        let m = await loaded()
        let f = await onPhotoStep(m)
        await f.use(Data("not a photo".utf8))
        #expect(f.stage == .photo && f.crop == nil && !f.loadingPhoto)
        #expect(f.errorText == "That photo couldn't be used. Take or choose another one.")
    }

    @Test func retakeAndBackKeepTheDetails() async throws {
        let m = await loaded()
        let f = await onCropStep(m)
        #expect(f.stage == .crop && f.crop != nil)
        f.retake()
        #expect(f.stage == .photo && f.crop == nil)
        await f.use(photoTestJpeg())
        // back to the details (to fix a typo) keeps the photo: Next comes straight back to it
        f.backToDetails()
        #expect(f.stage == .details && f.crop != nil && f.form.lastName == "Reed")
        await f.next()
        #expect(f.stage == .crop)
    }

    // MARK: Create worker

    @Test func aCreateWithAPhotoUploadsItAndOpensTheWorker() async throws {
        let m = await loaded()
        let f = await onCropStep(m)
        await f.createWithPhoto()
        #expect(api.rolodexCreateBodies.map(\.photoSkipped) == [false])
        let upload = try #require(api.rolodexPhotos.first)
        #expect(api.rolodexPhotos.count == 1 && upload.id == "p-marcus")
        let pixels = try PhotoTestPixels(upload.jpeg)
        #expect(pixels.width == 512 && pixels.height == 512)

        #expect(!f.active && !f.creating && f.takeOpened() == "p-marcus")
        #expect(m.selectedId == "p-marcus")
        #expect(m.detail?.photoVersion == "nv1" && m.detail?.hasPhoto == true)
        let row = try #require(m.rows.first { $0.personId == "p-marcus" })
        #expect(row.photoVersion == "nv1" && row.hasPhoto)
        #expect(m.rows.map(\.personId) == ["p-ana", "p-marcus"])   // Ortiz, Reed
        // the Time Clock finds them right away
        let person = try #require(try await store.people().first { $0.id == "p-marcus" })
        #expect(person.isWorker && person.displayName == "Marcus Reed")
        // network, render and upload ran off the main thread
        #expect(api.mainThreadCalls.isEmpty)
    }

    /// Review Focus 3: a double tap on Create worker sends one POST.
    @Test func aDoubleTapOnCreateWorkerSendsOnePost() async throws {
        let m = await loaded()
        let f = await onCropStep(m)
        // Holds the first create only: a second one, if it were sent, would finish and be counted.
        let hold = HoldGate()
        api.rolodexGate = { [api] name in if name == "rolodexCreate", api.rolodexCreateBodies.count == 1 { await hold.wait() } }
        let first = Task { await f.createWithPhoto() }
        #expect(await waitUntil { f.creating && api.rolodexCreateBodies.count == 1 })
        await f.createWithPhoto()
        await f.create(photo: photoTestJpeg(), photoSkipped: false, allowDuplicate: false)
        await f.createWithoutPhoto()
        #expect(api.rolodexCreateBodies.count == 1)
        await hold.open()
        await first.value
        #expect(api.rolodexCreateBodies.count == 1 && api.rolodexPhotos.count == 1)
        #expect(m.selectedId == "p-marcus")
    }

    /// Review Focus 5: the worker is saved; the photo upload fails; their page opens saying so,
    /// with Try again, which uploads the same photo again.
    @Test func aPhotoUploadFailingAfterTheCreateOpensTheWorkerWithTryAgain() async throws {
        let m = await loaded()
        let f = await onCropStep(m)
        api.rolodexPhotoResult = { _, _ in throw ApiError.network() }
        await f.createWithPhoto()
        #expect(!f.active && f.takeOpened() == "p-marcus")
        #expect(m.selectedId == "p-marcus" && m.detail == nwMarcus())
        #expect(m.photo.failureText(for: "p-marcus") == "Marcus Reed was saved, but the photo didn't upload.")
        #expect(m.photo.failureText(for: "p-ana") == nil)
        let sent = try #require(api.rolodexPhotos.first?.jpeg)

        // still failing: the message stays, with the reason
        await m.photo.retry("p-marcus")
        #expect(m.photo.failureText(for: "p-marcus") != nil)
        #expect(m.photo.retryErrorText(for: "p-marcus") == "No connection. Try again when you're back online.")

        api.rolodexPhotoResult = { id, _ in RolodexPhotoOut(photoUrl: "https://s3.test/\(id)-2.jpg", photoVersion: "nv1") }
        await m.photo.retry("p-marcus")
        #expect(api.rolodexPhotos.count == 3 && api.rolodexPhotos.allSatisfy { $0.id == "p-marcus" && $0.jpeg == sent })
        #expect(m.photo.failureText(for: "p-marcus") == nil)
        #expect(m.detail?.photoVersion == "nv1")
        #expect(m.rows.first { $0.personId == "p-marcus" }?.photoVersion == "nv1")
    }

    @Test func aPossibleDuplicateOnCreateRunsTheCheckAgain() async throws {
        let m = await loaded()
        let f = await onPhotoStep(m)
        // someone else added Marcus between Next and Create
        api.rolodexDuplicatesResult = { _ in [WORKER_MATCH] }
        api.rolodexCreateResult = { body in
            guard body.allowDuplicate else { throw ApiError(status: 409, code: "possible_duplicate") }
            return nwMarcus()
        }
        f.continueWithoutPhoto()
        await f.createWithoutPhoto()
        #expect(api.rolodexDuplicateBodies.count == 2)
        #expect(f.showMatches && f.matches == [WORKER_MATCH] && f.active && !f.creating)

        await f.createAnyway()
        #expect(api.rolodexCreateBodies.map(\.allowDuplicate) == [false, true])
        #expect(api.rolodexCreateBodies.map(\.photoSkipped) == [true, true])
        #expect(!f.active && m.selectedId == "p-marcus")
    }

    @Test(arguments: zip(
        [ApiError(status: 423, code: "read_only_mode"), ApiError(status: 409, code: "email_in_use"), ApiError.network()],
        ["The system is in read-only mode, so changes can't be saved right now.",
         "Another person already uses that email.",
         "No connection. Try again when you're back online."]))
    func aFailedCreateKeepsTheFormAndThePhoto(_ failure: ApiError, _ copy: String) async throws {
        let m = await loaded()
        let f = await onCropStep(m)
        let form = f.form
        api.rolodexCreateResult = { _ in throw failure }
        await f.createWithPhoto()
        #expect(f.errorText == copy)
        #expect(f.active && !f.creating && f.stage == .crop && f.crop != nil && f.form == form)
        #expect(api.rolodexPhotos.isEmpty && m.selectedId == nil)
    }

    @Test func signingOutClosesTheFlowAndDropsALateCreate() async throws {
        let m = await loaded()
        let f = await onCropStep(m)
        let hold = HoldGate()
        api.rolodexGate = { name in if name == "rolodexCreate" { await hold.wait() } }
        let creating = Task { await f.createWithPhoto() }
        #expect(await waitUntil { f.creating && api.rolodexCreateBodies.count == 1 })
        await m.clear().value
        #expect(!f.active && f.form == RolodexEdit() && f.crop == nil)
        await hold.open()
        await creating.value
        #expect(m.selectedId == nil && m.rows.isEmpty && api.rolodexPhotos.isEmpty)
        #expect(try await store.people().isEmpty)
        #expect(try await store.rolodexCache() == nil)
        #expect(f.takeOpened() == nil)
    }
}

/// A new photo from the worker page's camera badge (plan Task 10; Android RolodexViewModelTest).
@MainActor @Suite(.timeLimit(.minutes(1)))
struct RolodexPhotoFlowTests {
    private let api = FakeKioskApi()
    private let store: KioskStore
    /// Its own photo cache: other suites' sign-outs empty the shared one.
    private let photos = RolodexPhotoCache()

    init() throws {
        store = KioskStore(modelContainer: try KioskSchema.inMemoryContainer())
        api.rolodexWorkersResult = { RolodexList(generatedAt: "now", workers: [NW_ANA, NW_MARCUS]) }
        api.rolodexWorkerResult = { id in
            RolodexDetail(row: id == NW_ANA.personId ? NW_ANA : NW_MARCUS, email: "a@example.com", canEdit: true, canChangeStatus: true)
        }
        api.rolodexPhotoResult = { id, _ in RolodexPhotoOut(photoUrl: "https://s3.test/\(id)-2.jpg", photoVersion: "v2") }
    }

    /// Ana's page open.
    private func anaOpen() async -> RolodexModel {
        let m = RolodexModel(api: api, store: store, owner: { RolodexModel.Owner(personId: "admin1", apiUrl: "https://api.test") },
                             photoCache: photos)
        await m.load()
        await m.select(NW_ANA.personId)
        return m
    }

    @Test func takeNewPhotoOrChoosePhoto() async throws {
        let m = await anaOpen()
        m.startPhoto()
        #expect(m.photo.sheet && m.photo.target == RolodexPhotoFlow.Target(personId: "p-ana", name: "Ana Ortiz"))
        m.photo.takePhoto()
        #expect(!m.photo.sheet && m.photo.stage == .camera && !m.photo.frontCamera)
        m.photo.close()
        #expect(m.photo.stage == .none && m.photo.target == nil)

        m.startPhoto()
        m.photo.chooseFromLibrary()
        #expect(m.photo.library && m.photo.stage == .none)
        await m.photo.use(photoTestJpeg())
        #expect(m.photo.stage == .crop && m.photo.crop != nil)
    }

    @Test func aNewPhotoRefreshesTheRowsPhotoVersion() async throws {
        let m = await anaOpen()
        m.startPhoto()
        m.photo.takePhoto()
        await m.photo.use(photoTestJpeg(width: 1200, height: 900))
        await m.photo.usePhoto()
        let upload = try #require(api.rolodexPhotos.first)
        #expect(api.rolodexPhotos.count == 1 && upload.id == "p-ana")
        #expect(try PhotoTestPixels(upload.jpeg).width == 512)
        #expect(m.rows.first { $0.personId == "p-ana" }?.photoVersion == "v2")
        #expect(m.rows.first { $0.personId == "p-ana" }?.photoUrl == "https://s3.test/p-ana-2.jpg")
        #expect(m.detail?.photoVersion == "v2")
        #expect(m.photo.stage == .none && m.photo.crop == nil && m.photo.errorText == nil)
        // the offline copy has it too
        let text = try #require(try await store.rolodexCache())
        let cache = try KioskJSON.decoder.decode(RolodexCache.self, from: Data(text.utf8))
        #expect(cache.workers.first { $0.personId == "p-ana" }?.photoVersion == "v2")
        // the new photo shows at once, without fetching the new link
        #expect(photos.image(RolodexPhotoCache.key(personId: "p-ana", photoVersion: "v2", pixels: 160)) != nil)
        #expect(photos.image(RolodexPhotoCache.key(personId: "p-ana", photoVersion: "v2", pixels: 400)) != nil)
        #expect(api.mainThreadCalls.isEmpty)
    }

    @Test func noPhotoActionWhenTheWorkerCantBeEdited() async throws {
        api.rolodexWorkerResult = { _ in RolodexDetail(row: NW_ANA, canEdit: false, editBlockReason: "rank_too_low") }
        let m = await anaOpen()
        #expect(!m.canEdit)
        m.startPhoto()
        #expect(!m.photo.sheet && m.photo.target == nil)

        // nor offline
        api.rolodexWorkerResult = { _ in RolodexDetail(row: NW_ANA, canEdit: true) }
        api.rolodexWorkersResult = { throw ApiError.network() }
        let offline = await anaOpen()
        #expect(offline.offline)
        offline.startPhoto()
        #expect(!offline.photo.sheet)
    }

    @Test(arguments: zip(
        [ApiError(status: 413, code: "file_too_large"), ApiError(status: 422, code: "invalid_file_type"),
         ApiError(status: 403, code: "rank_too_low"), ApiError.network()],
        ["That photo couldn't be used. Take or choose another one.",
         "That photo couldn't be used. Take or choose another one.",
         "This person has a portal login ranked above yours.",
         "No connection. Try again when you're back online."]))
    func aRefusedPhotoKeepsTheCropAndSaysWhy(_ failure: ApiError, _ copy: String) async throws {
        let m = await anaOpen()
        m.startPhoto()
        m.photo.takePhoto()
        await m.photo.use(photoTestJpeg())
        api.rolodexPhotoResult = { _, _ in throw failure }
        await m.photo.usePhoto()
        #expect(m.photo.errorText == copy)
        #expect(m.photo.stage == .crop && m.photo.crop != nil && !m.photo.uploading)
        #expect(m.rows.first { $0.personId == "p-ana" }?.photoVersion == "v1")
    }

    @Test func aSecondUsePhotoWhileUploadingSendsOneRequest() async throws {
        let m = await anaOpen()
        m.startPhoto()
        m.photo.takePhoto()
        await m.photo.use(photoTestJpeg())
        // Holds the first upload only: a second one, if it were sent, would finish and be counted.
        let hold = HoldGate()
        api.rolodexGate = { [api] name in if name == "rolodexPhoto", api.rolodexPhotos.count == 1 { await hold.wait() } }
        let first = Task { await m.photo.usePhoto() }
        #expect(await waitUntil { m.photo.uploading && api.rolodexPhotos.count == 1 })
        await m.photo.usePhoto()
        #expect(api.rolodexPhotos.count == 1)
        await hold.open()
        await first.value
        #expect(api.rolodexPhotos.count == 1 && m.detail?.photoVersion == "v2")
    }

    @Test func aPictureThatIsNotAnImageIsRefused() async throws {
        let m = await anaOpen()
        m.startPhoto()
        m.photo.chooseFromLibrary()
        await m.photo.use(Data("not a photo".utf8))
        #expect(m.photo.crop == nil)
        #expect(m.photo.errorText == "That photo couldn't be used. Take or choose another one.")
        #expect(api.rolodexPhotos.isEmpty)
    }
}
