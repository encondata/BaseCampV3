import CoreTransferable
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Settings › Troubleshooting (D13): the saved printer's connection and details, ask-the-printer
/// buttons, a speed test, a Bluetooth scan and a report to share; the command box for admins and
/// developers, the Cut-send test for developers. Nothing here saves a printer.
struct TroubleshootingPanel: View {
    @Environment(\.container) private var container
    @Environment(KioskAuth.self) private var auth

    private var roles: (admin: Bool, developer: Bool) {
        if case .authed(let s) = auth.state { return (s.isAdmin, s.isDeveloper) }
        return (false, false)
    }

    var body: some View {
        let roles = self.roles
        TroubleshootingBody(container: container, isAdmin: roles.admin, isDeveloper: roles.developer)
            // Another role starts the tab over, so the command box always follows who is signed in.
            .id("\(roles.admin)-\(roles.developer)")
    }
}

private struct TroubleshootingBody: View {
    @State private var vm: TroubleshootingModel
    @State private var confirmSpeed = false
    @State private var copied = false
    @Environment(\.kioskPalette) private var palette

    init(container: AppContainer, isAdmin: Bool, isDeveloper: Bool) {
        _vm = State(initialValue: TroubleshootingModel(
            settings: container.labelSettings, bluetooth: container.bluetooth,
            zebraFor: { printer in container.zebra(for: printer) },
            printerLock: container.printerLock, printerGuard: container.printerGuard,
            isAdmin: isAdmin, isDeveloper: isDeveloper,
            pick: { container.labelBuilder.monitor.pick }))
    }

