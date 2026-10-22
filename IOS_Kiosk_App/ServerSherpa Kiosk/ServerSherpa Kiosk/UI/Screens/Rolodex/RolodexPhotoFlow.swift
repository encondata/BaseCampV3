import CoreGraphics
import Foundation
import Observation
import UIKit

/// "Position your photo" (spec §4.2): the picture, upright and at most 2048 px, and where it sits
/// under the circle: zoom 1×–4× over cover-fit and an offset (image center minus circle center)
/// in units of the circle's diameter, so a rotation or a resize keeps the framing. The offset is
/// always clamped so the picture covers the circle. Kept in a model, not view state.
@MainActor @Observable
final class RolodexCrop {
    let image: CGImage
    @ObservationIgnored let preview: UIImage
    private(set) var zoom = PhotoCropMath.minZoom
    private(set) var offsetX = 0.0
    private(set) var offsetY = 0.0
    /// Where the drag or pinch under way started.
    @ObservationIgnored private var dragStart: (x: Double, y: Double)?
    @ObservationIgnored private var pinchStart: Double?

    init(image: CGImage) {
        self.image = image
        preview = UIImage(cgImage: image)
    }

    private var w: Double { Double(image.width) }
    private var h: Double { Double(image.height) }

    /// The picture's size on screen under a circle `v` points across: cover-fit times the zoom.
    func displaySize(viewport v: Double) -> (width: Double, height: Double) {
        let s = PhotoCropMath.scale(w: w, h: h, v: v, z: zoom)
        return (w * s, h * s)
    }

    /// The slider (1–4), or a pinch.
    func setZoom(_ z: Double) {
        zoom = PhotoCropMath.clampZoom(z)
        move(offsetX, offsetY)
    }

    /// A drag of (`x`, `y`) points so far, under a circle `v` points across.
    func drag(x: Double, y: Double, viewport v: Double) {
        guard v > 0 else { return }
        let start = dragStart ?? (offsetX, offsetY)
        dragStart = start
        move(start.x + x / v, start.y + y / v)
    }

    func endDrag() { dragStart = nil }

    /// A pinch that has scaled by `factor` so far.
    func pinch(_ factor: Double) {
        let start = pinchStart ?? zoom
        pinchStart = start
        setZoom(start * factor)
    }

    func endPinch() { pinchStart = nil }

    private func move(_ x: Double, _ y: Double) {
        (offsetX, offsetY) = PhotoCropMath.clampOffset(w: w, h: h, v: 1, z: zoom, dx: x, dy: y)
    }

    /// What the circle shows, as the 512×512 JPEG the Rolodex uploads (rendered off the main actor).
    func jpeg() async -> Data {
        await Self.render(image, zoom: zoom, dx: offsetX, dy: offsetY)
    }

    /// A crop for a capture or a library pick, decoded and shrunk off the main actor; nil when
    /// it isn't a picture.
    static func make(from data: Data) async -> RolodexCrop? {
        guard let image = await decode(data) else { return nil }
        return RolodexCrop(image: image)
    }

    @concurrent nonisolated private static func decode(_ data: Data) async -> CGImage? {
        PhotoRenderer.load(data: data)
    }

    @concurrent nonisolated private static func render(_ image: CGImage, zoom: Double, dx: Double, dy: Double) async -> Data {
        PhotoRenderer.render(image, v: 1, z: zoom, dx: dx, dy: dy)
    }
}

/// A new worker's photo that didn't upload after the create (spec §3.6), kept for Try again.
struct RolodexPhotoFailure: Equatable, Sendable {
    var name: String
    var jpeg: Data
    /// Why the last Try again failed, in the spec's words.
    var retryError: String?
}

