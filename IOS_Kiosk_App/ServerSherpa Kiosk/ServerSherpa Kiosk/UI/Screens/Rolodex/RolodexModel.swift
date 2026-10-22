import Foundation
import Observation

/// The Rolodex's offline copy of the last list (the `rolodex` meta row): rows only, which never
/// carry email or phone, with who loaded it, from which API, and when. Only the same admin on the
/// same API is ever shown it.
struct RolodexCache: Codable, Equatable, Sendable {
    var ownerId: String
    var apiUrl: String
    /// Seconds since 1970.
    var loadedAt: Double
    var workers: [RolodexRow]

    enum CodingKeys: String, CodingKey {
        case ownerId = "owner_id"
        case apiUrl = "api_url"
        case loadedAt = "loaded_at"
        case workers
    }
}

/// One letter of the list (`#` for names that don't start with A–Z).
struct RolodexSection: Identifiable, Equatable, Sendable {
    let letter: String
    let rows: [RolodexRow]

    var id: String { letter }
}

/// A filter chip: `all`, a status key or `no_photo`, with its count over the searched list.
struct RolodexFilterChip: Identifiable, Equatable, Sendable {
    let key: String
    let label: String
    let count: Int

    var id: String { key }
}

/// What a list row is searched, sorted and sectioned by, worked out once per row when the list
/// loads (a few hundred workers stay smooth to search: no folding per keystroke).
private struct RolodexIndexed: Sendable {
    let sortKey: (String, String, String)
    let words: [String]
    let letter: String

    init(_ row: RolodexRow) {
        sortKey = RolodexLogic.sortKey(row)
        words = RolodexLogic.searchWords(row)
        letter = RolodexLogic.sectionLetter(lastName: row.lastName)
    }
}

/// A list in `RolodexLogic.sortRows` order with its index.
private struct RolodexPrepared: Sendable {
    let rows: [RolodexRow]
    let index: [String: RolodexIndexed]

    init(_ workers: [RolodexRow]) {
        var index: [String: RolodexIndexed] = [:]
        for row in workers { index[row.personId] = RolodexIndexed(row) }
        self.index = index
        rows = Self.sorted(workers, index)
    }

    static func sorted(_ rows: [RolodexRow], _ index: [String: RolodexIndexed]) -> [RolodexRow] {
        rows.sorted { a, b in
            (index[a.personId]?.sortKey ?? RolodexLogic.sortKey(a)) < (index[b.personId]?.sortKey ?? RolodexLogic.sortKey(b))
        }
    }
}

extension KioskPersonRow {
    /// A Rolodex worker as the roster (the Time Clock's offline people) holds them. No RFID tag or
    /// badge: the store keeps the ones the person already has.
    init(rolodex worker: RolodexDetail) {
        self.init(id: worker.personId, displayName: worker.displayName.isEmpty ? rolodexName(worker.row) : worker.displayName,
                  firstName: worker.firstName, lastName: worker.lastName, preferredName: worker.preferredName,
                  jobTitle: worker.jobTitle, externalId: worker.externalId, isWorker: true, hasAccount: worker.hasAccount)
    }
}

/// The Rolodex (spec §4.2, §4.4): every worker the admin can see, A–Z by last name, searched and
/// filtered here; the selected worker's page; Edit and Save. One for the app's lifetime (the
/// container owns it), so the list and a phone's pushed worker page share it. With no
/// connection it shows the last list this admin loaded on this kiosk, read-only.
///
/// Network calls, decoding and the list's indexing run off the main actor (`@concurrent`).
/// Photos and the New worker flow keep their state in `photo` and `newWorker` (their own files).
@MainActor @Observable
final class RolodexModel {
    /// Whose list it is: the signed-in admin and the API they signed in to.
    struct Owner: Equatable, Sendable {
        var personId: String
        var apiUrl: String
    }

    // MARK: the list

