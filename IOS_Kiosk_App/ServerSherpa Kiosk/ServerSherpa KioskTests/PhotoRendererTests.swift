import CoreGraphics
import Foundation
import ImageIO
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import ServerSherpa_Kiosk

// MARK: - Test images

/// An RGBA image `width`×`height` that `paint` draws (CG coordinates: y up).
func photoTestImage(width: Int, height: Int, paint: (CGContext) -> Void) -> CGImage {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    paint(ctx)
    return ctx.makeImage()!
}

/// `image` as a file: JPEG (with an EXIF orientation when given) or PNG.
func photoTestFile(_ image: CGImage, png: Bool = false, orientation: Int? = nil) -> Data {
    let out = NSMutableData()
    let type = (png ? UTType.png : UTType.jpeg).identifier as CFString
    let dest = CGImageDestinationCreateWithData(out, type, 1, nil)!
    var props: [CFString: Any] = [:]
    if let orientation { props[kCGImagePropertyOrientation] = orientation }
    if !png { props[kCGImageDestinationLossyCompressionQuality] = 0.9 }
    CGImageDestinationAddImage(dest, image, props as CFDictionary)
    CGImageDestinationFinalize(dest)
    return out as Data
}

/// A plain JPEG of `width`×`height`, for the flows (a "capture" or a "library pick").
func photoTestJpeg(width: Int = 640, height: Int = 480) -> Data {
    photoTestFile(photoTestImage(width: width, height: height) { ctx in
        ctx.setFillColor(red: 0.2, green: 0.4, blue: 0.7, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    })
}

/// A decoded file's size and its pixel at (`x`, `y`) from the top-left, as 0–255 RGB.
struct PhotoTestPixels {
    let width: Int
    let height: Int
    private let bytes: [UInt8]

    init(_ file: Data) throws {
        let source = try #require(CGImageSourceCreateWithData(file as CFData, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        width = image.width
        height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        bytes.withUnsafeMutableBytes { raw in
            let ctx = CGContext(data: raw.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                                bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        self.bytes = bytes
    }

    /// (r, g, b) at column `x`, row `y` (row 0 is the top).
    func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let i = (y * width + x) * 4
        return (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
    }

    func isWhite(_ x: Int, _ y: Int) -> Bool { let (r, g, b) = rgb(x, y); return r > 245 && g > 245 && b > 245 }
    func isRed(_ x: Int, _ y: Int) -> Bool { let (r, g, b) = rgb(x, y); return r > 200 && g < 60 && b < 60 }
    func isBlue(_ x: Int, _ y: Int) -> Bool { let (r, g, b) = rgb(x, y); return r < 60 && g < 60 && b > 200 }
}

/// Raw pixels: the left half red, the right half blue.
private func redLeftBlueRight(width: Int, height: Int) -> CGImage {
    photoTestImage(width: width, height: height) { ctx in
        ctx.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
        ctx.setFillColor(red: 0, green: 0, blue: 1, alpha: 1)
        ctx.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
    }
}

// MARK: - The renderer

/// Review Focus 2 (Android PhotoRenderTest): a huge, rotated or transparent picture becomes an
/// upright 512×512 JPEG on white under 5 MiB.
struct PhotoRendererTests {
    @Test func aHugeSourceRenders512Under5MiB() throws {
        let big = photoTestImage(width: 4000, height: 3000) { ctx in
            let colors = [CGColor(red: 0.9, green: 0.3, blue: 0.1, alpha: 1), CGColor(red: 0.1, green: 0.5, blue: 0.9, alpha: 1)] as CFArray
            let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors, locations: nil)!
            ctx.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 4000, y: 3000), options: [])
            for i in stride(from: 0, to: 4000, by: 37) {   // detail, so the JPEG isn't trivially small
                ctx.setFillColor(gray: Double(i % 255) / 255, alpha: 1)
                ctx.fill(CGRect(x: i, y: (i * 7) % 3000, width: 23, height: 400))
            }
        }
        let jpeg = PhotoRenderer.render(big, v: 300, z: 1, dx: 0, dy: 0)
        #expect(jpeg.prefix(2) == Data([0xFF, 0xD8]))
        #expect(jpeg.count < 5 * 1024 * 1024)
        let pixels = try PhotoTestPixels(jpeg)
        #expect(pixels.width == 512 && pixels.height == 512)

        // and through the loader, as a 12 MP library photo arrives: shrunk to 2048 first
        let loaded = try #require(PhotoRenderer.load(data: photoTestFile(big)))
        #expect(loaded.width == 2048 && loaded.height == 1536)
        let fromFile = try PhotoTestPixels(PhotoRenderer.render(loaded, v: 1, z: 2.5, dx: 0.3, dy: -0.2))
        #expect(fromFile.width == 512 && fromFile.height == 512)
    }

    @Test func aTransparentPngRendersWhiteWhereTransparent() throws {
        // a third clear, a third half-transparent red, a third opaque red
        let png = photoTestFile(photoTestImage(width: 300, height: 300) { ctx in
            ctx.clear(CGRect(x: 0, y: 0, width: 300, height: 300))
            ctx.setFillColor(red: 1, green: 0, blue: 0, alpha: 0.5)
            ctx.fill(CGRect(x: 100, y: 0, width: 100, height: 300))
            ctx.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
            ctx.fill(CGRect(x: 200, y: 0, width: 100, height: 300))
        }, png: true)
        let image = try #require(PhotoRenderer.load(data: png))
        let pixels = try PhotoTestPixels(PhotoRenderer.render(image, v: 1, z: 1, dx: 0, dy: 0))
        #expect(pixels.width == 512 && pixels.height == 512)
        #expect(pixels.isWhite(85, 256))
        #expect(pixels.isWhite(20, 20))
        // half-transparent red on white is pink (on an unpainted, black page it would be dark red)
        let (r, g, b) = pixels.rgb(256, 256)
        #expect(r > 235 && (100...160).contains(g) && (100...160).contains(b))
        #expect(pixels.isRed(430, 256))

        // ImageIO's decode above already mattes clear pixels; a picture with real (premultiplied)
        // transparency handed straight to the renderer needs its white page too
        let direct = photoTestImage(width: 200, height: 200) { ctx in
            ctx.clear(CGRect(x: 0, y: 0, width: 200, height: 200))
            ctx.setFillColor(red: 1, green: 0, blue: 0, alpha: 0.5)
            ctx.fill(CGRect(x: 100, y: 0, width: 100, height: 200))
        }
        let painted = try PhotoTestPixels(PhotoRenderer.render(direct, v: 1, z: 1, dx: 0, dy: 0))
        #expect(painted.isWhite(100, 256))
        let (r2, g2, b2) = painted.rgb(400, 256)
        #expect(r2 > 235 && (100...160).contains(g2) && (100...160).contains(b2))
    }

    /// EXIF orientation 6 (`.right`, how an iPhone stores a portrait photo): raw pixels red on
    /// the left, blue on the right, which shows upright as red on top, blue below.
    @Test func aRightOrientedImageRendersUpright() throws {
        let file = photoTestFile(redLeftBlueRight(width: 200, height: 100), orientation: 6)
        let image = try #require(PhotoRenderer.load(data: file))
        #expect(image.width == 100 && image.height == 200)   // upright: portrait, never upscaled
        let pixels = try PhotoTestPixels(PhotoRenderer.render(image, v: 1, z: 1, dx: 0, dy: 0))
        #expect(pixels.width == 512 && pixels.height == 512)
        #expect(pixels.isRed(256, 80))
        #expect(pixels.isBlue(256, 430))
    }

    /// The offset picks the part of the picture the circle shows: moved all the way right, the
    /// left square of a 2:1 picture.
    @Test func theOffsetPicksThePartTheCircleShows() throws {
        let image = redLeftBlueRight(width: 400, height: 200)
        let left = try PhotoTestPixels(PhotoRenderer.render(image, v: 1, z: 1, dx: 5, dy: 0))   // clamped to 0.5
        #expect(left.isRed(30, 256) && left.isRed(480, 256))
        let right = try PhotoTestPixels(PhotoRenderer.render(image, v: 300, z: 1, dx: -150, dy: 0))
        #expect(right.isBlue(30, 256) && right.isBlue(480, 256))
    }

    @Test func somethingThatIsNotAnImageLoadsNothing() {
        #expect(PhotoRenderer.load(data: Data("not a photo".utf8)) == nil)
        #expect(PhotoRenderer.load(data: Data()) == nil)
    }
}

