import AVFoundation
import SwiftUI
import UIKit

private enum CameraMode: String, CaseIterable, Identifiable {
    case single = "Single", multi = "Multi"
    var id: Self { self }
}

/// Hosts the camera preview; the layer is the view's own, so it resizes with the view.
/// Keeps the preview upright through a RotationCoordinator for the current camera.
private struct CameraPreview: UIViewRepresentable {
    let scanner: CameraScanner

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        private var coordinator: AVCaptureDevice.RotationCoordinator?
        private var observation: NSKeyValueObservation?

        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

        /// Recreated on every camera change (flip).
        func attach(_ device: AVCaptureDevice) {
            let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
            self.coordinator = coordinator
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
        view.previewLayer.session = scanner.session
        view.previewLayer.videoGravity = .resizeAspectFill
        scanner.onDevice = { [weak view] device in view?.attach(device) }
        if let device = scanner.activeDevice { view.attach(device) }
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}

/// The camera scanner, full screen. Single publishes the first barcode and
/// closes; Multi publishes each distinct barcode once and stays open until
/// Done. Frames are never stored.
struct CameraScanSheet: View {
    let bus: ScanBus
    let prefs: KioskPrefs
    let onClose: () -> Void

    @State private var mode: CameraMode = .single
    @State private var status = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var torch = false
    @State private var scanner = CameraScanner()
    @State private var session = MultiReadSession()
    @State private var count = 0
    @State private var recent: [String] = []
    @State private var finished = false
    @State private var isActive = false
    @State private var failure: String?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.kioskAccent) private var accent

    init(bus: ScanBus, prefs: KioskPrefs, onClose: @escaping () -> Void) {
        self.bus = bus
        self.prefs = prefs
        self.onClose = onClose
    }

    private var granted: Bool { status == .authorized }
    private var showTorch: Bool { CameraSupport.hasTorch && prefs.cameraPosition == .back }
    private var canFlip: Bool { CameraSupport.hasFrontCamera && CameraSupport.hasBackCamera }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if granted {
                CameraPreview(scanner: scanner).ignoresSafeArea()
                GeometryReader { geo in
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(accent, lineWidth: 2)
                        .frame(width: geo.size.width * 0.7, height: geo.size.width * 0.7)
                        .position(x: geo.size.width / 2, y: geo.size.height / 2)
                }
                .allowsHitTesting(false)
                if let failure {
                    Text(failure).foregroundStyle(.white).padding(24)
                }
            } else {
                permissionMessage
            }
            VStack(spacing: 0) {
                topBar
                Spacer()
                bottomPanel
            }
        }
        .task { await prepare() }
        .onChange(of: prefs.cameraPosition) { _, position in
            torch = false
            if CameraStartGate.canStart(status: status, isActive: isActive) { scanner.start(position: position) }
        }
        .onChange(of: torch) { _, on in scanner.setTorch(on) }
        .onChange(of: scenePhase) { _, phase in
            // Granting in Settings should work without reopening the sheet.
            guard phase == .active, isActive, status != .authorized else { return }
            status = AVCaptureDevice.authorizationStatus(for: .video)
            startIfAllowed()
        }
        .onDisappear {
            isActive = false
            scanner.onCode = nil
            scanner.onError = nil
            scanner.onDevice = nil
            scanner.stop()
        }
    }

    @ViewBuilder private var permissionMessage: some View {
        VStack(spacing: 12) {
            if status == .denied || status == .restricted {
                Text("Camera access is off. Allow it in Settings to scan with the camera.")
                    .multilineTextAlignment(.center)
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .buttonStyle(.borderedProminent)
            } else {
                Text("Requesting camera access…")
            }
        }
        .foregroundStyle(.white)
        .padding(24)
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button("Close", action: onClose)
                .buttonStyle(.bordered).tint(.white)
            Spacer()
            if granted && showTorch {
                Toggle(isOn: $torch) { Image(systemName: torch ? "flashlight.on.fill" : "flashlight.off.fill") }
                    .toggleStyle(.button).tint(accent)
                    .accessibilityLabel(torch ? "Torch on" : "Torch off")
            }
            if granted && canFlip {
                Button {
                    prefs.cameraPosition = prefs.cameraPosition == .back ? .front : .back
                } label: { Image(systemName: "camera.rotate") }
                    .buttonStyle(.bordered).tint(.white)
                    .accessibilityLabel("Flip camera")
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    private var bottomPanel: some View {
        VStack(spacing: 10) {
            Segmented(options: CameraMode.allCases.map { ($0, $0.rawValue) }, selection: $mode)
            if mode == .multi {
                HStack(spacing: 8) {
                    Text("\(count) scanned")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(accent, in: Capsule())
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(recent, id: \.self) { value in
                                Text(value)
                                    .font(.system(size: 12, design: .monospaced))
                                    .lineLimit(1)
                                    .foregroundStyle(Color(white: 0.9))
                                    .padding(.horizontal, 10).padding(.vertical, 5)
                                    .background(Color.white.opacity(0.13), in: Capsule())
                                    .overlay(Capsule().stroke(Color.white.opacity(0.2), lineWidth: 1))
                            }
                        }
                    }
                }
                .frame(height: 40)
            }
            Button(action: onClose) {
                Text(mode == .multi ? "Done" : "Close").frame(maxWidth: .infinity, minHeight: 36)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Color(red: 0.05, green: 0.07, blue: 0.09).opacity(0.9))
    }

    private func prepare() async {
        isActive = true
        if status == .notDetermined {
            let ok = await AVCaptureDevice.requestAccess(for: .video)
            // The sheet may have closed while the system prompt was up.
            if Task.isCancelled || !isActive { return }
            status = ok ? .authorized : .denied
        }
        startIfAllowed()
    }

    private func startIfAllowed() {
        guard CameraStartGate.canStart(status: status, isActive: isActive) else { return }
        scanner.onCode = { value, symbology in handle(value, symbology) }
        scanner.onError = { message in failure = message }
        scanner.start(position: prefs.cameraPosition)
    }

    private func handle(_ value: String, _ symbology: String) {
        if finished || !session.offer(value) { return }
        bus.publish(ScanEvent(value: value, source: .camera, symbology: symbology))
        if mode == .single {
            finished = true
            onClose()
        } else {
            count = session.count
            recent = session.recent
        }
    }
}