    /// Every worker, by last name, then first name.
    private(set) var rows: [RolodexRow] = []
    var query = "" { didSet { if query != oldValue { recompute() } } }
    /// `RolodexLogic.filterAll`, a status key or `RolodexLogic.filterNoPhoto`.
    var filter = RolodexLogic.filterAll { didSet { if filter != oldValue { recompute() } } }
    /// The rows the search and filter leave, by letter.
    private(set) var sections: [RolodexSection] = []
    /// Per filter chip, over the searched list.
    private(set) var counts: [String: Int] = [:]
    private(set) var loading = false
    /// A list is showing (fresh or the offline copy).
    private(set) var loaded = false
    /// Why there's no list (a refused account, no connection and no copy, a server error).
    private(set) var listError: String?
    /// The list is the offline copy: read-only.
    private(set) var offline = false
    /// When the offline copy was loaded; nil while the list is fresh.
    private(set) var cachedAt: Date?
    /// Levels, statuses and companies for the Edit form (empty until `/options` answers).
    private(set) var options = RolodexOptions()

    // MARK: the worker page

    private(set) var selectedId: String?
    /// The selected worker's page (with contact details); nil until it loads.
    private(set) var detail: RolodexDetail?
    private(set) var detailLoading = false
    /// Why the page's details didn't load.
    private(set) var detailError: String?
    /// The Edit form, as typed; nil when not editing.
    var editing: RolodexEdit?
    private(set) var saving = false
    /// What went wrong with the last save, in the spec's words.
    private(set) var errorText: String?

    /// The camera badge's new photo, and new workers' photos that didn't upload.
    let photo: RolodexPhotoFlow
    /// "+ New".
    let newWorker: RolodexNewWorkerFlow

    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let store: KioskStore
    @ObservationIgnored private let owner: @MainActor () -> Owner?
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let photoCache: RolodexPhotoCache
    @ObservationIgnored private var index: [String: RolodexIndexed] = [:]
    /// When the list on screen came from the server (the offline copy's own time).
    @ObservationIgnored private var listTime: Date?
    /// Bumped by `clear()`: work started before it is dropped.
    @ObservationIgnored private var generation = 0
    /// Bumped per page load: a late answer for another worker is dropped.
    @ObservationIgnored private var detailToken = 0

    /// `owner` is nil while nobody (or no admin) is signed in: nothing loads.
    init(api: KioskApi, store: KioskStore, owner: @escaping @MainActor () -> Owner?, now: @escaping () -> Date = Date.init,
         photoCache: RolodexPhotoCache = .shared) {
        self.api = api
        self.store = store
        self.owner = owner
        self.now = now
        self.photoCache = photoCache
        let photo = RolodexPhotoFlow(api: api, cache: photoCache)
        self.photo = photo
        newWorker = RolodexNewWorkerFlow(api: api, photo: photo)
        photo.host = self
        newWorker.host = self
    }

    // MARK: loading

    /// The list and the Edit form's options from the server. With no connection (or a server
    /// error) it falls back to this admin's offline copy, then to the list already showing.
    func load() async {
        guard !loading, let owner = owner() else { return }
        loading = true
        let mine = generation
        defer { if mine == generation { loading = false } }
        let api = self.api
        async let fetchedOptions = Self.fetchOptions(api)
        let outcome: Result<RolodexPrepared, Error>
        do { outcome = .success(try await Self.fetchList(api)) } catch { outcome = .failure(error) }
        let freshOptions = await fetchedOptions
        guard mine == generation else { return }
        if let freshOptions { options = freshOptions }

        switch outcome {
        case .success(let list):
            let at = now()
            apply(list)
            listTime = at
            offline = false
            cachedAt = nil
            listError = nil
            loaded = true
            await saveCache(owner: owner, generation: mine)
        case .failure(let error):
            if error is CancellationError { return }
            guard Self.isOffline(error) else {
                listError = Self.errorText(for: error)
                // A refused account keeps no list, on screen or on disk.
                if ["forbidden", "move_locked"].contains((error as? ApiError)?.code) {
                    forgetList()
                    try? await store.clearRolodexCache()
                }
                return
            }
            if let cache = await Self.readCache(store, owner: owner) {
                let list = await Self.prepare(cache.workers)
                guard mine == generation else { return }
                apply(list)
                listTime = Date(timeIntervalSince1970: cache.loadedAt)
            }
            guard let listTime else {
                listError = Self.errorText(code: "network")
                return
            }
            offline = true
            cachedAt = listTime
            listError = nil
            loaded = true
        }
    }