// MARK: - Position your photo

/// The crop screen's state (drag, pinch, slider), kept in a model so a rebuild keeps it.
@MainActor
struct RolodexCropTests {
    private func near(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 1e-9 }

    @Test func zoomStaysBetweenOneAndFourAndTheImageAlwaysCoversTheCircle() throws {
        let crop = RolodexCrop(image: redLeftBlueRight(width: 400, height: 200))
        #expect(crop.zoom == 1 && crop.offsetX == 0 && crop.offsetY == 0)
        crop.setZoom(7)
        #expect(crop.zoom == 4)
        crop.setZoom(0.2)
        #expect(crop.zoom == 1)

        // a drag in points, against a 300 pt circle: held so the picture covers it
        crop.drag(x: 1000, y: 40, viewport: 300)
        #expect(near(crop.offsetX, 0.5) && near(crop.offsetY, 0))
        crop.endDrag()
        crop.drag(x: -60, y: 0, viewport: 300)   // from where the last drag ended
        #expect(near(crop.offsetX, 0.3))
        crop.endDrag()

        // zooming in frees the vertical axis; zooming back out pulls the offset back in
        crop.setZoom(2)
        crop.drag(x: 0, y: -600, viewport: 300)
        crop.endDrag()
        #expect(near(crop.offsetY, -0.5))
        crop.setZoom(1)
        #expect(near(crop.offsetY, 0) && near(crop.offsetX, 0.3))

        // a pinch scales the zoom it started from
        crop.pinch(1.5)
        crop.pinch(3)
        #expect(crop.zoom == 3)
        crop.endPinch()
        crop.pinch(2)
        #expect(crop.zoom == 4)
    }

    @Test func theImageIsLaidOutCoverFitTimesTheZoom() {
        let crop = RolodexCrop(image: redLeftBlueRight(width: 400, height: 200))
        let fit = crop.displaySize(viewport: 300)
        #expect(fit.width == 600 && fit.height == 300)
        crop.setZoom(2)
        #expect(crop.displaySize(viewport: 300).width == 1200)
    }

    @Test func theJpegIsWhatTheCircleShows() async throws {
        let crop = RolodexCrop(image: redLeftBlueRight(width: 400, height: 200))
        crop.drag(x: 1000, y: 0, viewport: 300)
        let pixels = try PhotoTestPixels(await crop.jpeg())
        #expect(pixels.width == 512 && pixels.isRed(480, 256))
    }

    @Test func aPictureIsDecodedForTheCropAndJunkIsRefused() async throws {
        let crop = try #require(await RolodexCrop.make(from: photoTestFile(redLeftBlueRight(width: 200, height: 100), orientation: 6)))
        #expect(crop.image.width == 100 && crop.image.height == 200)
        #expect(await RolodexCrop.make(from: Data("junk".utf8)) == nil)
    }
}
