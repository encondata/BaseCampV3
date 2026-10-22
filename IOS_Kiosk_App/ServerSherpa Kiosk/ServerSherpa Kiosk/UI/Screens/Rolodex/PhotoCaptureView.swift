import AVFoundation
import SwiftUI
import UIKit

// MARK: - Shared pieces of the photo screens

/// The photo screens' dark top bar (mockups 3–4): an accent back action on the left, the title
/// centered.
struct PhotoStepBar: View {
    let backTitle: String
    var backEnabled = true
    let title: String
    let onBack: () -> Void
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        ZStack {
            Text(title)
                .font(KioskType.sans(16, .semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, 84)
                .accessibilityAddTraits(.isHeader)
            HStack {
                Button(action: onBack) {
                    Text(backTitle).font(KioskType.labelLarge).foregroundStyle(palette.accent)
                        .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!backEnabled)
                .opacity(backEnabled ? 1 : 0.45)
                .accessibilityIdentifier("photo-back")
                Spacer()
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
        .background(Color(hex: 0x0C1117).ignoresSafeArea(edges: .top))
    }
}

/// A full-size layer that dims everything but a circle `diameter` across centered at `center`.
struct PhotoCircleDim: Shape {
    let diameter: CGFloat
    let center: CGPoint

    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        path.addEllipse(in: CGRect(x: center.x - diameter / 2, y: center.y - diameter / 2, width: diameter, height: diameter))
        return path
    }
}

/// An error line on the dark photo screens (the shell's toasts don't show over a full-screen cover).
struct PhotoStepError: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text)
                .font(KioskType.bodyMedium)
                .foregroundStyle(Color.white)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .frame(maxWidth: 520)
                .background(Color(hex: 0xB4202F).opacity(0.9), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityIdentifier("photo-error")
        }
    }
}

/// The circle's place on the photo screens: a little above the middle, sized to the room.
func photoGuideLayout(_ size: CGSize, reserveBottom: CGFloat) -> (diameter: CGFloat, center: CGPoint) {
    let room = max(size.height - reserveBottom, 120)
    let diameter = max(min(size.width - 48, room - 56, 440), 120)
    return (diameter, CGPoint(x: size.width / 2, y: max(room * 0.5, diameter / 2 + 40)))
}

// MARK: - The camera

/// Hosts the photo camera's preview, kept upright by a RotationCoordinator, which the camera
/// also uses to turn each capture to the horizon.
private struct PhotoCameraPreview: UIViewRepresentable {
    let camera: PhotoCamera

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        private var coordinator: AVCaptureDevice.RotationCoordinator?
        private var observation: NSKeyValueObservation?
        weak var camera: PhotoCamera?

        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

        /// Recreated on every camera change (Flip).
        func attach(_ device: AVCaptureDevice) {
            let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
            self.coordinator = coordinator
            camera?.rotation = coordinator
            observation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.applyRotation() }
            }
        }

        func applyRotation() {
            guard let coordinator, let connection = previewLayer.connection else { return }
            let angle = coordinator.videoRotationAngleForHorizonLevelPreview
            if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            applyRotation()
        }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.backgroundColor = .black
        view.camera = camera
        view.previewLayer.session = camera.session
        view.previewLayer.videoGravity = .resizeAspectFill
        camera.onDevice = { [weak view] device in view?.attach(device) }
        if let device = camera.activeDevice { view.attach(device) }
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}

/// The photo step (mockups 3–4): the live back camera behind a circle guide, "Frame the worker's
/// face in the circle", the shutter, Flip and Library. A device without a camera (the simulator)
/// offers Choose photo only; a denied camera says so and offers Choose photo. `footer` holds the
/// New worker flow's "Continue without photo".
struct PhotoCaptureView<Footer: View>: View {
    let backTitle: String
    let onBack: () -> Void
    /// The flow's Flip (it starts on the back camera).
    @Binding var front: Bool
    /// Shown over the controls while a picture is decoded or the worker is created.
    let busyText: String?
    let errorText: String?
    /// The capture's bytes.
    let onCapture: (Data) -> Void
    let onLibrary: () -> Void
    @ViewBuilder let footer: () -> Footer

