import CoreGraphics
import Foundation
import ImageIO
import UIKit

/// Turns a capture or a library pick into the photo the Rolodex uploads (spec §4.2): a 512×512
/// JPEG at quality 0.92, painted white first (a transparent PNG comes out white, not black), with
/// the EXIF orientation applied. Both functions are pure and thread-safe: callers run them off
/// the main actor (a 48 MP picture takes a moment).
enum PhotoRenderer {
    /// The picture in `data` (JPEG, HEIC, PNG…), upright (EXIF orientation applied) and shrunk so
    /// its long side is at most `maxSide` pixels (never enlarged). Nil when it isn't an image.
    static func load(data: Data, maxSide: Int = 2048) -> CGImage? {
        guard !data.isEmpty,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) > 0 else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxSide,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              image.width > 0, image.height > 0 else { return nil }
        return image
    }

    /// The part of `image` a square viewport of side `v` shows at zoom `z` (1–4 over cover-fit)
    /// and offset (`dx`, `dy`) = image center minus viewport center, in the viewport's units
    /// (`PhotoCropMath`; the offset is clamped so the picture covers the square), as a 512×512
    /// JPEG at quality 0.92 on white. `image` is upright (from `load`).
    static func render(_ image: CGImage, v: Double, z: Double, dx: Double, dy: Double) -> Data {
        let w = Double(image.width), h = Double(image.height)
        let out = Double(PhotoCropMath.outputPx)
        let src = PhotoCropMath.sourceRect(w: w, h: h, v: v, z: z, dx: dx, dy: dy)
        // The whole picture, scaled so the source square fills the output.
        let k = out / src.side
        let dest = CGRect(x: -src.x * k, y: -src.y * k, width: w * k, height: h * k)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1        // 512 pixels, not 512 points (1024 or 1536 px on a Retina device)
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: out, height: out), format: format)
        return renderer.jpegData(withCompressionQuality: PhotoCropMath.jpegQuality) { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: out, height: out))
            ctx.cgContext.interpolationQuality = .high
            UIImage(cgImage: image).draw(in: dest)
        }
    }
}