    /// Pull to refresh / the refresh button: the list, then the open page (unless it's being edited).
    func refresh() async {
        await load()
        if let id = selectedId, editing == nil, !offline, !detailLoading { await loadDetail(id) }
    }

    /// Opens a worker's page (nil closes it). The worker already open, tapped again, reloads their
    /// page, which stays on screen meanwhile. While an Edit form is open (or its save is in
    /// flight) the page stays put: the admin uses Cancel or Save first (ruling S18, as Android's
    /// S12), and a save's result (or its error) has somewhere to show.
    func select(_ id: String?) async {
        guard !saving, editing == nil else { return }
        if let id, id == selectedId {
            if detailLoading { return }
            if detail?.personId == id {
                await loadDetail(id)
                return
            }
        }
        if id == nil && selectedId == nil { return }
        selectedId = id
        detail = nil
        detailError = nil
        detailLoading = false
        detailToken += 1
        editing = nil
        errorText = nil
        guard let id else { return }
        await loadDetail(id)
    }

    private func loadDetail(_ id: String) async {
        detailToken += 1
        let token = detailToken
        detailLoading = true
        detailError = nil
        let api = self.api
        do {
            let fresh = try await Self.fetchDetail(api, id)
            guard token == detailToken else { return }
            detail = fresh
            detailLoading = false
            upsertRow(fresh.row)
        } catch {
            guard token == detailToken else { return }
            detailLoading = false
            if !(error is CancellationError) { detailError = Self.errorText(for: error) }
        }
    }

    // MARK: the worker page

    /// The selected worker as the page shows them: their page once it's here, else their list row.
    var shownRow: RolodexRow? {
        if let detail, detail.personId == selectedId { return detail.row }
        return rows.first { $0.personId == selectedId }
    }

    /// Edit (and the camera badge) work: the page is here, the server allows it, and the kiosk is
    /// online. Not while the page reloads: a form built from the old page would send its stale
    /// values back as changes.
    var canEdit: Bool {
        guard let detail, detail.personId == selectedId, !detailLoading else { return false }
        return detail.canEdit && !offline
    }

    /// An Edit form is open (or saving): the list beside it doesn't open another worker.
    var selectionLocked: Bool { editing != nil || saving }

    /// The worker a list tap shows: the tapped one, or while an Edit form is open the worker being
    /// edited (a phone's list hides the form; the tap brings it back, for Cancel or Save).
    func workerToShow(tapped id: String) -> String {
        guard selectionLocked, let selectedId else { return id }
        return selectedId
    }

    /// Why Edit is off for this worker, in the spec's words.
    var editBlockText: String? {
        guard let detail, detail.personId == selectedId, !detail.canEdit else { return nil }
        return Self.errorText(code: detail.editBlockReason ?? "rank_too_low")
    }

    /// Why the status control is off for this worker, in the spec's words.
    var statusBlockText: String? {
        guard let detail, detail.personId == selectedId, !detail.canChangeStatus else { return nil }
        return Self.errorText(code: detail.statusBlockReason == "self" ? "cannot_target_self" : (detail.statusBlockReason ?? "rank_too_low"))
    }

    func startEdit() {
        guard canEdit, editing == nil, let detail else { return }
        errorText = nil
        editing = RolodexEdit(detail)
    }

    func cancelEdit() {
        guard !saving else { return }
        editing = nil
        errorText = nil
    }

