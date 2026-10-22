import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// The four pinned vectors from the plan's Global Constraints (Android CropTest has the same).
struct PhotoCropMathTests {
    private func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 1e-9 }

    @Test func outputIsA512JpegAtQuality092WithZoomOneToFour() {
        #expect(PhotoCropMath.outputPx == 512)
        #expect(PhotoCropMath.jpegQuality == 0.92)
        #expect(PhotoCropMath.minZoom == 1)
        #expect(PhotoCropMath.maxZoom == 4)
    }

    @Test func centeredCoverFitTakesTheMiddleSquare() {
        let r = PhotoCropMath.sourceRect(w: 1000, h: 500, v: 300, z: 1, dx: 0, dy: 0)
        #expect(close(r.x, 250)); #expect(close(r.y, 0)); #expect(close(r.side, 500))
    }

    @Test func offsetIsClampedSoTheImageCoversTheViewport() {
        let (dx, dy) = PhotoCropMath.clampOffset(w: 1000, h: 500, v: 300, z: 1, dx: 400, dy: 50)
        #expect(close(dx, 150)); #expect(close(dy, 0))
        let (nx, ny) = PhotoCropMath.clampOffset(w: 1000, h: 500, v: 300, z: 1, dx: -400, dy: -50)
        #expect(close(nx, -150)); #expect(close(ny, 0))
    }

    @Test func zoomTwoTakesHalfTheSide() {
        let r = PhotoCropMath.sourceRect(w: 1000, h: 500, v: 300, z: 2, dx: 0, dy: 0)
        #expect(close(r.x, 375)); #expect(close(r.y, 125)); #expect(close(r.side, 250))
    }

    @Test func zoomClampsToOneThroughFour() {
        #expect(PhotoCropMath.clampZoom(7) == 4)
        #expect(PhotoCropMath.clampZoom(0.5) == 1)
        #expect(PhotoCropMath.clampZoom(2.5) == 2.5)
        #expect(PhotoCropMath.clampZoom(.nan) == 1)
        #expect(close(PhotoCropMath.scale(w: 1000, h: 500, v: 300, z: 7), PhotoCropMath.scale(w: 1000, h: 500, v: 300, z: 4)))
    }

    @Test func scaleIsCoverFitTimesZoom() {
        #expect(close(PhotoCropMath.scale(w: 1000, h: 500, v: 300, z: 1), 0.6))    // landscape: height fills
        #expect(close(PhotoCropMath.scale(w: 500, h: 1000, v: 300, z: 1), 0.6))    // portrait: width fills
        #expect(close(PhotoCropMath.scale(w: 1000, h: 500, v: 300, z: 2), 1.2))
    }

    @Test func sourceRectStaysInsideTheImageAtAnExtremePan() {
        // An over-large pan is clamped first: the square ends at the image's left edge.
        let r = PhotoCropMath.sourceRect(w: 1000, h: 500, v: 300, z: 1, dx: 10_000, dy: 0)
        #expect(close(r.x, 0)); #expect(close(r.y, 0)); #expect(close(r.side, 500))
    }
}
