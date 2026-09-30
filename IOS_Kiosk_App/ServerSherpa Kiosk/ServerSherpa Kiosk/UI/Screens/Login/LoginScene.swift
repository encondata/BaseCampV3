import SwiftUI

/// Sizes for the sign-in page. Jimmy's mockup is a 1448×1086 frame; every
/// scene measurement is taken from it in those units and multiplied by `s`,
/// so a smaller screen shows the same picture, scaled. The form keeps a
/// floor on `f` so its fields stay comfortable to touch.
struct LoginMetrics {
    static let mockup = CGSize(width: 1448, height: 1086)

    let size: CGSize
    let layout: LoginLayout

    init(size: CGSize) {
        self.size = size
        self.layout = LoginLayout.forWidth(size.width)
    }

    /// Scene scale: the mockup fitted inside the screen.
    var s: CGFloat { min(size.width / Self.mockup.width, size.height / Self.mockup.height) }
    /// Form scale: the scene's on wide screens, with a floor on medium ones
    /// (portrait iPads are narrow for their height).
    var f: CGFloat {
        switch layout {
        case .wide: min(1, max(s, 0.72))
        case .medium: min(1, max(s, 0.8))
        case .compact: size.height < 500 ? 0.7 : 0.85   // phones in landscape
        }
    }
    /// The mockup's column is 27 % of the width (392 of 1448); never wider than 392.
    var formWidth: CGFloat {
        layout == .compact ? min(392, size.width - 32) : min(392, max(392 * f, size.width * 392 / Self.mockup.width))
    }
    /// The mockup's right margin (70 of 1448).
    var formTrailing: CGFloat { size.width * 70 / Self.mockup.width }
    var formLeading: CGFloat { size.width - formTrailing - formWidth }
    var showsStates: Bool { layout == .wide && LoginLayout.showsStates(height: size.height) }

    /// The map's design box (1040×560) sits at (10, 56) in the mockup at 0.9 × `s`;
    /// on narrower screens it shrinks so the Las Vegas label clears the form.
    var mapOrigin: CGPoint { CGPoint(x: 10 * s, y: 56 * s) }
    var mapScale: CGFloat {
        let room = (formLeading - 24 - mapOrigin.x) / 960
        return max(0, min(0.9 * s, room))
    }
}

/// The sign-in page's art (portal `LoginScene.tsx` + `login-light.css`, with the
/// mockup's wording): canvas, contour lines, mountains, logo, route map,
/// headline and status line. Everything but the form.
struct LoginScene: View {
    let metrics: LoginMetrics

    var body: some View {
        let s = metrics.s
        ZStack(alignment: .topLeading) {
            LoginBackdrop(metrics: metrics)
            FormWash(metrics: metrics)
            LoginLogo(scale: s)
                .offset(x: 77 * s, y: 50 * s)
            LoginMap(scale: metrics.mapScale, details: metrics.layout == .wide, states: metrics.showsStates)
                .offset(x: metrics.mapOrigin.x, y: metrics.mapOrigin.y)
            LoginHeadline(scale: s)
                .padding(.leading, 78 * s)
                .padding(.bottom, 374 * s)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            LoginStatusLine(scale: s)
                .padding(.leading, 74 * s)
                .padding(.bottom, 52 * s)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        }
        .frame(width: metrics.size.width, height: metrics.size.height)
        .accessibilityElement(children: .ignore)
    }
}

/// Canvas, contour lines and the mountains. Compact screens run the peaks full
/// width at 45 % behind the form (the web's `max-width: 899px` rule).
struct LoginBackdrop: View {
    let metrics: LoginMetrics

    var body: some View {
        let s = metrics.s
        let w = metrics.size.width, h = metrics.size.height
        ZStack(alignment: .topLeading) {
            LoginTokens.canvas
            LoginContours()
            if metrics.layout == .compact {
                // At most 60 % of the height, so a landscape phone keeps the form legible.
                let artWidth = min(w, h * 0.6 * 1022 / 611)
                FadedMountains()
                    .frame(width: artWidth, height: artWidth * 611 / 1022)
                    .opacity(0.45)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            } else {
                // Placed so its main peak lands where the mockup's does (680, 708).
                FadedMountains()
                    .frame(width: 1022 * s, height: 611 * s)
                    .offset(x: w - 964 * s, y: h - 600 * s)
            }
        }
        .frame(width: w, height: h)
        .clipped()
    }
}

