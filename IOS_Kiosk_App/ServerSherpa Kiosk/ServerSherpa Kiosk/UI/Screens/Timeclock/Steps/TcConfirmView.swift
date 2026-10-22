import SwiftUI

/// kiosk/src/timeclock/screens/ConfirmPerson.tsx: Is this you? The person's photo
/// (initials when there is none), name, job title and Employee ID, each line only
/// when set. In landscape the photo sits left of the words and buttons.
struct TcConfirmView: View {
    let model: TimeclockFlowModel
    let person: KioskTimeclockPerson
    @Environment(\.tcMetrics) private var m

    var body: some View {
        Group {
            if m.landscape {
                HStack(spacing: m.clamp(24, m.size.width * 0.05, 72)) {
                    photo
                    words(alignment: .leading).frame(maxWidth: 640, alignment: .leading)
                }
                .frame(maxWidth: 1100)
            } else {
                VStack(spacing: m.gap) {
                    photo
                    words(alignment: .center)
                }
                .frame(maxWidth: 820)
            }
        }
    }

    private var photo: some View {
        ZStack {
            if let image = model.avatar {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                LinearGradient(colors: [Color(hex: 0x334155), Color(hex: 0x64748B)], startPoint: .topLeading, endPoint: .bottomTrailing)
                Text(initialsOf(person.displayName))
                    .font(KioskType.sans(m.avatar * 0.34, .bold))
                    .tracking(0.02 * m.avatar * 0.34)
                    .foregroundStyle(.white)
            }
        }
        .frame(width: m.avatar, height: m.avatar)
        .clipShape(Circle())
        .overlay(Circle().stroke(.white, lineWidth: 6))
        .shadow(color: TcColors.ink.opacity(0.18), radius: 15, y: 10)
        .accessibilityHidden(true)
    }

    private func words(alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: m.clamp(6, m.gap * 0.5, 14)) {
            Text("Is this you?").font(KioskType.sans(m.ask, .bold)).foregroundStyle(TcColors.ink)
                .accessibilityAddTraits(.isHeader)
            Text(person.displayName)
                .font(KioskType.sans(m.personName, .heavy))
                .tracking(-0.02 * m.personName)
                .foregroundStyle(TcColors.ink)
            ForEach(tcPersonMeta(person), id: \.self) { line in
                Text(line).font(KioskType.sans(m.personMeta)).foregroundStyle(TcColors.muted)
            }
            let yes = Button { model.confirmYes() } label: {
                HStack(spacing: 12) { Text("Yes, that's me"); Image(systemName: "arrow.right") }
            }
            .buttonStyle(TcButtonStyle(kind: .primary))
            let no = Button("No, search again") { model.confirmNo() }
                .buttonStyle(TcButtonStyle(kind: .ghost))
            Group {
                if m.landscape {
                    HStack(spacing: 14) { yes; no }
                } else {
                    VStack(spacing: 14) { yes; no }
                }
            }
            .frame(maxWidth: 680)
            .padding(.top, m.clamp(10, m.gap, 28))
        }
        .multilineTextAlignment(alignment == .leading ? .leading : .center)
    }
}
