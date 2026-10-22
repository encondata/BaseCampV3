import AVFoundation
import Foundation
import UIKit

enum PhotoCameraError: Error, Equatable {
    /// The camera isn't running (not started yet, or stopped).
    case notRunning
    /// The capture finished without a picture.
    case noPhoto
}

/// The Rolodex's photo camera (worker photos), separate from the barcode scanner
/// (`CameraScanner`, whose session holds only a metadata output). Starts on whichever camera the
/// caller asks for: the Rolodex starts on the back one, since the admin holds the device.
///
/// Invariant (as the scanner's): the `AVCaptureSession`, its inputs and outputs, and the waiting
/// captures are touched only on `queue`. Callbacks reach the main actor through
/// `MainActor.assumeIsolated` on the main queue. Pictures are handed to the caller, never kept.
final class PhotoCamera: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    static let startFailureMessage = CameraScanner.startFailureMessage

    private let queue = DispatchQueue(label: "com.serversherpa.kiosk.photo-camera")
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    /// The camera the session is set up with (queue only).
    private var configured: AVCaptureDevice.Position?
    /// Captures waiting for their picture, by settings id (queue only).
    private var waiting: [Int64: CheckedContinuation<Data, Error>] = [:]

    /// Called on the main actor when the camera can't be set up.
    var onError: (@MainActor (String) -> Void)?
    /// Called on the main actor each time a camera becomes the session's input.
    var onDevice: (@MainActor (AVCaptureDevice) -> Void)?
    /// The current input camera. Main actor only.
    private(set) var activeDevice: AVCaptureDevice?
    /// The preview's rotation coordinator: each capture is turned to the horizon it gives.
    /// Main actor only.
    var rotation: AVCaptureDevice.RotationCoordinator?

    func start(front: Bool) {
        let wanted: AVCaptureDevice.Position = front ? .front : .back
        queue.async { [self] in
            if configured != wanted { configure(wanted) }
            if configured != nil, !session.isRunning { session.startRunning() }
        }
    }

    /// Stops the session; a capture still waiting ends with a cancel.
    func stop() {
        queue.async { [self] in
            if session.isRunning { session.stopRunning() }
            let pending = waiting
            waiting = [:]
            pending.values.forEach { $0.resume(throwing: CancellationError()) }
        }
    }

    /// Takes a picture with the running camera: the file's bytes (HEIC or JPEG, with its
    /// orientation in the metadata).
    @MainActor func capture() async throws -> Data {
        let angle = rotation?.videoRotationAngleForHorizonLevelCapture
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            queue.async { [self] in
                guard session.isRunning, let connection = output.connection(with: .video), connection.isEnabled, connection.isActive else {
                    continuation.resume(throwing: PhotoCameraError.notRunning)
                    return
                }
                if let angle, connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
                let settings = AVCapturePhotoSettings()
                waiting[settings.uniqueID] = continuation
                output.capturePhoto(with: settings, delegate: self)
            }
        }
    }

    private func fail() {
        DispatchQueue.main.async { [self] in
            MainActor.assumeIsolated { onError?(Self.startFailureMessage) }
        }
    }

    /// Runs on `queue`. All or nothing: on failure the previous input is restored and
    /// `configured` is left as it was.
    private func configure(_ position: AVCaptureDevice.Position) {
        guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
              let input = try? AVCaptureDeviceInput(device: cam) else { fail(); return }
        let oldInputs = session.inputs
        session.beginConfiguration()
        if session.canSetSessionPreset(.photo) { session.sessionPreset = .photo }
        oldInputs.forEach { session.removeInput($0) }
        let needsOutput = !session.outputs.contains(output)
        guard session.canAddInput(input), !needsOutput || session.canAddOutput(output) else {
            oldInputs.filter(session.canAddInput).forEach { session.addInput($0) }
            session.commitConfiguration()
            fail()
            return
        }
        session.addInput(input)
        if needsOutput { session.addOutput(output) }
        output.maxPhotoQualityPrioritization = .balanced
        session.commitConfiguration()
        configured = position
        DispatchQueue.main.async { [self] in
            MainActor.assumeIsolated {
                activeDevice = cam
                onDevice?(cam)
            }
        }
    }

    // MARK: AVCapturePhotoCaptureDelegate (called on AVFoundation's own queue)

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let id = photo.resolvedSettings.uniqueID
        let data = error == nil ? photo.fileDataRepresentation() : nil
        queue.async { [self] in
            guard let continuation = waiting.removeValue(forKey: id) else { return }
            if let data { continuation.resume(returning: data) } else { continuation.resume(throwing: error ?? PhotoCameraError.noPhoto) }
        }
    }

    /// Always called last: ends a capture that never delivered a picture.
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        let id = resolvedSettings.uniqueID
        queue.async { [self] in
            waiting.removeValue(forKey: id)?.resume(throwing: error ?? PhotoCameraError.noPhoto)
        }
    }
}
