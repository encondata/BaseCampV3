import Foundation
import ImageIO
import SwiftUI
import UIKit

/// Decoded worker photos in memory, keyed by person, photo version and pixel size: never by the
/// presigned URL, which expires and changes on every load. A new photo has a new version, so it
/// never shows an old one. Emptied on sign-out (`RolodexModel.clear()`); after a relaunch with
/// no connection the rows show initials.
final class RolodexPhotoCache: @unchecked Sendable {
    static let shared = RolodexPhotoCache()

    /// NSCache is thread-safe.
    private let cache = NSCache<NSString, UIImage>()

    init(totalCostLimit: Int = 48 * 1024 * 1024) {
        cache.totalCostLimit = totalCostLimit
    }

    static func key(personId: String, photoVersion: String, pixels: Int) -> String { "\(personId):\(photoVersion):\(pixels)" }

    func image(_ key: String) -> UIImage? { cache.object(forKey: key as NSString) }

    func store(_ image: UIImage, _ key: String) {
        let pixels = (image.cgImage?.width ?? 0) * (image.cgImage?.height ?? 0)
        cache.setObject(image, forKey: key as NSString, cost: pixels * 4)
    }

    func removeAll() { cache.removeAllObjects() }
}

/// The avatar's load restarts when the photo's version changes and also when its presigned
/// link does: a fetch that failed on an expired link (600 s) tries again once the row or the
/// worker's page brings a fresh one. A photo already showing or cached isn't fetched again.
func rolodexAvatarTaskId(key: String?, url: String?) -> String { "\(key ?? "")|\(url ?? "")" }

/// A worker's round photo, or their initials on the Time Clock's gray gradient while there's
/// none (or it can't load). The photo is fetched (unauthenticated, presigned) and shrunk off the
/// main actor, then cached in `RolodexPhotoCache`.
struct RolodexAvatar: View {
    let personId: String
    let name: String
    let photoUrl: String?
    let photoVersion: String?
    let size: CGFloat
    @Environment(\.container) private var container
    @State private var image: UIImage?
    /// The cache key `image` was loaded for.
    @State private var imageKey: String?

    init(row: RolodexRow, size: CGFloat) {
        personId = row.personId
        name = rolodexName(row)
        photoUrl = row.hasPhoto ? row.photoUrl : nil
        photoVersion = row.hasPhoto ? row.photoVersion : nil
        self.size = size
    }

    /// Rows (44 pt) share a small decode; the worker page's photo a larger one.
    private var pixels: Int { size <= 64 ? 160 : 400 }

    private var key: String? {
        photoVersion.map { RolodexPhotoCache.key(personId: personId, photoVersion: $0, pixels: pixels) }
    }

    var body: some View {
        // A cached photo shows on the first frame (no initials flash while scrolling back).
        let shown = (imageKey == key ? image : nil) ?? key.flatMap { RolodexPhotoCache.shared.image($0) }
        ZStack {
            if let shown {
                Image(uiImage: shown).resizable().scaledToFill()
            } else {
                LinearGradient(colors: [Color(hex: 0x334155), Color(hex: 0x64748B)], startPoint: .topLeading, endPoint: .bottomTrailing)
                Text(initialsOf(name))
                    .font(KioskType.sans(size * 0.34, .bold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: rolodexAvatarTaskId(key: key, url: photoUrl)) { await load() }
    }

    private func load() async {
        guard let key else {
            image = nil
            imageKey = nil
            return
        }
        if imageKey == key, image != nil { return }
        let api = container.api
        guard let photo = await Self.photo(key: key, url: photoUrl, pixels: pixels, fetch: { try await api.fetchImage(url: $0) }),
              !Task.isCancelled else { return }
        image = photo
        imageKey = key
    }

    /// The photo for `key`: the cached one, else fetched from `url`, shrunk to `pixels` and cached.
    /// Nil without a link or on any failure (no connection, an expired link, not an image), which
    /// caches nothing, so a later call with a fresh link tries again.
    @concurrent nonisolated static func photo(key: String, url: String?, pixels: Int, cache: RolodexPhotoCache = .shared,
                                              fetch: @Sendable (String) async throws -> Data) async -> UIImage? {
        if let hit = cache.image(key) { return hit }
        guard let url, !url.isEmpty, let data = try? await fetch(url), let photo = downsample(data, maxPixels: pixels) else { return nil }
        cache.store(photo, key)
        return photo
    }

    /// At most `maxPixels` on the long side, EXIF orientation applied.
    nonisolated static func downsample(_ data: Data, maxPixels: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }
}