    /// Sends only what changed (cleared fields as null). One request at a time: a second Save
    /// while one is in flight does nothing. A failure keeps the form as typed and says why.
    /// True when the worker is saved (or nothing had changed).
    @discardableResult
    func save() async -> Bool {
        guard !saving, let edit = editing, let original = detail, original.personId == selectedId else { return false }
        if let problem = RolodexLogic.validate(edit) {
            errorText = problem
            return false
        }
        let patch = RolodexLogic.buildPatch(original: original, edited: edit)
        guard !patch.isEmpty else {
            editing = nil
            errorText = nil
            return true
        }
        saving = true
        errorText = nil
        let mine = generation
        let id = original.personId
        let api = self.api
        do {
            let saved = try await Self.sendPatch(api, id, patch)
            guard mine == generation else { return false }
            showWorker(saved)
            saving = false
            await persistWorker(saved, generation: mine)
            return true
        } catch {
            guard mine == generation else { return false }
            saving = false
            if selectedId == id, !(error is CancellationError) { errorText = Self.errorText(for: error) }
            return false
        }
    }

    /// The server's answer to a save or a create: the page when it's open, the list row, then the
    /// Time Clock's roster and the offline copy.
    func applyWorker(_ worker: RolodexDetail) async {
        showWorker(worker)
        await persistWorker(worker, generation: generation)
    }

    /// A worker the New worker flow just created: their page opens from the create's answer (no
    /// fetch), and they join the list, the Time Clock's roster and the offline copy. An Edit form
    /// in progress keeps its page (they still join the list).
    func open(_ worker: RolodexDetail) async {
        if !selectionLocked {
            selectedId = worker.personId
            detail = worker
            detailError = nil
            detailLoading = false
            detailToken += 1
            editing = nil
            errorText = nil
        }
        await applyWorker(worker)
    }

    /// A new photo for `personId` (`RolodexPhotoFlow`): the page (when it's theirs) and the list
    /// row show it, and the offline copy keeps it. An Edit form in progress is left as typed.
    func applyPhoto(personId: String, _ out: RolodexPhotoOut) async {
        if var page = detail, page.personId == personId {
            page.hasPhoto = true
            page.photoUrl = out.photoUrl
            page.photoVersion = out.photoVersion
            detail = page
        }
        if var row = rows.first(where: { $0.personId == personId }) {
            row.hasPhoto = true
            row.photoUrl = out.photoUrl
            row.photoVersion = out.photoVersion
            upsertRow(row)
        }
        if let owner = owner() { await saveCache(owner: owner, generation: generation) }
    }

    private func showWorker(_ worker: RolodexDetail) {
        if selectedId == worker.personId {
            detail = worker
            editing = nil
            errorText = nil
        }
        upsertRow(worker.row)
    }

    /// The roster keeps the person's RFID tag and badge; the offline copy never holds email or phone.
    private func persistWorker(_ worker: RolodexDetail, generation mine: Int) async {
        try? await store.upsertRosterPerson(KioskPersonRow(rolodex: worker))
        if let owner = owner() { await saveCache(owner: owner, generation: mine) }
    }

    // MARK: sign-out

    /// A sign-out, a session end or Reset app: forgets the list and the page and deletes the
    /// offline copy (the returned task finishes once it's gone).
    @discardableResult
    func clear() -> Task<Void, Never> {
        generation += 1
        detailToken += 1
        forgetSession()
        query = ""
        filter = RolodexLogic.filterAll
        loading = false
        options = RolodexOptions()
        selectedId = nil
        detail = nil
        detailLoading = false
        detailError = nil
        editing = nil
        saving = false
        errorText = nil
        photo.reset()
        newWorker.reset()
        photoCache.removeAll()
        let store = self.store
        return Task { try? await store.clearRolodexCache() }
    }

    /// The list goes, and its error: the next admin starts clean. (A refused account's load
    /// calls `forgetList()` alone, keeping the error it just set.)
    private func forgetSession() {
        forgetList()
        listError = nil
    }

