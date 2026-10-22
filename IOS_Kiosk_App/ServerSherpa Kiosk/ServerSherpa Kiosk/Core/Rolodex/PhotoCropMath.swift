import Foundation

/// "Position your photo": a `w`×`h` image under a square viewport of side `v`, zoomed
/// `z` (1×–4×) over cover-fit and offset by (`dx`, `dy`) = image center minus viewport
/// center, in viewport points. The portal's ImageCropModal math; Android `Crop` has the same.
enum PhotoCropMath {
    /// The uploaded photo is `outputPx`×`outputPx`.
    static let outputPx = 512
    static let jpegQuality = 0.92
    static let minZoom: Double = 1
    static let maxZoom: Double = 4

    /// `z` held to 1–4 (NaN reads as 1).
    static func clampZoom(_ z: Double) -> Double { z.isNaN ? minZoom : min(max(z, minZoom), maxZoom) }

    /// Viewport points per image pixel: cover-fit times the (clamped) zoom.
    static func scale(w: Double, h: Double, v: Double, z: Double) -> Double {
        max(v / w, v / h) * clampZoom(z)
    }

    /// The offset pulled back so the image always covers the viewport.
    static func clampOffset(w: Double, h: Double, v: Double, z: Double, dx: Double, dy: Double) -> (Double, Double) {
        let s = scale(w: w, h: h, v: v, z: z)
        let limitX = max(0, (w * s - v) / 2)
        let limitY = max(0, (h * s - v) / 2)
        return (min(max(dx, -limitX), limitX), min(max(dy, -limitY), limitY))
    }

    /// The square of the image (in image pixels) the viewport shows, after clamping the offset.
    static func sourceRect(w: Double, h: Double, v: Double, z: Double, dx: Double, dy: Double) -> (x: Double, y: Double, side: Double) {
        let s = scale(w: w, h: h, v: v, z: z)
        let (cx, cy) = clampOffset(w: w, h: h, v: v, z: z, dx: dx, dy: dy)
        let side = v / s
        return (w / 2 - cx / s - side / 2, h / 2 - cy / s - side / 2, side)
    }
}
