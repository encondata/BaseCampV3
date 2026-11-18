import AVFoundation
import Testing
@testable import ServerSherpa_Kiosk

/// The camera's QR-only mode (Android `CameraScanSheet(qrOnly = true)`, the sign-in screen's move
/// password) next to Single and Multi, which read every symbology the kiosk knows.
struct CameraReadTypesTests {
    private static let everySymbology: [AVMetadataObject.ObjectType] = [
        .qr, .code128, .code39, .code39Mod43, .code93, .ean8, .ean13, .upce,
        .itf14, .interleaved2of5, .codabar, .pdf417, .dataMatrix, .aztec,
    ]

    @Test func qrOnlyModeIgnoresOtherSymbologies() {
        #expect(CameraScanner.readTypes(qrOnly: true) == [.qr])
        #expect(CameraScanner.accepts(.qr, qrOnly: true))
        for type in Self.everySymbology where type != .qr {
            #expect(!CameraScanner.accepts(type, qrOnly: true), "\(type.rawValue) read in QR-only mode")
        }
    }

    /// Single and Multi are unchanged: the same symbologies, all accepted.
    @Test func singleAndMultiStillReadEverySymbology() {
        #expect(CameraScanner.readTypes(qrOnly: false) == Self.everySymbology)
        for type in Self.everySymbology {
            #expect(CameraScanner.accepts(type, qrOnly: false))
        }
    }

    @Test func aScannerKeepsTheModeItWasMadeWith() {
        #expect(CameraScanner(qrOnly: true).qrOnly)
        #expect(!CameraScanner().qrOnly)
    }
}
