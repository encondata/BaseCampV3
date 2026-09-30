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

/// When the camera may be started: permission granted and the sheet still on screen.
enum CameraStartGate {
    static func canStart(status: AVAuthorizationStatus, isActive: Bool) -> Bool {
        status == .authorized && isActive
    }
}

/// Owns the `AVCaptureSession`. Invariant: the session (and the device lock)
/// is touched only on `queue`; metadata is delivered on the main queue, where
/// `onCode` runs. Frames are never stored.
final class CameraScanner: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    static let startFailureMessage = "Couldn't start the camera on this device."

    private let queue = DispatchQueue(label: "com.serversherpa.kiosk.camera")
    let session = AVCaptureSession()
    private var device: AVCaptureDevice?
    private var configured: AVCaptureDevice.Position?

    /// (value, symbology). Called on the main actor.
    var onCode: (@MainActor (String, String) -> Void)?
    /// Called on the main actor when the camera can't be set up.
    var onError: (@MainActor (String) -> Void)?
    /// Called on the main actor each time a camera becomes the session's input.
    var onDevice: (@MainActor (AVCaptureDevice) -> Void)?
    /// The current input camera. Main actor only.
    private(set) var activeDevice: AVCaptureDevice?

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
            Self.torchOff(device)
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

    private static func torchOff(_ device: AVCaptureDevice?) {
        guard let device, device.hasTorch, device.torchMode != .off,
              (try? device.lockForConfiguration()) != nil else { return }
        device.torchMode = .off
        device.unlockForConfiguration()
    }

    private func fail() {
        DispatchQueue.main.async { [self] in
            MainActor.assumeIsolated { onError?(Self.startFailureMessage) }
        }
    }

    /// Runs on `queue`. All or nothing: on failure the previous inputs and
    /// outputs are restored and `configured` is left as it was.
    private func configure(_ position: AVCaptureDevice.Position) {
        guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
              let input = try? AVCaptureDeviceInput(device: cam) else { fail(); return }
        Self.torchOff(device)
        let oldInputs = session.inputs, oldOutputs = session.outputs
        session.beginConfiguration()
        oldInputs.forEach { session.removeInput($0) }
        oldOutputs.forEach { session.removeOutput($0) }
        let output = AVCaptureMetadataOutput()
        guard session.canAddInput(input), session.canAddOutput(output) else {
            oldInputs.filter(session.canAddInput).forEach { session.addInput($0) }
            oldOutputs.filter(session.canAddOutput).forEach { session.addOutput($0) }
            session.commitConfiguration()
            fail()
            return
        }
        session.addInput(input)
        session.addOutput(output)
        // Only types the output offers: setting an unavailable one throws an ObjC exception.
        let available = Set(output.availableMetadataObjectTypes)
        output.metadataObjectTypes = Self.symbologies.filter(available.contains)
        output.setMetadataObjectsDelegate(self, queue: .main)
        session.commitConfiguration()
        device = cam
        configured = position
        DispatchQueue.main.async { [self] in
            MainActor.assumeIsolated {
                activeDevice = cam
                onDevice?(cam)
            }
        }
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
