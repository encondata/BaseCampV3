import Foundation
import Testing

struct CorePurityTests {
    @Test func coreImportsOnlyFoundation() throws {
        let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let core = tests.deletingLastPathComponent().appendingPathComponent("ServerSherpa Kiosk/Core")
        let files = FileManager.default.enumerator(at: core, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        #expect(!files.isEmpty, "Core/ has no Swift files at \(core.path)")
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for line in text.split(separator: "\n") where line.hasPrefix("import ") {
                #expect(line == "import Foundation", "\(file.lastPathComponent): \(line)")
            }
        }
    }
}
