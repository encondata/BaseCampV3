import Foundation
import Observation

/// "+ New" (spec §2, §3.6, §3.7, §3.16, §4.2): the details (Step 1 of 2), the duplicate check on
/// Next, the photo step (camera or library, with "Continue without photo" behind a
/// confirmation), "Position your photo", then Create worker. The worker is created first, then
/// the photo uploads; either way their page opens. If the upload fails the page says "Marcus Reed
/// was saved, but the photo didn't upload." with Try again (`RolodexPhotoFlow`).
///
/// One for the app's lifetime (`RolodexModel.newWorker`): its state lives here, never in the
/// full-screen cover's views, so a rebuild or a rotation keeps what the admin typed. Network
/// calls and the JPEG render run off the main actor.
@MainActor @Observable
final class RolodexNewWorkerFlow {
    enum Stage: Equatable, Sendable { case details, photo, crop }

    /// The flow is up (the full-screen cover).
    private(set) var active = false
    private(set) var stage: Stage = .details
    /// The details as typed (status isn't shown or sent: a new worker starts Active).
    var form = RolodexEdit()
    /// The duplicate check is under way.
    private(set) var checking = false
    /// Create worker (and the photo upload after it) is under way.
    private(set) var creating = false
    /// A capture or library pick is being decoded.
    private(set) var loadingPhoto = false
    /// What went wrong, in the spec's words.
    private(set) var errorText: String?
    /// The people the new worker may already be.
    private(set) var matches: [RolodexMatch] = []
    /// The "Possible duplicate" sheet is up.
    private(set) var showMatches = false
    /// The admin chose Create anyway.
    private(set) var allowDuplicate = false
    /// "Create Marcus Reed without a photo?" is up.
    var confirmNoPhoto = false
    /// The photo library is up.
    var library = false
    /// Flip; the photo step starts on the back camera.
    var frontCamera = false
    private(set) var crop: RolodexCrop?

    @ObservationIgnored weak var host: RolodexModel?
    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let photo: RolodexPhotoFlow
    /// Bumped by `reset()` (Cancel, a sign-out): work started before it is dropped.
    @ObservationIgnored private var generation = 0
    /// The worker to show once the cover is gone (created, or a match's Open).
    @ObservationIgnored private var opened: String?
    /// A create the server refused as a possible duplicate: Create anyway sends it again.
    @ObservationIgnored private var refused: (photo: Data?, photoSkipped: Bool)?
    /// "Continue without photo" was tapped and the confirmation hasn't been answered with Take
    /// photo. Kept apart from `confirmNoPhoto`, which the alert clears as it closes, before its
    /// button's work runs.
    @ObservationIgnored private var skipAsked = false

    init(api: KioskApi, photo: RolodexPhotoFlow) {
        self.api = api
        self.photo = photo
    }

    /// Something is under way; the buttons wait.
    var busy: Bool { checking || creating || loadingPhoto }

    // MARK: copy

    /// The name the worker will show: preferred (else first) name and last name.
    var workerName: String {
        [RolodexLogic.clean(form.preferredName) ?? RolodexLogic.clean(form.firstName), RolodexLogic.clean(form.lastName)]
            .compactMap { $0 }
            .joined(separator: " ")
    }

    var confirmTitle: String { "Create \(workerName) without a photo?" }
    static let confirmMessage = "Every worker should have a photo. You can add one later from their page, and the Rolodex lists who is missing one."

    /// Who already has the typed email (it can't be reused).
    var emailOwner: String? { matches.first { $0.matchedOn.contains("email") }?.displayName }

    /// Why Create anyway is off.
    var blockText: String? { emailOwner.map { "That email belongs to \($0). Change or clear the email." } }

    /// A name or phone match can be created anyway; an email match can't.
    var canCreateAnyway: Bool { emailOwner == nil }

    /// Worker matches open their page; anyone else is managed in the portal.
    static func canOpen(_ match: RolodexMatch) -> Bool { match.isWorker }

