import SwiftUI

/// The static Dallas → Las Vegas route map (portal `LoginScene.tsx`, the
/// mockup's labels): a 1040×560 design box drawn at `scale` points per unit,
/// so the whole map scales as one piece. `details` adds the assets card and
/// its leader line; `states` the state names.
struct LoginMap: View {
    let scale: CGFloat
    var details = true
    var states = true

    static let box = CGSize(width: 1040, height: 560)
    private static let route = SvgPath.parse("M373 421 C 392 330 440 244 573 213 C 670 190 745 160 776 112")
    /// From the card's right edge to the route (the mockup's leader).
    private static let leader = SvgPath.parse("M486 232 H 548")
    private static let stateNames: [(String, CGFloat, CGFloat)] = [
        ("NEVADA", 576, 138), ("CALIFORNIA", 138, 319), ("ARIZONA", 813, 403), ("TEXAS", 183, 509),
    ]
    private static let pins: [(title: String, place: String, x: CGFloat, y: CGFloat)] = [
        ("LAS VEGAS", "Las Vegas, NV", 790, 95),
        ("DALLAS", "Dallas, TX", 358, 458),
    ]
    private static let slateDark = Color(hex: 0x334155)

    var body: some View {
        let m = scale
        ZStack(alignment: .topLeading) {
            Canvas { context, _ in
                context.scaleBy(x: m, y: m)
                draw(&context)
            }
            .frame(width: Self.box.width * m, height: Self.box.height * m)

            if states {
                ForEach(Self.stateNames, id: \.0) { name, x, y in
                    let size = 17 * m
                    Text(name)
                        .font(KioskType.mono(size))
                        .tracking(0.3 * size)
                        .foregroundStyle(LoginTokens.slate)
                        .fixedSize()
                        .position(x: x * m, y: y * m)
                }
            }
            ForEach(Self.pins, id: \.title) { pin in
                VStack(alignment: .leading, spacing: 4 * m) {
                    Text(pin.title)
                        .font(.system(size: 20 * m, weight: .semibold, design: .monospaced))
                        .tracking(0.04 * 20 * m)
                        .foregroundStyle(LoginTokens.orange)
                    Text(pin.place)
                        .font(KioskType.mono(15.5 * m))
                        .foregroundStyle(Self.slateDark)
                }
                .fixedSize()
                .offset(x: (pin.x + 36) * m, y: (pin.y - 21) * m)
            }
            if details {
                VStack(alignment: .leading, spacing: 5 * m) {
                    Text("1,241 ASSETS")
                        .font(.system(size: 21 * m, weight: .semibold, design: .monospaced))
                        .tracking(0.04 * 20 * m)
                        .foregroundStyle(LoginTokens.orange)
                    Text("RACK 83 · ETA 2h 14m")
                        .font(KioskType.mono(15.5 * m))
                        .foregroundStyle(Self.slateDark)
                }
                .fixedSize()
                .padding(.horizontal, 16 * m)
                .frame(width: 238 * m, height: 76 * m, alignment: .leading)
                .background(.white, in: RoundedRectangle(cornerRadius: 8 * m))
                .overlay(RoundedRectangle(cornerRadius: 8 * m).stroke(LoginTokens.orange, lineWidth: 1.5 * m))
                .shadow(color: LoginTokens.ink.opacity(0.12), radius: 9 * m, y: 6 * m)
                .offset(x: 248 * m, y: 193 * m)
            }
        }
        .frame(width: Self.box.width * m, height: Self.box.height * m, alignment: .topLeading)
        .accessibilityHidden(true)
    }

    private func draw(_ context: inout GraphicsContext) {
        let orange = LoginTokens.orange
        if details {
            context.stroke(Self.leader, with: .color(orange.opacity(0.7)), lineWidth: 1.2)
        }
        context.stroke(Self.route, with: .color(orange),
                       style: StrokeStyle(lineWidth: 2.6, lineCap: .round, dash: [8, 7]))
        // Glowing midpoints.
        for (x, y, halo, dot) in [(573.0, 213.0, 16.0, 6.5), (373.0, 421.0, 11.0, 4.5)] {
            context.fill(circle(x, y, halo * 1.6), with: .radialGradient(
                Gradient(colors: [orange.opacity(0.35), orange.opacity(0)]),
                center: CGPoint(x: x, y: y), startRadius: 0, endRadius: halo * 1.6))
            context.fill(circle(x, y, halo), with: .color(orange.opacity(0.18)))
            var glow = context
            glow.addFilter(.shadow(color: orange.opacity(0.9), radius: 7))
            glow.fill(circle(x, y, dot), with: .color(orange))
            context.stroke(circle(x, y, dot), with: .color(.white), lineWidth: 2.5)
        }
        // Ringed pins with an orange glow.
        for pin in Self.pins {
            var ringed = context
            ringed.addFilter(.shadow(color: orange.opacity(0.45), radius: 6))
            for r in [19.0, 11.0] {
                ringed.fill(circle(pin.x, pin.y, r), with: .color(.white))
                ringed.stroke(circle(pin.x, pin.y, r), with: .color(orange), lineWidth: 3.5)
            }
            ringed.fill(circle(pin.x, pin.y, 4.5), with: .color(orange))
        }
    }

    private func circle(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
    }
}