    @State private var camera = PhotoCamera()
    @State private var status = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var isActive = false
    @State private var capturing = false
    @State private var failure: String?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.kioskPalette) private var palette

    static var deniedText: String { "Camera access is off. Turn it on in Settings, or choose a photo instead." }

    private var hasCamera: Bool { CameraSupport.hasCamera }
    private var canFlip: Bool { CameraSupport.hasBackCamera && CameraSupport.hasFrontCamera }
    /// Back unless flipped (or the only camera is the front one).
    private var useFront: Bool { CameraSupport.hasBackCamera ? front : true }
    private var live: Bool { hasCamera && status == .authorized }
    private var denied: Bool { status == .denied || status == .restricted }
    private var busy: Bool { busyText != nil || capturing }

    var body: some View {
        VStack(spacing: 0) {
            PhotoStepBar(backTitle: backTitle, backEnabled: busyText == nil, title: "Photo", onBack: onBack)
            GeometryReader { geo in
                let controls: CGFloat = live ? 190 : 170
                let guide = photoGuideLayout(geo.size, reserveBottom: controls)
                ZStack {
                    Color.black
                    if live {
                        PhotoCameraPreview(camera: camera)
                    }
                    PhotoCircleDim(diameter: guide.diameter, center: guide.center)
                        .fill(Color.black.opacity(0.55), style: FillStyle(eoFill: true))
                        .allowsHitTesting(false)
                    Circle()
                        .stroke(Color.white.opacity(0.8), style: StrokeStyle(lineWidth: 2, dash: [7, 6]))
                        .frame(width: guide.diameter, height: guide.diameter)
                        .position(guide.center)
                        .allowsHitTesting(false)
                    if !live {
                        message
                            .frame(width: max(guide.diameter - 32, 100))
                            .position(guide.center)
                    }
                    VStack(spacing: 12) {
                        if live {
                            Text("Frame the worker's face in the circle")
                                .font(KioskType.sans(14, .medium)).foregroundStyle(Color.white)
                                .shadow(color: .black.opacity(0.6), radius: 3)
                                .padding(.top, 14)
                        }
                        Spacer(minLength: 0)
                        PhotoStepError(text: errorText ?? failure)
                        if let busyText {
                            HStack(spacing: 10) {
                                ProgressView().tint(Color.white)
                                Text(busyText).font(KioskType.labelLarge).foregroundStyle(Color.white)
                            }
                            .frame(minHeight: 66)
                            .accessibilityIdentifier("photo-busy")
                        } else if live {
                            controlsRow
                        } else {
                            PrimaryButton("Choose photo", action: onLibrary)
                                .accessibilityIdentifier("photo-choose")
                        }
                        footer()
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
                .clipped()
            }
        }
        .background(Color.black.ignoresSafeArea())
        .task { await prepare() }
        .onChange(of: front) { _, _ in startIfAllowed() }
        .onChange(of: scenePhase) { _, phase in
            // Allowing the camera in Settings works without leaving the screen.
            guard phase == .active, isActive, status != .authorized else { return }
            status = AVCaptureDevice.authorizationStatus(for: .video)
            startIfAllowed()
        }
        .onDisappear {
            isActive = false
            camera.onError = nil
            camera.onDevice = nil
            camera.rotation = nil
            camera.stop()
        }
    }

    /// In the circle when there's no live camera.
    @ViewBuilder private var message: some View {
        if !hasCamera {
            Image(systemName: "person.crop.circle")
                .font(.system(size: 64, weight: .light))
                .foregroundStyle(Color.white.opacity(0.45))
                .accessibilityHidden(true)
        } else if denied {
            VStack(spacing: 6) {
                Text(Self.deniedText)
                    .font(KioskType.bodyMedium).foregroundStyle(Color.white).multilineTextAlignment(.center)
                    .accessibilityIdentifier("photo-denied")
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .font(KioskType.labelLarge).foregroundStyle(palette.accent).frame(minHeight: 44)
            }
        } else {
            Text("Requesting camera access…").font(KioskType.bodyMedium).foregroundStyle(Color.white.opacity(0.8))
        }
    }

    private var controlsRow: some View {
        HStack {
            roundButton("Library", systemImage: "photo.on.rectangle", label: "Choose photo", action: onLibrary)
            Spacer()
            Button(action: shoot) {
                ZStack {
                    Circle().fill(Color.white).frame(width: 66, height: 66)
                    Circle().stroke(Color.white.opacity(0.35), lineWidth: 4).frame(width: 76, height: 76)
                    if capturing { ProgressView().tint(Color.black) }
                }
                .frame(width: 80, height: 80)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .accessibilityLabel("Take photo")
            .accessibilityIdentifier("photo-shutter")
            Spacer()
            if canFlip {
                roundButton("Flip", systemImage: "arrow.triangle.2.circlepath.camera", label: "Flip camera") { front.toggle() }
            } else {
                Color.clear.frame(width: 64, height: 64)
            }
        }
        .frame(maxWidth: 420)
    }

    private func roundButton(_ title: String, systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.white)
                    .frame(width: 46, height: 46)
                    .background(Color.white.opacity(0.14), in: Circle())
                Text(title).font(KioskType.sans(12, .semibold)).foregroundStyle(Color.white)
            }
            .frame(minWidth: 64, minHeight: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel(label)
    }

    private func shoot() {
        guard !busy else { return }
        capturing = true
        failure = nil
        Task {
            do {
                let data = try await camera.capture()
                capturing = false
                onCapture(data)
            } catch {
                capturing = false
                if !(error is CancellationError) { failure = RolodexModel.errorText(code: nil) }
            }
        }
    }

    private func prepare() async {
        isActive = true
        guard hasCamera else { return }
        if status == .notDetermined {
            let ok = await AVCaptureDevice.requestAccess(for: .video)
            // The screen may have closed while the system prompt was up.
            if Task.isCancelled || !isActive { return }
            status = ok ? .authorized : .denied
        }
        startIfAllowed()
    }

    private func startIfAllowed() {
        guard hasCamera, CameraStartGate.canStart(status: status, isActive: isActive) else { return }
        camera.onError = { message in failure = message }
        camera.start(front: useFront)
    }
}

extension PhotoCaptureView where Footer == EmptyView {
    init(backTitle: String, onBack: @escaping () -> Void, front: Binding<Bool>, busyText: String?, errorText: String?,
         onCapture: @escaping (Data) -> Void, onLibrary: @escaping () -> Void) {
        self.init(backTitle: backTitle, onBack: onBack, front: front, busyText: busyText, errorText: errorText,
                  onCapture: onCapture, onLibrary: onLibrary, footer: { EmptyView() })
    }
}