    static func note(for match: RolodexMatch) -> String? {
        match.isWorker ? nil : "Already in the portal, not a worker. Add the worker role there."
    }

    // MARK: open and close

    /// "+ New": an empty form.
    func start() {
        reset()
        active = true
    }

    /// Cancel: the form is dropped. Not while the worker is being created.
    func cancel() {
        guard !creating else { return }
        reset()
    }

    /// The worker to open once the cover is gone, once.
    func takeOpened() -> String? {
        defer { opened = nil }
        return opened
    }

    // MARK: details and duplicates

    /// Next: photo. Checks the form, then whether the worker may already exist: matches show the
    /// "Possible duplicate" sheet; none goes on to the photo (or back to the photo already taken).
    func next() async {
        guard active, stage == .details, !busy else { return }
        if let problem = RolodexLogic.validate(form) {
            errorText = problem
            return
        }
        guard await checkDuplicates(), matches.isEmpty else { return }
        advance()
    }

    /// Asks the server who the new worker may already be (names, email and phone in the body).
    /// Matches show the sheet. False when the check didn't answer (the error says why).
    @discardableResult
    func checkDuplicates() async -> Bool {
        guard !checking else { return false }
        checking = true
        errorText = nil
        allowDuplicate = false
        matches = []
        showMatches = false
        let mine = generation
        let body = RolodexDuplicatesIn(firstName: RolodexLogic.clean(form.firstName) ?? "", lastName: RolodexLogic.clean(form.lastName) ?? "",
                                       preferredName: RolodexLogic.clean(form.preferredName), email: RolodexLogic.clean(form.email),
                                       phone: RolodexLogic.clean(form.phone))
        do {
            let found = try await Self.fetchDuplicates(api, body)
            guard mine == generation else { return false }
            checking = false
            matches = found
            showMatches = !found.isEmpty
            return true
        } catch {
            guard mine == generation else { return false }
            checking = false
            if !(error is CancellationError) { errorText = RolodexModel.errorText(for: error) }
            return false
        }
    }

    /// Create anyway (not for an email match). After a refused create, it sends that create again.
    func createAnyway() async {
        guard showMatches, canCreateAnyway, !busy else { return }
        allowDuplicate = true
        showMatches = false
        if let refused {
            self.refused = nil
            creating = true
            await send(photo: refused.photo, photoSkipped: refused.photoSkipped)
        } else {
            advance()
        }
    }

    /// The sheet's Back (or a swipe down). An email match goes back to the details to change it.
    func dismissMatches() {
        guard showMatches else { return }
        showMatches = false
        refused = nil
        if let block = blockText {
            stage = .details
            errorText = block
        }
    }

    /// Open on a worker match: that worker's page instead of a new one. The form is dropped.
    func openMatch(_ match: RolodexMatch) async {
        guard showMatches, Self.canOpen(match), !busy else { return }
        let host = self.host
        reset()
        opened = match.personId
        await host?.select(match.personId)
    }

    private func advance() {
        errorText = nil
        stage = crop == nil ? .photo : .crop
    }

    /// "‹ Details" from the photo steps; a photo already positioned is kept.
    func backToDetails() {
        guard !creating else { return }
        confirmNoPhoto = false
        errorText = nil
        stage = .details
    }

    // MARK: the photo

    /// A capture or a library pick: decoded for "Position your photo". A file that isn't a picture
    /// stays on the photo step and says so.
    func use(_ data: Data) async { await use { data } }

    /// `use(_:)` for a library pick, whose bytes arrive later (`PhotosPickerItem`).
    func use(loading: @escaping @Sendable () async throws -> Data?) async {
        guard active, stage == .photo, !busy else { return }
        library = false
        errorText = nil
        loadingPhoto = true
        let mine = generation
        let data = try? await loading()
        let made: RolodexCrop? = if let data { await RolodexCrop.make(from: data) } else { nil }
        guard mine == generation else { return }
        loadingPhoto = false
        guard let made else {
            errorText = RolodexPhotoFlow.unusableText
            return
        }
        crop = made
        stage = .crop
    }

