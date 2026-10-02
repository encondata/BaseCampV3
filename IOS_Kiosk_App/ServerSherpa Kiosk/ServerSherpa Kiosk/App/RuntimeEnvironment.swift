import Foundation

/// What the process is running as. Inert outside tests.
enum RuntimeEnvironment {
    /// True when the app process is the host of a unit-test bundle. The host must
    /// never restore the live session, touch the Keychain, the network or the
    /// on-disk store (xcodebuild runs tests in a clone that copies the Keychain;
    /// a refresh there would trip the server's refresh-token reuse detection).
    /// UI tests launch a normal app process, which does not carry this variable.
    static var isUnitTestHost: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }
}
