import SwiftUI
import UIKit

/// The worker's photo, large and whole: full screen, scaled to fit (never cut to the avatar's
/// circle) on the theme's paper. The saved photo is the 512 px square chosen in "Position your
/// photo", so the avatar's own decode (400 px, from `RolodexPhotoCache`) is shown as is: nothing
/// is fetched again. Close, a tap anywhere or an accessibility escape closes it. Close sits in the
/// safe area over the photo, never inside a scroll, so it is always visible.
struct PhotoViewer: View {
    let name: String
    let photo: UIImage?
    let onClose: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        ZStack(alignment: .topTrailing) {
            palette.paper2.ignoresSafeArea()
            if let photo {
                Image(uiImage: photo)
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
    }
}
