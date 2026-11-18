import SwiftUI
import UIKit

/// The worker's photo, large and whole: full screen, scaled to fit (never cut to the avatar's
/// circle) on the theme's paper. The saved photo is the square chosen in "Position your photo", so
/// whole means all of that square. Close, a tap anywhere or an accessibility escape closes it.
/// Close sits in the safe area over the photo, never inside a scroll, so it is always visible.
/// `placeholder` is the avatar's own decode, shown at once while a larger one loads (or when it
/// can't, say offline); it comes from the same cache, so nothing is fetched twice.
struct PhotoViewer: View {
    let personId: String
    let name: String
    let photoUrl: String?
    let photoVersion: String?
    let placeholder: UIImage?
    let onClose: () -> Void
    @Environment(\.container) private var container
    @Environment(\.kioskPalette) private var palette
    @State private var large: UIImage?

    /// Long side of the viewer's own decode: sharp on an iPad, small enough to hold in memory.
    nonisolated static let pixels = 1600

    private var key: String? {
        photoVersion.map { RolodexPhotoCache.key(personId: personId, photoVersion: $0, pixels: Self.pixels) }
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            palette.paper2.ignoresSafeArea()
            if let shown = large ?? placeholder {
                Image(uiImage: shown)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.horizontal, 16)
                    .padding(.top, 60)
                    .padding(.bottom, 16)
                    .accessibilityLabel("Photo of \(name)")
                    .accessibilityIdentifier("photo-viewer-image")
            }
            Button(action: onClose) {
                Text("Close").font(KioskType.labelLarge).foregroundStyle(palette.accent)
                    .padding(.horizontal, 12).frame(minHeight: 48)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .padding(.top, 6).padding(.trailing, 8)
            .accessibilityIdentifier("photo-viewer-close")
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onClose)
        .accessibilityAction(.escape, onClose)
        .task(id: rolodexAvatarTaskId(key: key, url: photoUrl)) { await load() }
    }

    private func load() async {
        guard let key else { return }
        let api = container.api
        if let photo = await RolodexAvatar.photo(key: key, url: photoUrl, pixels: Self.pixels, fetch: { try await api.fetchImage(url: $0) }),
           !Task.isCancelled {
            large = photo
        }
    }
}
