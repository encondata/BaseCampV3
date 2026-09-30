import SwiftUI

/// The portal's Forgot Password / Contact Support card (portal/src/pages/Login.tsx),
/// centered over a scrim; a tap outside or Got it closes it.
struct SupportCard: View {
    let onClose: () -> Void

    var body: some View {
        ZStack {
            LoginTokens.ink.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture(perform: onClose)
                .accessibilityHidden(true)
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Text("ACCOUNT RECOVERY")
                        .font(KioskType.mono(12))
                        .tracking(0.3 * 12)
                        .foregroundStyle(LoginTokens.orange)
                        .fixedSize()
                    Rectangle().fill(LoginTokens.line).frame(height: 1)
                }
                Text("📞")
                    .font(.system(size: 38))
                    .frame(width: 80, height: 80)
                    .background(Color(hex: 0xFFA12E, alpha: 0.16), in: Circle())
                    .padding(.top, 22)
                    .padding(.bottom, 14)
                    .accessibilityHidden(true)
                Text("Call Jimmy")
                    .font(KioskType.sans(23, .semibold))
                    .tracking(-0.015 * 23)
                    .foregroundStyle(LoginTokens.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("He'll help you get back in.")
                    .font(KioskType.sans(15, .light))
                    .foregroundStyle(LoginTokens.slate)
                    .padding(.top, 8)
                Button(action: onClose) {
                    Text("Got it")
                        .font(KioskType.sans(18, .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 54)
                        .background(LoginTokens.ink, in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, 24)
            }
            .padding(.horizontal, 32)
            .padding(.top, 36)
            .padding(.bottom, 30)
            .frame(maxWidth: 404)
            .background(LoginTokens.canvas, in: RoundedRectangle(cornerRadius: 18))
            .overlay(alignment: .topTrailing) {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(LoginTokens.slate)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
                .padding(6)
            }
            .shadow(color: .black.opacity(0.35), radius: 40, y: 30)
            .padding(24)
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isModal)
        }
    }
}