    /// A call to the printer can start: there is one, and nothing else here is talking to it.
    private var canCall: Bool { vm.printer != nil && !vm.busy }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            connection
            details
            asking
            speedTest
            if vm.showsCutSendTest { cutSendTest }
            bluetoothScan
            report
        }
        .onAppear { vm.open() }
        .onDisappear { vm.close() }
        .confirmationDialog("Print \(vm.speedRuns) speed-test labels?", isPresented: $confirmSpeed, titleVisibility: .visible) {
            Button("Print \(vm.speedRuns) labels") { vm.startSpeedTest() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Each label carries about \(vm.speedKb) KB of data and prints on the labels loaded in the printer.")
        }
    }

    // MARK: Sections

    @ViewBuilder private var connection: some View {
        SectionTitle(title: "Connection")
        if let printer = vm.printer {
            Text(printerSummary(printer)).font(KioskType.titleMedium).foregroundStyle(palette.text).padding(.bottom, 6)
            DetailLines(lines: vm.connectionLines)
        } else {
            Text(NO_TROUBLESHOOTING_PRINTER_TEXT).font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
        }
    }

    @ViewBuilder private var details: some View {
        SectionTitle(title: "Printer details")
        Text("What the printer says it is (~HI)\(vm.printer?.isBluetooth == true ? ", and what it said when the Bluetooth link came up" : "").")
            .font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.bottom, 6)
        if !vm.hostIdLines.isEmpty {
            DetailLines(lines: vm.hostIdLines)
            if let ms = vm.hostIdMilliseconds {
                Text("Answered in \(ms) ms").font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 2)
            }
        }
        if vm.reachProblem?.action == .details {
            reachCard([.details])
        } else if let error = vm.detailsError {
            Text(error).font(KioskType.bodySmall).foregroundStyle(ChipTone.red.text)
        }
        if !vm.deviceInfoLines.isEmpty {
            Text("Device Information (Bluetooth)").font(KioskType.labelLarge).foregroundStyle(palette.text).padding(.top, 10).padding(.bottom, 4)
            DetailLines(lines: vm.deviceInfoLines)
        }
        HStack(spacing: 12) {
            SecondaryButton(vm.hostId == nil ? "Read details" : "Read again", enabled: canCall) { vm.readDetails() }
            if vm.running == .details { ProgressView().tint(palette.accent) }
        }
        .padding(.top, 8)
    }

    @ViewBuilder private var asking: some View {
        SectionTitle(title: "Ask the printer")
        Text("Each button sends one question and shows the reply as the printer sent it.")
            .font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.bottom, 8)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8, alignment: .leading)], alignment: .leading, spacing: 8) {
            ForEach(PrinterAsk.allCases, id: \.self) { ask in
                SecondaryButton(ask.label, enabled: canCall) { vm.ask(ask) }
            }
        }
        if vm.running == .ask || vm.running == .command {
            HStack(spacing: 8) {
                ProgressView().tint(palette.accent)
                Text("Waiting for the printer…").font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
            }
            .padding(.top, 8)
        }
        reachCard([.ask, .command])
        if vm.showsCommandBox {
            SettingsRow(title: "Send a command", detail: "Admins and developers only: a command can change the printer's settings.") {
                HStack(spacing: 8) {
                    TextField("! U1 getvar \"device.languages\"", text: $vm.commandText)
                        .font(KioskType.mono(15))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.asciiCapable)
                        .submitLabel(.send)
                        .onSubmit { vm.sendCommand() }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 48)
                        .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
                        .accessibilityLabel("Printer command")
                    SecondaryButton("Send", enabled: canCall && !kotlinTrimmed(vm.commandText).isEmpty) { vm.sendCommand() }
                }
                Text("Sent as typed, with CR LF at the end. Curly quotes go as straight ones.")
                    .font(KioskType.bodySmall).foregroundStyle(palette.textMute)
                    .fixedSize(horizontal: false, vertical: true).padding(.top, 4)
            }
        }
        ForEach(vm.asks.reversed()) { result in
            AskResultCard(result: result).padding(.top, 8)
        }
    }

    @ViewBuilder private var speedTest: some View {
        SectionTitle(title: "Speed test")
        Text("Prints labels of a set size and times how long each takes to send.\(vm.speedSize.map { " They print on \($0.label) labels at \($0.dpi) dpi." } ?? "")")
            .font(KioskType.bodySmall).foregroundStyle(palette.textMute)
        SettingsRow(title: "Label data") {
            Segmented(options: TroubleshootingModel.SPEED_SIZES_KB.map { ($0, "\($0) KB") }, selection: $vm.speedKb)
                .disabled(vm.running == .speed)
        }
        SettingsRow(title: "Labels") {
            Segmented(options: TroubleshootingModel.SPEED_RUN_COUNTS.map { ($0, "\($0)") }, selection: $vm.speedRuns)
                .disabled(vm.running == .speed)
        }
        HStack(spacing: 12) {
            if vm.running == .speed {
                SecondaryButton(vm.speedStopping ? "Stopping…" : "Stop", enabled: !vm.speedStopping) { vm.stopSpeedTest() }
                ProgressView().tint(palette.accent)
                Text(vm.speedStopping ? "Stopping after label \(vm.speedRunNow) finishes sending…" : "Sending label \(vm.speedRunNow)…")
                    .font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                SecondaryButton(vm.speedRuns == 1 ? "Print 1 label" : "Print \(vm.speedRuns) labels", enabled: canCall) {
                    if vm.speedNeedsConfirm { confirmSpeed = true } else { vm.startSpeedTest() }
                }
            }
        }
        .padding(.top, 10)
        reachCard([.speed])
        Text(SPEED_END_TEXT).font(KioskType.bodyMedium).foregroundStyle(ChipTone.amber.text).padding(.top, 8)
        if !vm.speedRows.isEmpty {
            SpeedTable(rows: vm.speedRows).padding(.top, 8)
            if let average = vm.speedAverage {
                Text("Average \(String(format: "%.2f", average)) KB/s").font(KioskType.titleMedium).foregroundStyle(palette.text).padding(.top, 6)
            }
        }
    }

    @ViewBuilder private var cutSendTest: some View {
        SectionTitle(title: "Cut-send test")
        Text("Developers: sends half a sample label, marks it as a failed send, then sends a full sample label, which goes after ~JX. Only the full label should print, with no merged or extra label.")
            .font(KioskType.bodySmall).foregroundStyle(palette.textMute)
        HStack(spacing: 12) {
            SecondaryButton("Run cut-send test", enabled: canCall) { vm.runCutSendTest() }
            if vm.running == .cutSend { ProgressView().tint(palette.accent) }
        }
        .padding(.top, 8)
        if vm.reachProblem?.action == .cutSend {
            reachCard([.cutSend])
        } else {
            KioskToast(text: vm.cutSendMessage, error: vm.cutSendError)
        }
    }

    @ViewBuilder private var bluetoothScan: some View {
        SectionTitle(title: "Bluetooth scan")
        Text("Lists every Bluetooth device nearby with its signal, to see whether the printer can be heard. Nothing is saved here: choose a printer in Printer Setup.")
            .font(KioskType.bodySmall).foregroundStyle(palette.textMute)
        HStack(spacing: 12) {
            if vm.scanning {
                SecondaryButton("Stop") { vm.stopScan() }
                ProgressView().tint(palette.accent)
                Text("Listening for devices…").font(KioskType.bodyMedium).foregroundStyle(palette.textMute)
            } else {
                // Not during a speed test: a scan shares the radio and would lower its KB/s.
                SecondaryButton(vm.found == nil ? "Scan" : "Scan again", enabled: vm.running != .speed) { vm.scan() }
            }
        }
        .padding(.top, 8)
        KioskToast(text: vm.scanMessage, error: vm.scanMessage.map { $0 != NOTHING_HEARD_TEXT && $0 != SCAN_CUT_SHORT_TEXT } ?? false)
        if vm.scanMessage == BLUETOOTH_DENIED_TEXT { OpenSettingsButton() }
        ForEach(vm.found ?? []) { device in
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(device.name).font(KioskType.mono(15)).fontWeight(.semibold).foregroundStyle(palette.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if isSaved(device) { KioskChip(text: "Saved printer", tone: .amber, dot: false) }
                    if device.isZebra { KioskChip(text: "Zebra", tone: .green, dot: false) }
                }
                Text(bluetoothSignalText(rssi: device.rssi)).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
            }
            .padding(.vertical, 8)
            Rectangle().fill(palette.paperLine).frame(height: 1)
        }
        Text(BLUETOOTH_SCAN_HINT_TEXT).font(KioskType.bodySmall).foregroundStyle(palette.textMute).padding(.top, 8)
    }

    @ViewBuilder private var report: some View {
        SectionTitle(title: "Report")
        Text("Copy or share everything above as text: this device and app, the printer, every reply and speed result, and the last \(TroubleshootingModel.LOG_CAP.formatted()) log lines (\(vm.logLines.count) so far) with the Bluetooth link's own events.")
            .font(KioskType.bodySmall).foregroundStyle(palette.textMute)
        HStack(spacing: 12) {
            SecondaryButton(copied ? "Copied" : "Copy") {
                UIPasteboard.general.string = vm.report().text
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    copied = false
                }
            }
            ShareLink(item: TroubleshootingReportFile(vm: vm), preview: SharePreview("Printer report")) {
                Text("Share")
                    .font(KioskType.labelLarge)
                    .foregroundStyle(palette.text)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 48)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 8)
    }

    /// What the last call met in one of `sections` and the crew fixes on the iPad, as on Print Labels:
    /// its words, with Open Settings (Bluetooth not allowed) or Connect (a printer that forgot this
    /// iPad; no Open Settings, which can't reach Settings › Bluetooth: Ruling 15).
    @ViewBuilder private func reachCard(_ sections: Set<TroubleAction>) -> some View {
        if let reach = vm.reachProblem, sections.contains(reach.action) {
            KioskToast(text: reach.problem.text, error: true)
            if reach.problem.offersSettings || reach.problem.offersConnect {
                HStack(spacing: 8) {
                    if reach.problem.offersSettings { OpenSettingsButton() }
                    if reach.problem.offersConnect {
                        SecondaryButton(vm.running == .details ? "Connecting…" : "Connect", enabled: canCall) { vm.connectAgain() }
                    }
                }
                .padding(.bottom, 8)
            }
        }
    }

    /// The device is the saved Bluetooth printer (by the iPad's identifier, or its name, which is its serial).
    private func isSaved(_ device: FoundBluetoothPrinter) -> Bool {
        guard case .bluetooth(let serial, let id)? = vm.printer?.connection else { return false }
        return id == device.id || serial.uppercased() == device.name.uppercased()
    }
}