/// A worker's new photo from their page's camera badge (spec §4.2): the "Take new photo / Choose
/// photo" sheet, the camera or the library, "Position your photo", then the upload. Also owns the
/// upload itself (the New worker flow's too) and the photos that didn't upload after a create,
/// with Try again. One for the app's lifetime (`RolodexModel.photo`), so the full-screen covers
/// and the library picker never hold this state themselves.
@MainActor @Observable
final class RolodexPhotoFlow {
    struct Target: Equatable, Sendable {
        var personId: String
        var name: String
    }

    /// `camera` is the photo step (the camera, or Choose photo only on a device without one);
    /// `loading` decodes a capture or a library pick.
    enum Stage: Equatable, Sendable { case none, camera, loading, crop }

    /// The worker the photo is for.
    private(set) var target: Target?
    /// "Photo for Ana Ortiz": Take new photo / Choose photo / Cancel.
    var sheet = false
    /// The photo library is up.
    var library = false
    /// Flip; every photo starts on the back camera (the admin holds the device).
    var frontCamera = false
    private(set) var stage: Stage = .none
    private(set) var crop: RolodexCrop?
    private(set) var uploading = false
    /// What went wrong with the picture or its upload, in the spec's words.
    private(set) var errorText: String?
    /// New workers whose photo didn't upload after the create, by person id.
    private(set) var failures: [String: RolodexPhotoFailure] = [:]
    private(set) var retrying: Set<String> = []

    /// The Rolodex the flow reports to (it owns the flow).
    @ObservationIgnored weak var host: RolodexModel?
    @ObservationIgnored private let api: KioskApi
    @ObservationIgnored private let cache: RolodexPhotoCache
    /// Bumped by `reset()` (a sign-out): work started before it is dropped.
    @ObservationIgnored private var generation = 0
    /// Bumped when the photo screens close: a late decode is dropped.
    @ObservationIgnored private var visit = 0

    init(api: KioskApi, cache: RolodexPhotoCache = .shared) {
        self.api = api
        self.cache = cache
    }

    /// The camera or "Position your photo" is up.
    var coverShown: Bool { stage != .none }

    /// "That photo couldn't be used. Take or choose another one."
    static let unusableText = RolodexModel.errorText(code: "unreadable_image")

    // MARK: the worker page

    /// The camera badge: offers Take new photo / Choose photo for a worker the admin may edit.
    func start(for worker: RolodexDetail) {
        guard worker.canEdit, !uploading else { return }
        closeScreens()
        target = Target(personId: worker.personId, name: rolodexName(worker.row))
        sheet = true
    }

    /// Take new photo: the camera, on the back camera.
    func takePhoto() {
        guard target != nil, !uploading else { return }
        sheet = false
        errorText = nil
        crop = nil
        frontCamera = false
        stage = .camera
    }

    /// Choose photo (from the sheet, the camera's Library, or a device without a camera).
    func chooseFromLibrary() {
        guard target != nil, !uploading else { return }
        sheet = false
        library = true
    }

    /// A capture or a library pick: decoded for "Position your photo". A file that isn't a
    /// picture goes back to the photo step and says so.
    func use(_ data: Data) async { await use { data } }

    /// `use(_:)` for a library pick, whose bytes arrive later (`PhotosPickerItem`).
    func use(loading: @escaping @Sendable () async throws -> Data?) async {
        guard target != nil, !uploading, stage != .loading else { return }
        library = false
        errorText = nil
        stage = .loading
        let mine = visit
        let data = try? await loading()
        let made: RolodexCrop? = if let data { await RolodexCrop.make(from: data) } else { nil }
        guard mine == visit, target != nil else { return }
        crop = made
        if made == nil { errorText = Self.unusableText }
        stage = made == nil ? .camera : .crop
    }

    /// Retake: back to the photo step.
    func retake() {
        guard !uploading else { return }
        crop = nil
        errorText = nil
        stage = .camera
    }

    /// Cancel or Close: nothing changes.
    func close() {
        guard !uploading else { return }
        closeScreens()
    }

