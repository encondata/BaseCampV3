import SwiftUI

// kiosk/src/timeclock/OnScreenKeyboard.tsx: QWERTY rows, Shift and Backspace
// around the bottom letter row, then 123 · Space · Search. 123 swaps the letters
// for digits and the punctuation names carry (hyphen, apostrophe, period).
// The keys only report presses; the flow model keeps the text, Shift and the
// layer, so a rotation keeps them too.

enum TcKey: Hashable, Sendable {
    case letter(String)
    case symbol(String)
    case shift, backspace, numbers, letters, space, search

    /// The accessible name (and the web's aria-label).
    var name: String {
        switch self {
        case .letter(let s), .symbol(let s): s
        case .shift: "Shift"
        case .backspace: "Backspace"
        case .numbers: "Numbers"
        case .letters: "Letters"
        case .space: "Space"
        case .search: "Search"
        }
    }

    /// What the key shows (icons for Shift and Backspace).
    var label: String {
        switch self {
        case .numbers: "123"
        case .letters: "ABC"
        default: name
        }
    }

    /// The stylesheet's flex-grow: how many letter widths the key takes.
    fileprivate var grow: CGFloat {
        switch self {
        case .letter, .symbol: 1
        case .shift, .backspace: 1.4
        case .numbers, .letters: 1.6
        case .search: 2
        case .space: 5
        }
    }

    fileprivate var maxWidth: CGFloat {
        switch self {
        case .letter, .symbol: 84
        case .shift, .backspace: 120
        case .numbers, .letters: 150
        case .search: 200
        case .space: .infinity
        }
    }
}

private let LETTER_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"]
private let SYMBOL_ROWS = ["1234567890", "-'.,&@"]

func tcKeyboardRows(symbols: Bool) -> [[TcKey]] {
    if symbols {
        return [
            SYMBOL_ROWS[0].map { .symbol(String($0)) },
            SYMBOL_ROWS[1].map { .symbol(String($0)) } + [.backspace],
            [.letters, .space, .search],
        ]
    }
    return [
        LETTER_ROWS[0].map { .letter(String($0)) },
        LETTER_ROWS[1].map { .letter(String($0)) },
        [.shift] + LETTER_ROWS[2].map { .letter(String($0)) } + [.backspace],
        [.numbers, .space, .search],
    ]
}

/// Capital at the start of the box and after a space, or after Shift; lower case otherwise.
func tcLetterText(_ letter: String, value: String, shift: Bool) -> String {
    let autoCap = value.isEmpty || value.hasSuffix(" ")
    return shift || autoCap ? letter.uppercased() : letter.lowercased()
}

struct TcOnScreenKeyboard: View {
    /// The keyboard's own width; the keys are laid out from it.
    let width: CGFloat
    let symbols: Bool
    let shift: Bool
    var disabled = false
    let onKey: (TcKey) -> Void
    @Environment(\.tcMetrics) private var m

    private var inset: CGFloat { m.clamp(10, m.keyGap * 1.8, 18) }

    /// One letter's width: ten letters and their gaps fill the inner width, at most 84.
    private var unit: CGFloat {
        let inner = width - inset * 2
        return max(20, min(84, (inner - 9 * m.keyGap) / 10))
    }

    var body: some View {
        VStack(spacing: 10) {
            ForEach(Array(tcKeyboardRows(symbols: symbols).enumerated()), id: \.offset) { _, row in
                HStack(spacing: m.keyGap) {
                    ForEach(row, id: \.self) { key in keyButton(key, width: keyWidth(key, in: row)) }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(inset)
        .frame(width: width)
        .background(TcColors.keyMod.opacity(0.7), in: RoundedRectangle(cornerRadius: 20))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("On-screen keyboard")
    }

    private func keyWidth(_ key: TcKey, in row: [TcKey]) -> CGFloat {
        guard key == .space else { return min(key.maxWidth, unit * key.grow + m.keyGap * (key.grow - 1)) }
        // Space fills the row to the letter rows' width.
        let full = unit * 10 + m.keyGap * 9
        let others = row.filter { $0 != .space }.reduce(CGFloat(0)) { $0 + keyWidth($1, in: row) }
        return max(unit * 2, full - others - m.keyGap * CGFloat(row.count - 1))
    }

    @ViewBuilder private func keyButton(_ key: TcKey, width: CGFloat) -> some View {
        let pressed = key == .shift && shift
        Button { onKey(key) } label: {
            Group {
                switch key {
                case .shift: Image(systemName: pressed ? "shift.fill" : "shift")
                case .backspace: Image(systemName: "delete.left")
                default: Text(key.label)
                }
            }
            .font(KioskType.sans(isWideText(key) ? m.keyText * 0.8 : m.keyText, .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .foregroundStyle(key == .search || pressed ? Color.white : TcColors.ink)
            .frame(width: width, height: m.keyHeight)
            .background(keyFill(key, pressed: pressed), in: RoundedRectangle(cornerRadius: 12))
            .shadow(color: key == .search ? TcColors.searchShadow : TcColors.keyShadow, radius: 0, y: 2)
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(TcKeyPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityLabel(key.name)
        .accessibilityAddTraits(pressed ? .isSelected : [])
    }

    private func isWideText(_ key: TcKey) -> Bool {
        switch key {
        case .numbers, .letters, .space, .search: true
        default: false
        }
    }

    private func keyFill(_ key: TcKey, pressed: Bool) -> Color {
        if pressed { return TcColors.ink }
        switch key {
        case .search: return TcColors.amber
        case .shift, .backspace, .numbers, .letters: return TcColors.keyMod
        default: return .white
        }
    }
}

/// A key sinks 2 pt while pressed.
private struct TcKeyPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .offset(y: configuration.isPressed ? 2 : 0)
            .brightness(configuration.isPressed ? -0.04 : 0)
    }
}
