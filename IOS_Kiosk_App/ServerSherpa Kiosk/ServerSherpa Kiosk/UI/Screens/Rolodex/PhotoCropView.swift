import SwiftUI
import UIKit

/// "Position your photo" (mockup 3): the picture under a circular mask; drag to move, pinch or
/// the slider to zoom 1×–4× over cover-fit, never uncovering the circle. Retake / Use photo (the
/// New worker flow's primary reads Create worker). Every bit of state is in `RolodexCrop`.
struct PhotoCropView: View {
    let crop: RolodexCrop
    let useTitle: String
    /// "Saving…" or "Creating…" while the photo (or the worker) is on its way.
    let busyText: String?
    let errorText: String?
    let onRetake: () -> Void
    let onUse: () -> Void
    @Environment(\.kioskPalette) private var palette

    private var busy: Bool { busyText != nil }

    var body: some View {
        VStack(spacing: 0) {
            PhotoStepBar(backTitle: "‹ Retake", backEnabled: !busy, title: "Position your photo", onBack: onRetake)
            GeometryReader { geo in
                let guide = photoGuideLayout(geo.size, reserveBottom: 210)
                ZStack {
                    picture(guide)
                    VStack(spacing: 12) {
                        Spacer(minLength: 0)
                        Text("Drag to move · pinch or slide to zoom")
                            .font(KioskType.sans(14, .medium)).foregroundStyle(Color.white)
                            .shadow(color: .black.opacity(0.6), radius: 3)
                        Slider(value: Binding(get: { crop.zoom }, set: { crop.setZoom($0) }),
                               in: PhotoCropMath.minZoom...PhotoCropMath.maxZoom)
                            .tint(palette.accent)
                            .disabled(busy)
                            .frame(maxWidth: 420)
                            .padding(.horizontal, 12)
                            .accessibilityLabel("Zoom")
                            .accessibilityValue(String(format: "%.1f×", crop.zoom))
                            .accessibilityIdentifier("photo-zoom")
                        PhotoStepError(text: errorText)
                        HStack(spacing: 10) {
                            Button(action: onRetake) {
                                Text("Retake").font(KioskType.labelLarge).foregroundStyle(Color.white)
                                    .frame(maxWidth: .infinity, minHeight: 48)
                                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.35), lineWidth: 1))
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(busy)
                            .opacity(busy ? 0.45 : 1)
                            .accessibilityIdentifier("photo-retake")
                            Button(action: onUse) {
                                HStack(spacing: 8) {
                                    if busy { ProgressView().tint(palette.ink) }
                                    Text(busyText ?? useTitle).font(KioskType.labelLarge).foregroundStyle(palette.ink)
                                }
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .background(palette.accent, in: RoundedRectangle(cornerRadius: 10))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(busy)
                            .accessibilityIdentifier("photo-use")
                        }
                        .frame(maxWidth: 520)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
                .clipped()
            }
        }
        // The picture's backdrop as the dim leaves it, under the home indicator too.
        .background(Color(hex: 0x040608).ignoresSafeArea())
    }

    /// The picture at its zoom and offset, dimmed outside the circle; dragging or pinching
    /// anywhere on it moves or zooms it.
    private func picture(_ guide: (diameter: CGFloat, center: CGPoint)) -> some View {
        let v = Double(guide.diameter)
        let size = crop.displaySize(viewport: v)
        return ZStack {
            Color(hex: 0x0B0F14)
            Image(uiImage: crop.preview)
                .resizable()
                .interpolation(.high)
                .frame(width: size.width, height: size.height)
                .position(x: guide.center.x + crop.offsetX * v, y: guide.center.y + crop.offsetY * v)
            PhotoCircleDim(diameter: guide.diameter, center: guide.center)
                .fill(Color.black.opacity(0.6), style: FillStyle(eoFill: true))
            Circle()
                .stroke(Color.white.opacity(0.9), lineWidth: 2)
                .frame(width: guide.diameter, height: guide.diameter)
                .position(guide.center)
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture()
                .onChanged { crop.drag(x: $0.translation.width, y: $0.translation.height, viewport: v) }
                .onEnded { _ in crop.endDrag() }
                .simultaneously(with: MagnifyGesture()
                    .onChanged { crop.pinch($0.magnification) }
                    .onEnded { _ in crop.endPinch() })
        )
        .allowsHitTesting(!busy)
        .accessibilityElement()
        .accessibilityLabel("Photo position")
        .accessibilityHint("Drag to move · pinch or slide to zoom")
    }
}