    private func forgetList() {
        rows = []
        index = [:]
        listTime = nil
        loaded = false
        offline = false
        cachedAt = nil
        recompute()
    }

    // MARK: search and filters

    /// The status chips: the server's statuses or, before `/options` answers (offline), the
    /// statuses the rows carry, in list order.
    var statusFilters: [RolodexStatus] {
        if !options.statuses.isEmpty { return options.statuses }
        var seen = Set<String>()
        return rows.compactMap { row in
            guard !row.status.isEmpty, seen.insert(row.status).inserted else { return nil }
            return RolodexStatus(key: row.status, label: row.statusLabel, color: row.statusColor)
        }
    }

    /// All, one per status, No photo; each with its count over the searched list.
    var filterChips: [RolodexFilterChip] {
        let statuses = statusFilters.map { s in
            RolodexFilterChip(key: s.key, label: s.label.isEmpty ? s.key.capitalized : s.label, count: counts[s.key] ?? 0)
        }
        return [RolodexFilterChip(key: RolodexLogic.filterAll, label: "All", count: counts[RolodexLogic.filterAll] ?? 0)]
            + statuses
            + [RolodexFilterChip(key: RolodexLogic.filterNoPhoto, label: "No photo", count: counts[RolodexLogic.filterNoPhoto] ?? 0)]
    }

    private func apply(_ list: RolodexPrepared) {
        rows = list.rows
        index = list.index
        recompute()
    }

    /// Puts `row` in the list (replacing the worker's row, or adding it) in list order.
    private func upsertRow(_ row: RolodexRow) {
        if let i = rows.firstIndex(where: { $0.personId == row.personId }) {
            if rows[i] == row { return }
            rows[i] = row
        } else {
            rows.append(row)
        }
        index[row.personId] = RolodexIndexed(row)
        rows = RolodexPrepared.sorted(rows, index)
        recompute()
    }

    private func recompute() {
        let terms = RolodexLogic.searchTerms(query)
        let searched = terms.isEmpty ? rows : rows.filter { row in
            RolodexLogic.matches(words: index[row.personId]?.words ?? RolodexLogic.searchWords(row), terms: terms)
        }
        counts = RolodexLogic.filterCounts(searched, statusKeys: statusFilters.map(\.key))
        sections = group(RolodexLogic.applyFilter(searched, filter: filter))
    }

    /// `RolodexLogic.sections` for rows already in its order, from the letters indexed at load:
    /// A–Z, then `#`.
    private func group(_ visible: [RolodexRow]) -> [RolodexSection] {
        var letters: [String] = []
        var groups: [String: [RolodexRow]] = [:]
        for row in visible {
            let letter = index[row.personId]?.letter ?? RolodexLogic.sectionLetter(lastName: row.lastName)
            if groups[letter] == nil { letters.append(letter) }
            groups[letter, default: []].append(row)
        }
        return letters
            .sorted { a, b in a == "#" ? false : b == "#" ? true : a < b }
            .map { RolodexSection(letter: $0, rows: groups[$0] ?? []) }
    }

    // MARK: copy

    /// The spec's §4.2 sentence for an API error code (`network` for no connection).
    static func errorText(code: String?) -> String {
        switch code {
        case "forbidden", "move_locked": "Your account can't use the Rolodex."
        case "read_only_mode": "The system is in read-only mode, so changes can't be saved right now."
        case "email_in_use": "Another person already uses that email."
        case "rank_too_low": "This person has a portal login ranked above yours."
        case "cannot_target_self": "You can't change your own status."
        case "blacklist_requires_note": "Add a note to blacklist someone."
        case "file_too_large", "empty_file", "invalid_file_type", "unreadable_image", "image_too_large":
            "That photo couldn't be used. Take or choose another one."
        case "network": "No connection. Try again when you're back online."
        default: "Something went wrong. Try again."
        }
    }

