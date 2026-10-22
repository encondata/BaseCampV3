import SwiftUI

// MARK: - Rules (pure, tested)

/// Whether this session may open the Rolodex: admins and up (rank 60+). Staff, workers and
/// move-password sign-ins are sent Home.
func rolodexAllowed(_ state: AuthState) -> Bool {
    if case .authed(let s) = state { return s.isAdmin }
    return false
}

/// The list and the worker page side by side at a regular width of 700 pt or more (spec §3.10);
/// narrower, the list alone, and a tap pushes the worker page. Before the first measurement a
/// regular width starts split (no stacked first frame on an iPad).
func rolodexSplit(sizeClass: UserInterfaceSizeClass?, width: CGFloat?) -> Bool {
    guard sizeClass == .regular else { return false }
    return width.map { $0 >= 700 } ?? true
}

// MARK: - The screen

/// The Rolodex (Route.rolodex): an admin's A–Z list of every worker, with the selected worker's
/// page beside it on a wide screen. The model lives in the container, so a phone's pushed worker
/// page (`RolodexWorkerScreen`) shares it.
struct RolodexView: View {
    @Binding var path: [Route]
    @Environment(RolodexModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.kioskPalette) private var palette
    @State private var width: CGFloat?
    /// Loads once per visit from Home (not again when a phone comes back from a worker page).
    @State private var opened = false

    static let listWidth: CGFloat = 360

    var body: some View {
        let split = rolodexSplit(sizeClass: sizeClass, width: width)
        Group {
            if split {
                HStack(spacing: 0) {
                    RolodexListView(split: true) { id in Task { await model.select(id) } }
                        .frame(width: Self.listWidth)
                    Rectangle().fill(palette.paperLine).frame(width: 1)
                    RolodexWorkerView(onBack: nil)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                RolodexListView(split: false) { id in
                    Task { await model.select(id) }
                    path.append(.rolodexWorker(id))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .background(palette.paper2)
        .rolodexAdminOnly(path: $path)
        .onAppear {
            guard !opened else { return }
            opened = true
            // An Edit form left open when "‹ Home" was tapped doesn't come back with the next visit.
            model.cancelEdit()
            // Not a `.task`: pushing a worker page would cancel the load half way.
            Task { await model.load() }
        }
    }
}

extension View {
    /// Shows the content to admins only; anyone else is sent Home (a direct route included).
    func rolodexAdminOnly(path: Binding<[Route]>) -> some View {
        modifier(RolodexAdminOnly(path: path))
    }

    /// The kiosk's text field look: paper, a hairline, 48 pt tall.
    func rolodexField(_ palette: KioskPalette, focused: Bool = false) -> some View {
        font(KioskType.bodyLarge)
            .foregroundStyle(palette.text)
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(focused ? palette.accent : palette.paperLine, lineWidth: focused ? 2 : 1))
    }
}

private struct RolodexAdminOnly: ViewModifier {
    @Binding var path: [Route]
    @Environment(KioskAuth.self) private var auth

    func body(content: Content) -> some View {
        let allowed = rolodexAllowed(auth.state)
        Group {
            if allowed { content } else { Color.clear }
        }
        .task(id: allowed) {
            if !allowed { path.removeAll() }
        }
    }
}

// MARK: - Shared pieces

/// A status chip in the status's own color (statuses come from the server and can be
/// customized in the portal). A color that isn't `#rrggbb` falls back by key.
struct RolodexStatusChip: View {
    let key: String
    let label: String
    let color: String?
    var dot = true
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        let tint = rolodexColor(color) ?? rolodexStatusTone(key).text
        HStack(spacing: 6) {
            if dot { Circle().fill(tint).frame(width: 6, height: 6) }
            Text(label.isEmpty ? key.capitalized : label)
                .font(KioskType.sans(12, .semibold))
                .foregroundStyle(palette.isDark ? palette.text : tint)
                .lineLimit(1)
        }
        .padding(.horizontal, 9).padding(.vertical, 3)
        .background(tint.opacity(0.12), in: Capsule())
        .overlay(Capsule().stroke(tint.opacity(0.35), lineWidth: 1))
        .fixedSize()
    }
}

/// The seeded statuses' tones, for a status without a usable color.
func rolodexStatusTone(_ key: String) -> ChipTone {
    switch key {
    case "active": .green
    case "standby": .amber
    case RolodexLogic.blacklistKey: .red
    default: .slate
    }
}

/// `#rrggbb` (the server's status and level colors); nil for anything else.
func rolodexColor(_ hex: String?) -> Color? {
    guard var text = hex?.trimmingCharacters(in: .whitespaces) else { return nil }
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, text.allSatisfy(\.isHexDigit), let value = UInt32(text, radix: 16) else { return nil }
    return Color(hex: value)
}
