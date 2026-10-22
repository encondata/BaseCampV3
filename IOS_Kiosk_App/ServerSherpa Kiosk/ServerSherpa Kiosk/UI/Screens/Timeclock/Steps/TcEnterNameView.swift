import SwiftUI

/// kiosk/src/timeclock/screens/EnterName.tsx: the search box (which a badge reader
/// types into as well), up to eight matching people to tap, and the on-screen
/// keyboard. In landscape the results sit beside the keyboard.
struct TcEnterNameView: View {
    let model: TimeclockFlowModel
    /// Opens the camera for a badge QR (nil without a camera).
    let onScan: (() -> Void)?
    @Environment(\.tcMetrics) private var m

    private var width: CGFloat { m.column(m.landscape ? 1280 : 760) }
    /// Landscape: results 1fr (at least 240), keyboard 1.7fr.
    private var keyboardWidth: CGFloat {
        guard m.landscape else { return width }
        return max(0, min(width - 16 - 240, (width - 16) * 1.7 / 2.7))
    }

    var body: some View {
        VStack(spacing: m.gap) {
            TcTitle(text: "Enter Your Name")
            TcLead(text: "Type your name below to find your account.")
            searchBox
            if let message = model.shownMessage { TcErrorText(text: message).accessibilityAddTraits(.updatesFrequently) }
            if m.landscape {
                HStack(alignment: .top, spacing: 16) {
                    results.frame(maxWidth: .infinity, alignment: .top)
                    keyboard
                }
                .frame(width: width)
            } else {
                VStack(spacing: 16) {
                    results
                    keyboard
                }
                .frame(width: width)
            }
        }
        .frame(maxWidth: m.landscape ? 1280 : 900)
    }

    private var searchBox: some View {
        HStack(spacing: 14) {
            Image(systemName: "magnifyingglass").font(.system(size: 24, weight: .semibold)).foregroundStyle(TcColors.ink)
            Group {
                if model.query.isEmpty {
                    Text("Start typing your name…").foregroundStyle(Color(hex: 0x94A3B8))
                } else {
                    Text(model.query).foregroundStyle(TcColors.ink)
                }
            }
            .font(KioskType.sans(m.searchText))
            .lineLimit(1)
            .truncationMode(.head)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("Your name")
            .accessibilityValue(model.query)
            if let onScan, !model.looking {
                Button(action: onScan) {
                    Image(systemName: "qrcode.viewfinder").font(.system(size: 26)).foregroundStyle(TcColors.slate)
                        .frame(width: 48, height: 48).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Scan your QR code with the camera")
            }
        }
        .padding(.horizontal, 20)
        .frame(width: width)
        .frame(minHeight: 68)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(model.inputOff ? TcColors.line : TcColors.amber, lineWidth: model.inputOff ? 1 : 1.5))
        .shadow(color: TcColors.amber.opacity(model.inputOff ? 0 : 0.18), radius: 3)
    }

    private var results: some View {
        VStack(spacing: 8) {
            ForEach(model.results, id: \.id) { person in
                Button { model.pick(person) } label: {
                    HStack(spacing: 14) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(person.displayName).font(KioskType.sans(m.resultName, .semibold)).foregroundStyle(TcColors.ink)
                            if let title = person.jobTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
                                Text(title).font(KioskType.sans(m.resultSub)).foregroundStyle(TcColors.slate)
                            }
                        }
                        .multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right").font(.system(size: 20, weight: .semibold)).foregroundStyle(TcColors.slate)
                    }
                    .padding(.vertical, 8).padding(.horizontal, 18)
                    .frame(maxWidth: .infinity, minHeight: 60)
                    .background(Color.white.opacity(0.95), in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(TcColors.line, lineWidth: 1))
                    .contentShape(RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
                .disabled(model.looking)
            }
            if model.noMatches {
                Text("No one matches that name yet. Keep typing or check the spelling.")
                    .font(KioskType.sans(m.hint))
                    .foregroundStyle(TcColors.slate)
                    .multilineTextAlignment(.center)
            }
        }
    }

    private var keyboard: some View {
        TcOnScreenKeyboard(width: keyboardWidth, symbols: model.kbSymbols, shift: model.kbShift, disabled: model.looking) {
            model.pressKey($0)
        }
    }
}
