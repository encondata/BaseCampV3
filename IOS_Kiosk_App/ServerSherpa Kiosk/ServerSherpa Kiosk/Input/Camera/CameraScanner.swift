import AVFoundation
import UIKit

/// What the device's cameras can do. All false on the simulator.
enum CameraSupport {
    private static func device(_ position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
    }
    static var hasBackCamera: Bool { device(.back) != nil }
    static var hasFrontCamera: Bool { device(.front) != nil }
    static var hasCamera: Bool { hasBackCamera || hasFrontCamera }
    static var hasTorch: Bool { device(.back)?.hasTorch ?? false }
}

/// Owns the `AVCaptureSession`. Invariant: the session (and the device lock)
/// is touched only on `queue`; metadata is delivered on the main queue, where
/// `onCode` runs. Frames are never stored.
final class CameraScanner: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.serversherpa.kiosk.camera")
    private let session = AVCaptureSession()
    private var device: AVCaptureDevice?
    private var configured: AVCaptureDevice.Position?

    /// (value, symbology). Called on the main actor.
    var onCode: (@MainActor (String, String) -> Void)?

    let previewLayer: AVCaptureVideoPreviewLayer

    override init() {
        previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        super.init()
    }

    private static let symbologies: [AVMetadataObject.ObjectType] = [
        .qr, .code128, .code39, .code39Mod43, .code93, .ean8, .ean13, .upce,
        .itf14, .interleaved2of5, .codabar, .pdf417, .dataMatrix, .aztec,
    ]

    func start(position: CameraPosition) {
        let wanted: AVCaptureDevice.Position = position == .front ? .front : .back
        queue.async { [self] in
            if configured != wanted { configure(wanted) }
            if configured != nil, !session.isRunning { session.startRunning() }
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning { session.stopRunning() }
            if let device, device.torchMode != .off, (try? device.lockForConfiguration()) != nil {
                device.torchMode = .off
                device.unlockForConfiguration()
            }
        }
    }

    func setTorch(_ on: Bool) {
        queue.async { [self] in
            guard let device, device.position == .back, device.hasTorch,
                  (try? device.lockForConfiguration()) != nil else { return }
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        }
    }

    /// Runs on `queue`.
    private func configure(_ position: AVCaptureDevice.Position) {
        guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
              let input = try? AVCaptureDeviceInput(device: cam) else { return }
        session.beginConfiguration()
        session.inputs.forEach { session.removeInput($0) }
        session.outputs.forEach { session.removeOutput($0) }
        guard session.canAddInput(input) else { session.commitConfiguration(); return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { session.commitConfiguration(); return }
        session.addOutput(output)
        // Only types the output offers: setting an unavailable one throws an ObjC exception.
        let available = Set(output.availableMetadataObjectTypes)
        output.metadataObjectTypes = Self.symbologies.filter(available.contains)
        output.setMetadataObjectsDelegate(self, queue: .main)
        session.commitConfiguration()
        device = cam
        configured = position
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        // Delivered on the main queue (see configure).
        for object in metadataObjects {
            guard let code = object as? AVMetadataMachineReadableCodeObject,
                  let value = code.stringValue else { continue }
            let symbology = Self.name(code.type)
            MainActor.assumeIsolated { onCode?(value, symbology) }
        }
    }

    /// The Android kiosk's symbology names.
    static func name(_ type: AVMetadataObject.ObjectType) -> String {
        switch type {
        case .qr: "QR_CODE"
        case .code128: "CODE128"
        case .code39, .code39Mod43: "CODE39"
        case .code93: "CODE93"
        case .ean13: "EAN13"
        case .ean8: "EAN8"
        case .upce: "UPCE"
        case .dataMatrix: "DATAMATRIX"
        case .pdf417: "PDF417"
        case .aztec: "AZTEC"
        case .itf14, .interleaved2of5: "ITF"
        case .codabar: "CODABAR"
        default: type.rawValue
        }
    }
}
