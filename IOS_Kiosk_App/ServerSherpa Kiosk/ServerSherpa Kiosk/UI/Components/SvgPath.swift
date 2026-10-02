import SwiftUI

/// Reads the SVG path data the Android icons are traced in (M L H V C A Z,
/// absolute and relative), so the SwiftUI icons draw the very same lines.
enum SvgPath {
    static func parse(_ d: String) -> Path {
        var s = Scanner(Array(d.utf8))
        var path = Path()
        var current = CGPoint.zero
        var start = CGPoint.zero
        var command: UInt8 = 0
        while true {
            s.skipSeparators()
            guard let c = s.peek() else { break }
            if Scanner.isCommand(c) { command = c; s.advance() }
            let rel = command >= UInt8(ascii: "a")
            let base = rel ? current : .zero
            switch command | 0x20 {   // lowercased
            case UInt8(ascii: "m"):
                guard let x = s.number(), let y = s.number() else { return path }
                current = CGPoint(x: base.x + x, y: base.y + y)
                start = current
                path.move(to: current)
                command = rel ? UInt8(ascii: "l") : UInt8(ascii: "L")   // later pairs are line-tos
            case UInt8(ascii: "l"):
                guard let x = s.number(), let y = s.number() else { return path }
                current = CGPoint(x: base.x + x, y: base.y + y)
                path.addLine(to: current)
            case UInt8(ascii: "h"):
                guard let x = s.number() else { return path }
                current = CGPoint(x: (rel ? current.x : 0) + x, y: current.y)
                path.addLine(to: current)
            case UInt8(ascii: "v"):
                guard let y = s.number() else { return path }
                current = CGPoint(x: current.x, y: (rel ? current.y : 0) + y)
                path.addLine(to: current)
            case UInt8(ascii: "c"):
                guard let x1 = s.number(), let y1 = s.number(), let x2 = s.number(), let y2 = s.number(),
                      let x = s.number(), let y = s.number() else { return path }
                current = CGPoint(x: base.x + x, y: base.y + y)
                path.addCurve(to: current, control1: CGPoint(x: base.x + x1, y: base.y + y1),
                              control2: CGPoint(x: base.x + x2, y: base.y + y2))
            case UInt8(ascii: "a"):
                guard let rx = s.number(), let ry = s.number(), let rot = s.number(),
                      let large = s.flag(), let sweep = s.flag(), let x = s.number(), let y = s.number() else { return path }
                let end = CGPoint(x: base.x + x, y: base.y + y)
                addArc(&path, from: current, to: end, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
                current = end
            case UInt8(ascii: "z"):
                path.closeSubpath()
                current = start
                s.skipSeparators()
                if let n = s.peek(), !Scanner.isCommand(n) { return path }   // malformed: numbers after Z
            default:
                return path
            }
        }
        return path
    }

    /// SVG endpoint arc → center form (SVG 1.1 F.6.5) → cubic segments of at most 90°.
    private static func addArc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rx0: CGFloat, ry ry0: CGFloat,
                               rotation: CGFloat, large: Bool, sweep: Bool) {
        var rx = abs(rx0), ry = abs(ry0)
        guard rx > 0, ry > 0, p0 != p1 else { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180
        let cosP = cos(phi), sinP = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1 = cosP * dx + sinP * dy
        let y1 = -sinP * dx + cosP * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var coef = sqrt(max(0, num / den))
        if large == sweep { coef = -coef }
        let cxp = coef * rx * y1 / ry
        let cyp = -coef * ry * x1 / rx
        let cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2
        let cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        }
        let theta1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
        var delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2) - 0.001)))
        let step = delta / CGFloat(segments)
        let k = 4.0 / 3.0 * tan(step / 4)
        func point(_ t: CGFloat) -> CGPoint {
            let x = rx * cos(t), y = ry * sin(t)
            return CGPoint(x: cx + cosP * x - sinP * y, y: cy + sinP * x + cosP * y)
        }
        func derivative(_ t: CGFloat) -> CGPoint {
            let x = -rx * sin(t), y = ry * cos(t)
            return CGPoint(x: cosP * x - sinP * y, y: sinP * x + cosP * y)
        }
        var t = theta1
        for i in 0..<segments {
            let t2 = t + step
            let a = point(t), b = i == segments - 1 ? p1 : point(t2)
            let da = derivative(t), db = derivative(t2)
            path.addCurve(to: b, control1: CGPoint(x: a.x + k * da.x, y: a.y + k * da.y),
                          control2: CGPoint(x: b.x - k * db.x, y: b.y - k * db.y))
            t = t2
        }
    }

    private struct Scanner {
        let bytes: [UInt8]
        var i = 0

        init(_ bytes: [UInt8]) { self.bytes = bytes }

        static func isCommand(_ c: UInt8) -> Bool {
            "MmLlHhVvCcAaZz".utf8.contains(c)
        }

        func peek() -> UInt8? { i < bytes.count ? bytes[i] : nil }
        mutating func advance() { i += 1 }

        mutating func skipSeparators() {
            while let c = peek(), c == UInt8(ascii: " ") || c == UInt8(ascii: ",") || c == UInt8(ascii: "\n") || c == UInt8(ascii: "\t") { i += 1 }
        }

        /// A single-character arc flag ("0" / "1"), which may be packed against the next number.
        mutating func flag() -> Bool? {
            skipSeparators()
            guard let c = peek(), c == UInt8(ascii: "0") || c == UInt8(ascii: "1") else { return nil }
            i += 1
            return c == UInt8(ascii: "1")
        }

        /// A number: optional sign, digits, at most one dot (a second dot starts the next number).
        mutating func number() -> CGFloat? {
            skipSeparators()
            let begin = i
            if let c = peek(), c == UInt8(ascii: "-") || c == UInt8(ascii: "+") { i += 1 }
            var sawDot = false, sawDigit = false
            while let c = peek() {
                if c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9") { sawDigit = true; i += 1 }
                else if c == UInt8(ascii: "."), !sawDot { sawDot = true; i += 1 }
                else { break }
            }
            guard sawDigit, let text = String(bytes: bytes[begin..<i], encoding: .ascii), let v = Double(text) else { i = begin; return nil }
            return CGFloat(v)
        }
    }
}

/// A line icon traced from an Android vector: stroked paths plus filled ones,
/// in a square viewport, drawn in the caller's tint.
struct VectorIcon {
    let viewport: CGFloat
    let lineWidth: CGFloat
    let strokes: [Path]
    let fills: [Path]

    init(viewport: CGFloat, lineWidth: CGFloat, strokes: [String] = [], fills: [String] = []) {
        self.viewport = viewport
        self.lineWidth = lineWidth
        self.strokes = strokes.map(SvgPath.parse)
        self.fills = fills.map(SvgPath.parse)
    }
}

struct VectorIconView: View {
    let icon: VectorIcon
    let tint: Color
    var size: CGFloat

    var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / icon.viewport
            context.scaleBy(x: scale, y: scale)
            let style = StrokeStyle(lineWidth: icon.lineWidth, lineCap: .round, lineJoin: .round)
            for p in icon.strokes { context.stroke(p, with: .color(tint), style: style) }
            for p in icon.fills { context.fill(p, with: .color(tint)) }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Android `circle(cx, cy, r)`: a full circle as two SVG arcs.
func svgCircle(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) -> String {
    "M\(cx - r),\(cy) a\(r),\(r) 0 1,0 \(2 * r),0 a\(r),\(r) 0 1,0 \(-2 * r),0"
}