    /// Retake: back to the camera (or Choose photo).
    func retake() {
        guard !creating else { return }
        crop = nil
        errorText = nil
        stage = .photo
    }

    /// The quiet "Continue without photo" link: asks first.
    func continueWithoutPhoto() {
        guard stage == .photo, !busy else { return }
        skipAsked = true
        confirmNoPhoto = true
    }

    /// The confirmation's default: back to the camera.
    func takePhotoInstead() {
        skipAsked = false
        confirmNoPhoto = false
    }

    // MARK: Create worker

    /// "Create without photo" in the confirmation: the create says `photo_skipped` (only ever
    /// after that confirmation).
    func createWithoutPhoto() async {
        guard skipAsked else { return }
        skipAsked = false
        confirmNoPhoto = false
        guard active, !busy else { return }
        creating = true
        await send(photo: nil, photoSkipped: true)
    }

    /// Create worker on "Position your photo": the photo as the 512×512 JPEG.
    func createWithPhoto() async {
        guard active, !busy, let crop else { return }
        creating = true
        errorText = nil
        let mine = generation
        let jpeg = await crop.jpeg()
        guard mine == generation else { return }
        await send(photo: jpeg, photoSkipped: false)
    }

    /// Creates the worker from the form with `photo` (nil without one). One create at a time: a
    /// second tap while one is under way sends nothing.
    func create(photo: Data?, photoSkipped: Bool, allowDuplicate: Bool) async {
        guard active, !busy else { return }
        self.allowDuplicate = allowDuplicate
        creating = true
        await send(photo: photo, photoSkipped: photoSkipped)
    }

    /// The create, then the photo, then the worker's page. `creating` is already set. A failure
    /// keeps the form and the photo; a possible duplicate runs the check again for the sheet.
    private func send(photo jpeg: Data?, photoSkipped: Bool) async {
        errorText = nil
        let mine = generation
        let body = RolodexCreateIn(form, allowDuplicate: allowDuplicate, photoSkipped: photoSkipped)
        let created: RolodexDetail
        do {
            created = try await Self.sendCreate(api, body)
        } catch {
            guard mine == generation else { return }
            creating = false
            if (error as? ApiError)?.code == "possible_duplicate" {
                // Someone like them was added since Next: show who, as Next does.
                refused = (jpeg, photoSkipped)
                if await checkDuplicates(), matches.isEmpty { errorText = RolodexModel.errorText(code: nil) }
                return
            }
            if !(error is CancellationError) { errorText = RolodexModel.errorText(for: error) }
            return
        }
        guard mine == generation, let host else { return }
        // The page, the list, the Time Clock's roster and the offline copy have them now.
        await host.open(created)
        if let jpeg {
            do {
                try await photo.uploadPhoto(personId: created.personId, jpeg: jpeg)
            } catch {
                if mine == generation { photo.recordFailure(personId: created.personId, name: rolodexName(created.row), jpeg: jpeg) }
            }
        }
        guard mine == generation else { return }
        reset()
        opened = created.personId
    }

    // MARK: sign-out

    /// Cancel, a sign-out, a session end or Reset app: closes the flow and forgets the form.
    func reset() {
        generation += 1
        active = false
        stage = .details
        form = RolodexEdit()
        checking = false
        creating = false
        loadingPhoto = false
        errorText = nil
        matches = []
        showMatches = false
        allowDuplicate = false
        confirmNoPhoto = false
        library = false
        frontCamera = false
        crop = nil
        opened = nil
        refused = nil
        skipAsked = false
    }

    // MARK: off the main actor

    @concurrent nonisolated private static func fetchDuplicates(_ api: KioskApi, _ body: RolodexDuplicatesIn) async throws -> [RolodexMatch] {
        try await api.rolodexDuplicates(body)
    }

    @concurrent nonisolated private static func sendCreate(_ api: KioskApi, _ body: RolodexCreateIn) async throws -> RolodexDetail {
        try await api.rolodexCreate(body)
    }
}