/// `LoginMountains` with its top (0→26 %) and left (0→16 %) edges faded into the canvas.
private struct FadedMountains: View {
    var body: some View {
        Image("LoginMountains")
            .resizable()
            .mask {
                LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.26)],
                               startPoint: .top, endPoint: .bottom)
                    .mask {
                        LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.16)],
                                       startPoint: .leading, endPoint: .trailing)
                    }
            }
            .accessibilityHidden(true)
    }
}

/// The portal's soft cream wash behind the form column (`.lx-form-col::before`).
private struct FormWash: View {
    let metrics: LoginMetrics

    var body: some View {
        if metrics.layout != .compact {
            let width = metrics.formWidth * 1.28
            EllipticalGradient(stops: [
                .init(color: LoginTokens.canvas.opacity(0.82), location: 0),
                .init(color: LoginTokens.canvas.opacity(0.55), location: 0.6),
                .init(color: LoginTokens.canvas.opacity(0), location: 1),
            ], center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5)
            .frame(width: width, height: metrics.size.height)
            .offset(x: metrics.formLeading + metrics.formWidth / 2 - width / 2)
        }
    }
}

/// Faint orange contour lines: the portal's `contour(i)` in a 1672×941 frame,
/// aspect-filled, 1 pt stroke at 14 %.
struct LoginContours: View {
    private static let lines: [Path] = (0..<17).map { i in
        var p = Path()
        let base = -30 + Double(i) * 64
        var x = -40.0
        while x <= 1720 {
            let y = base + 26 * sin(x / 230 + Double(i) * 0.8) + 11 * sin(x / 91 + Double(i) * 1.9)
            if p.isEmpty { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
            x += 24
        }
        return p
    }

    var body: some View {
        Canvas { context, size in
            let k = max(size.width / 1672, size.height / 941)
            let t = CGAffineTransform(translationX: (size.width - 1672 * k) / 2, y: (size.height - 941 * k) / 2)
                .scaledBy(x: k, y: k)
            for line in Self.lines {
                context.stroke(line.applying(t), with: .color(LoginTokens.orange.opacity(0.14)), lineWidth: 1)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The mark, "Server" + orange "Sherpa", and the tag line. Mockup sizes × `scale`.
struct LoginLogo: View {
    let scale: CGFloat

    var body: some View {
        HStack(spacing: 17 * scale) {
            Image("Logo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 86 * scale, height: 86 * scale)
                .accessibilityLabel("ServerSherpa logo")
            VStack(alignment: .leading, spacing: 9 * scale) {
                (Text("Server").foregroundColor(LoginTokens.ink) + Text("Sherpa").foregroundColor(LoginTokens.orange))
                    .font(KioskType.sans(37 * scale, .heavy))
                    .tracking(-0.01 * 37 * scale)
                Text("DATACENTER RELOCATION TOOLS")
                    .font(KioskType.mono(max(9, 13.5 * scale)))
                    .tracking(0.3 * max(9, 13.5 * scale))
                    .foregroundStyle(LoginTokens.slate)
            }
            .fixedSize()
        }
    }
}

/// "Migration Control." / "From First Scan to Final Rack." and the mockup's subline.
private struct LoginHeadline: View {
    let scale: CGFloat

    var body: some View {
        let size = 54 * scale
        VStack(alignment: .leading, spacing: 0) {
            Text("Migration Control.")
                .foregroundStyle(LoginTokens.ink)
            Text("From First Scan to Final Rack.")
                .foregroundStyle(LoginTokens.orange)
                .padding(.top, -0.2 * size)
            Text("Track assets. Verify work. Move with confidence.")
                .font(KioskType.sans(25 * scale))
                .tracking(0)
                .foregroundStyle(LoginFormColors.label)
                .padding(.top, 2 * scale)
        }
        .font(KioskType.sans(size, .heavy))
        .tracking(-0.02 * size)
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

/// Green dot + "ALL SYSTEMS OPERATIONAL".
struct LoginStatusLine: View {
    let scale: CGFloat

    var body: some View {
        let size = max(10.5, 15 * scale)
        HStack(spacing: 14 * scale) {
            Circle()
                .fill(LoginTokens.ok)
                .frame(width: 16 * scale, height: 16 * scale)
                .shadow(color: LoginTokens.ok.opacity(0.6), radius: 4 * scale)
            Text("ALL SYSTEMS OPERATIONAL")
                .font(KioskType.mono(size))
                .tracking(0.1 * size)
                .foregroundStyle(Color(hex: 0x334155))
        }
        .fixedSize()
    }
}