// MARK: Pieces

/// Label and value rows, the value monospaced and selectable.
private struct DetailLines: View {
    let lines: [DetailLine]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(lines, id: \.self) { line in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(line.label).font(KioskType.bodySmall).foregroundStyle(palette.textMute).frame(width: 130, alignment: .leading)
                    Text(line.value).font(KioskType.mono(13)).foregroundStyle(palette.text).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

/// One ask's result: the command, bytes and time, what it means or why it failed, and the reply.
private struct AskResultCard: View {
    let result: AskResult
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(result.label).font(KioskType.titleMedium).foregroundStyle(palette.text)
                // A command that replies nothing (a setvar) went out: "Sent", not "Failed".
                if result.error != nil {
                    KioskChip(text: "Failed", tone: .red, dot: false)
                } else if result.reply.isEmpty {
                    KioskChip(text: "Sent", tone: .slate, dot: false)
                } else {
                    KioskChip(text: "Answered", tone: .green, dot: false)
                }
                Spacer(minLength: 0)
                Text(result.at.formatted(date: .omitted, time: .standard)).font(KioskType.bodySmall).foregroundStyle(palette.textMute)
            }
            Text("Command: \(visibleCommand(result.command))").font(KioskType.mono(12)).foregroundStyle(palette.text)
                .fixedSize(horizontal: false, vertical: true)
            Text("\(result.bytes) B in \(result.milliseconds.map(String.init) ?? "?") ms").font(KioskType.bodySmall).foregroundStyle(palette.textMute)
            if let meaning = result.meaning {
                Text(meaning).font(KioskType.bodySmall).foregroundStyle(palette.text).fixedSize(horizontal: false, vertical: true)
            }
            if let error = result.error {
                Text(error).font(KioskType.bodySmall).foregroundStyle(ChipTone.red.text).fixedSize(horizontal: false, vertical: true)
            }
            if !result.reply.isEmpty {
                ReplyBox(text: visibleBytes(result.reply))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(palette.paper, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.paperLine, lineWidth: 1))
    }
}

