import SwiftUI

/// The guided time clock: Welcome (station only) → Enter Your Name → Is this you?
/// → Clock In / Clock Out → (badge) → You're All Set. The view draws the model's
/// step; it keeps no flow state of its own, so turning the device (portrait ↔
/// layout A) or rebuilding the view keeps the step, the person and the typed text.
struct TimeclockFlowView: View {
    let model: TimeclockFlowModel
    /// Opens the camera scanner (Welcome's Scan card, the name box's QR button); nil without a camera.
    let onCamera: (() -> Void)?
    /// Station Welcome's gear (to sign-in); nil hides it.
    let onSettings: (() -> Void)?

    var body: some View {
        GeometryReader { geo in
            let metrics = TcMetrics(size: geo.size)
            TcShell(metrics: metrics,
                    back: model.hasBack ? { model.back() } : nil,
                    backDisabled: model.busy,
                    onSettings: model.mode == .station && model.step == .welcome ? onSettings : nil) {
                step
            }
            .background {
                // the reader's keystrokes land here while a step takes them
                TcKeyCapture(active: model.typing && !model.inputOff,
                             onInsert: { model.keyInsert($0) },
                             onDelete: { model.keyDelete() })
                    .frame(width: 1, height: 1)
                    .opacity(0)
                    .accessibilityHidden(true)
            }
        }
        // Any touch restarts the idle countdown without taking it from the controls underneath.
        .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in model.onActivity() })
        .environment(\.colorScheme, .light)
    }

    @ViewBuilder private var step: some View {
        let status = model.state.status
        switch model.step {
        case .welcome:
            TcWelcomeView(model: model, onScan: onCamera)
        case .name:
            TcEnterNameView(model: model, onScan: onCamera)
        case .confirm:
            if let status { TcConfirmView(model: model, person: status.person) }
        case .action:
            if let status { TcActionView(model: model, status: status) }
        case .clockOut:
            if let status { TcClockOutView(model: model, status: status) }
        case .badge:
            TcBadgeView(model: model)
        case .printing:
            TcPrintingView()
        case .verify:
            TcVerifyView(model: model)
        case .done:
            TcAllSetView(model: model)
        }
    }
}
