import CoreImage
import UIKit

/// QR codes from Core Image (Android `Qr.kt` used ZXing): correction level M,
/// each module `scale` pixels, nearest-neighbor so the edges stay sharp.
enum Qr {
    private static let context = CIContext()

    static func image(for text: String, scale: CGFloat) -> UIImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let modules = filter.outputImage else { return nil }
        // Scaling the CIImage by an integer transform samples nearest-neighbor.
        let scaled = modules.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
