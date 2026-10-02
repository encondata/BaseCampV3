import SwiftUI

/// Settings › Sound: one sound per scan outcome, with Play, and the volume.
struct SoundPanel: View {
    @Environment(KioskPrefs.self) private var prefs
    @Environment(\.container) private var container
    @Environment(\.kioskPalette) private var palette

    private static let options: [(String, String)] = [("none", "None")] + BuiltinSound.allCases.map { ($0.rawValue, $0.label) }

    private func wire(_ c: SoundChoice) -> String {
        if case .builtin(let s) = c { return s.rawValue }
        return "none"
    }

    private func choice(_ wire: String) -> SoundChoice {
        BuiltinSound(rawValue: wire).map(SoundChoice.builtin) ?? .none
    }

    private func row(_ title: String, _ detail: String, _ keyPath: WritableKeyPath<SoundSettings, SoundChoice>) -> some View {
        let value = prefs.sound[keyPath: keyPath]
        return SettingsRow(title: title, detail: detail) {
            VStack(alignment: .leading, spacing: 8) {
                Segmented(options: Self.options, selection: Binding(get: { wire(value) }, set: { prefs.sound[keyPath: keyPath] = choice($0) }))
                SecondaryButton("Play") {
                    if case .builtin(let s) = value { container.sound.preview(s, volume: prefs.sound.volume) }
                }
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row("Good scan", "Played when a scan matches.", \.good)
            row("Not-found scan", "Played when a scan matches nothing.", \.notFound)
            row("Duplicate scan", "Played when a scan changes nothing.", \.duplicate)
            SettingsRow(title: "Volume") {
                HStack {
                    Slider(value: Binding(get: { prefs.sound.volume }, set: { prefs.sound.volume = $0 }), in: 0...1)
                        .accessibilityLabel("Volume")
                    Text("\(Int((prefs.sound.volume * 100).rounded()))%").font(KioskType.labelMedium).foregroundStyle(palette.text)
                }
            }
        }
    }
}
