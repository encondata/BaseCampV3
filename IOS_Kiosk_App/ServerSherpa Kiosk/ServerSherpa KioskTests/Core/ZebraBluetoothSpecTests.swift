import Testing
import Foundation
@testable import ServerSherpa_Kiosk

/// The Bluetooth limits, UUIDs and copy the CoreBluetooth link is built on.
struct ZebraBluetoothSpecTests {
    @Test func zebraSerialNames() {
        #expect(ZebraBluetoothSpec.looksLikeZebraSerial("D8J224508535"))
        #expect(ZebraBluetoothSpec.looksLikeZebraSerial("50J123456789"))
        #expect(!ZebraBluetoothSpec.looksLikeZebraSerial("d8j224508535"))
        #expect(!ZebraBluetoothSpec.looksLikeZebraSerial("D8J22450853"))
        #expect(!ZebraBluetoothSpec.looksLikeZebraSerial("D8J2245085355"))
        #expect(!ZebraBluetoothSpec.looksLikeZebraSerial("James’s Mac mini"))
        #expect(!ZebraBluetoothSpec.looksLikeZebraSerial("N017E"))
        #expect(!ZebraBluetoothSpec.looksLikeZebraSerial(""))
        // a line break after a good name is not part of the name
        #expect(!ZebraBluetoothSpec.looksLikeZebraSerial("D8J224508535\n"))
    }

    @Test func sendBudgetGrowsWithSize() {
        #expect(ZebraBluetoothSpec.sendBudget(bytes: 0) == 15)
        #expect(ZebraBluetoothSpec.sendBudget(bytes: 2048) == 16)
        #expect(abs(ZebraBluetoothSpec.sendBudget(bytes: 170_000) - 98.0) < 0.1)
    }

    @Test func theLimitsAreTheSpecifiedOnes() {
        #expect(ZebraBluetoothSpec.connectReady == 10)
        #expect(ZebraBluetoothSpec.queryIdle == 2)
        #expect(ZebraBluetoothSpec.queryTotal == 5)
        #expect(ZebraBluetoothSpec.drainQuiet == 0.3)
        #expect(ZebraBluetoothSpec.drainMax == 1)
        #expect(ZebraBluetoothSpec.reconnectTries == 3)
        #expect(ZebraBluetoothSpec.reconnectSpacing == 3)
        #expect(ZebraBluetoothSpec.scanDuration == 30)
    }

    @Test func theUuidsAreZebrasAndTheStandardDeviceInformationOnes() {
        #expect(ZebraBluetoothSpec.serviceUUID == "38EB4A80-C570-11E3-9507-0002A5D5C51B")
        #expect(ZebraBluetoothSpec.fromPrinterUUID == "38EB4A81-C570-11E3-9507-0002A5D5C51B")
        #expect(ZebraBluetoothSpec.toPrinterUUID == "38EB4A82-C570-11E3-9507-0002A5D5C51B")
        #expect(ZebraBluetoothSpec.deviceInfoUUID == "180A")
        #expect(ZebraBluetoothSpec.manufacturerUUID == "2A29")
        #expect(ZebraBluetoothSpec.modelUUID == "2A24")
        #expect(ZebraBluetoothSpec.serialUUID == "2A25")
        #expect(ZebraBluetoothSpec.firmwareUUID == "2A26")
        #expect(ZebraBluetoothSpec.linkOsUUID == "2A28")
    }

    @Test func theCopyIsTheAgreedWording() {
        #expect(BLUETOOTH_OFF_TEXT == "Turn on Bluetooth to reach the printer.")
        #expect(BLUETOOTH_DENIED_TEXT == "Allow Bluetooth for ServerSherpa Kiosk in Settings to reach the printer.")
        #expect(BLUETOOTH_SCAN_HINT_TEXT == "Don't see the printer? Hold FEED on the printer for 5 seconds (the middle light blinks), then scan again. A Zebra's Bluetooth name is its serial number, like D8J224508535.")
        #expect(FONT_INSTALL_CUT_TEXT == "The font install was cut off. Turn the printer off and on, then tap Check again.")
        // Ruling 15: iOS can't open Settings › Bluetooth from an app, so the steps say where to go.
        #expect(pairingLostText(serial: "D8J224508535") == "The printer forgot this iPad. In the iPad's Settings app, open Bluetooth, tap ⓘ next to D8J224508535, choose Forget This Device, then come back and tap Connect.")
    }

    @Test func theClearCommandIsCancelPartialFormat() {
        #expect(ZebraCommands.cancelPartialFormat == "~JX")
    }
}