    /// Use photo: the 512×512 JPEG goes up as the worker's photo; the page and the list show it.
    /// One upload at a time (a second tap does nothing); a failure keeps the crop and says why.
    func usePhoto() async {
        guard let target, let crop, !uploading else { return }
        uploading = true
        errorText = nil
        let mine = generation
        let jpeg = await crop.jpeg()
        do {
            try await uploadPhoto(personId: target.personId, jpeg: jpeg)
            guard mine == generation else { return }
            uploading = false
            closeScreens()
        } catch {
            guard mine == generation else { return }
            uploading = false
            if !(error is CancellationError) { errorText = RolodexModel.errorText(for: error) }
        }
    }

    private func closeScreens() {
        visit += 1
        target = nil
        sheet = false
        library = false
        stage = .none
        crop = nil
        errorText = nil
    }

    // MARK: the upload

    /// Sends `jpeg` as `personId`'s photo. On success the page, the list row and the offline copy
    /// show it, and the photo cache already holds the picture (no fetch of the new link); a photo
    /// left over from a failed upload is forgotten. Throws the API's error (or a cancel after a
    /// sign-out).
    func uploadPhoto(personId: String, jpeg: Data) async throws {
        let mine = generation
        let out = try await Self.send(api, personId, jpeg)
        guard mine == generation else { throw CancellationError() }
        if let version = out.photoVersion { await Self.remember(jpeg, personId: personId, version: version, in: cache) }
        guard mine == generation else { throw CancellationError() }
        failures[personId] = nil
        await host?.applyPhoto(personId: personId, out)
    }

    // MARK: a new worker's photo that didn't upload

    /// Kept so the worker's page can say so and Try again.
    func recordFailure(personId: String, name: String, jpeg: Data) {
        failures[personId] = RolodexPhotoFailure(name: name, jpeg: jpeg)
    }

    /// "Marcus Reed was saved, but the photo didn't upload." while that photo is waiting.
    func failureText(for personId: String) -> String? {
        failures[personId].map { "\($0.name) was saved, but the photo didn't upload." }
    }

    /// Why the last Try again failed.
    func retryErrorText(for personId: String) -> String? { failures[personId]?.retryError }

    func isRetrying(_ personId: String) -> Bool { retrying.contains(personId) }

    /// Try again: the same photo, once at a time per worker.
    func retry(_ personId: String) async {
        guard let failure = failures[personId], !retrying.contains(personId) else { return }
        retrying.insert(personId)
        failures[personId]?.retryError = nil
        let mine = generation
        do {
            try await uploadPhoto(personId: personId, jpeg: failure.jpeg)
            guard mine == generation else { return }
            retrying.remove(personId)
        } catch {
            guard mine == generation else { return }
            retrying.remove(personId)
            if !(error is CancellationError) { failures[personId]?.retryError = RolodexModel.errorText(for: error) }
        }
    }

    // MARK: sign-out

    /// A sign-out, a session end or Reset app: closes everything and forgets the waiting photos.
    func reset() {
        generation += 1
        closeScreens()
        frontCamera = false
        uploading = false
        failures = [:]
        retrying = []
    }

    // MARK: off the main actor

    @concurrent nonisolated private static func send(_ api: KioskApi, _ id: String, _ jpeg: Data) async throws -> RolodexPhotoOut {
        try await api.rolodexPhoto(id: id, jpeg: jpeg)
    }

    /// The rows' and the page's sizes of the new photo, in the photo cache under its new version.
    @concurrent nonisolated private static func remember(_ jpeg: Data, personId: String, version: String, in cache: RolodexPhotoCache) async {
        for pixels in RolodexAvatar.pixelSizes {
            guard let image = RolodexAvatar.downsample(jpeg, maxPixels: pixels) else { continue }
            cache.store(image, RolodexPhotoCache.key(personId: personId, photoVersion: version, pixels: pixels))
        }
    }
}