    /// `errorText(code:)` for a thrown error: a transport failure is "network", any 423 read-only.
    static func errorText(for error: Error) -> String {
        guard let e = error as? ApiError else { return errorText(code: nil) }
        if e.isNetwork { return errorText(code: "network") }
        if e.status == 423 { return errorText(code: "read_only_mode") }
        return errorText(code: e.code)
    }

    /// "Offline · showing the list from 3:42 PM. Changes need a connection." (with the day when
    /// the copy isn't from today).
    static func offlineText(cachedAt: Date, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let base = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let style = calendar.isDate(cachedAt, inSameDayAs: now)
            ? base.hour().minute()
            : base.month(.abbreviated).day().hour().minute()
        return "Offline · showing the list from \(cachedAt.formatted(style)). Changes need a connection."
    }

    /// No connection, or the server failing: the offline copy shows.
    private static func isOffline(_ error: Error) -> Bool {
        guard let e = error as? ApiError else { return false }
        return e.isNetwork || e.status >= 500
    }

    // MARK: off the main actor

    @concurrent nonisolated private static func fetchList(_ api: KioskApi) async throws -> RolodexPrepared {
        RolodexPrepared(try await api.rolodexWorkers().workers)
    }

    @concurrent nonisolated private static func fetchOptions(_ api: KioskApi) async -> RolodexOptions? {
        try? await api.rolodexOptions()
    }

    @concurrent nonisolated private static func fetchDetail(_ api: KioskApi, _ id: String) async throws -> RolodexDetail {
        try await api.rolodexWorker(id: id)
    }

    @concurrent nonisolated private static func sendPatch(_ api: KioskApi, _ id: String, _ patch: RolodexPatch) async throws -> RolodexDetail {
        try await api.rolodexUpdate(id: id, patch: patch)
    }

    @concurrent nonisolated private static func prepare(_ workers: [RolodexRow]) async -> RolodexPrepared {
        RolodexPrepared(workers)
    }

    /// This admin's copy from this API; nil when there's none (or it's someone else's).
    @concurrent nonisolated private static func readCache(_ store: KioskStore, owner: Owner) async -> RolodexCache? {
        guard let text = (try? await store.rolodexCache()) ?? nil,
              let cache = try? KioskJSON.decoder.decode(RolodexCache.self, from: Data(text.utf8)),
              cache.ownerId == owner.personId, cache.apiUrl == owner.apiUrl else { return nil }
        return cache
    }

    @concurrent nonisolated private static func writeCache(_ store: KioskStore, _ cache: RolodexCache) async {
        guard let data = try? KioskJSON.encoder.encode(cache) else { return }
        try? await store.storeRolodexCache(String(decoding: data, as: UTF8.self))
    }

    /// Writes the offline copy for work started in `generation`. A `clear()` (a sign-out) that
    /// lands while the write is under way deletes the copy again, so it never outlives the session.
    private func saveCache(owner: Owner, generation mine: Int) async {
        guard mine == generation, let listTime else { return }
        await Self.writeCache(store, RolodexCache(ownerId: owner.personId, apiUrl: owner.apiUrl,
                                                  loadedAt: listTime.timeIntervalSince1970, workers: rows))
        if mine != generation { try? await store.clearRolodexCache() }
    }

    // MARK: photos and New worker (state in `photo` and `newWorker`)

    /// The camera badge on the worker page: Take new photo / Choose photo, when the worker can be
    /// edited (`canEdit`: the server allows it and the kiosk is online).
    func startPhoto() {
        guard canEdit, let detail else { return }
        photo.start(for: detail)
    }

    /// "+ New" works with a list from the server (not the offline copy) for a signed-in admin,
    /// and not while an Edit form is open (Cancel or Save first, ruling S18).
    var canStartNewWorker: Bool { loaded && !offline && !selectionLocked && owner() != nil }

    /// Opens the New worker flow with an empty form.
    func startNewWorker() {
        guard canStartNewWorker else { return }
        newWorker.start()
    }
}