/// A raw reply, monospaced and selectable; a long one scrolls in a 240 pt box. (Decided by length:
/// inside the page's ScrollView the height is unbounded, so ViewThatFits never switches.)
private struct ReplyBox: View {
    let text: String
    @Environment(\.kioskPalette) private var palette

    private var long: Bool { text.count > 1200 || text.filter { $0 == "\n" }.count > 14 }

    var body: some View {
        Group {
            if long {
                ScrollView { content }.frame(height: 240)
            } else {
                content
            }
        }
        .background(palette.paper2, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.paperLine, lineWidth: 1))
    }

    private var content: some View {
        Text(text).font(KioskType.mono(12)).foregroundStyle(palette.text).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
    }
}

/// The speed test's labels: size, seconds and KB/s (or why one failed).
private struct SpeedTable: View {
    let rows: [SpeedRow]
    @Environment(\.kioskPalette) private var palette

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow {
                    ForEach(["Label", "KB", "Bytes", "Seconds", "KB/s"], id: \.self) { heading in
                        Text(heading).font(KioskType.labelSmall).foregroundStyle(palette.textMute)
                    }
                }
                ForEach(rows) { row in
                    GridRow {
                        Text("\(row.run)")
                        Text("\(row.targetKb)")
                        Text("\(row.bytes)")
                        if let error = row.error {
                            Text(error).foregroundStyle(ChipTone.red.text).gridCellColumns(2)
                        } else {
                            Text(row.seconds.map { String(format: "%.2f", $0) } ?? "-")
                            Text(row.kbPerSecond.map { String(format: "%.2f", $0) } ?? "-")
                        }
                    }
                    .font(KioskType.mono(12))
                    .foregroundStyle(palette.text)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

/// The report as a text file named printer-report-<yyyyMMdd-HHmmss>.txt, written when shared.
private struct TroubleshootingReportFile: Transferable {
    let vm: TroubleshootingModel

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .plainText) { file in
            let report = await file.vm.report()
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("printer-report", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(report.name)
            try Data(report.text.utf8).write(to: url, options: .atomic)
            return SentTransferredFile(url)
        }
    }
}
