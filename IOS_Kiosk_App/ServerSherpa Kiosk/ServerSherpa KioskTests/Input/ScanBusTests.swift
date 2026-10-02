import Testing
@testable import ServerSherpa_Kiosk

@MainActor
struct ScanBusTests {
    @Test func deliversToTheActiveListener() async {
        let bus = ScanBus()
        var it = bus.events().makeAsyncIterator()
        bus.publish(ScanEvent(value: " A-1 ", source: .keyboard, symbology: nil))
        bus.publish(ScanEvent(value: "", source: .camera, symbology: nil)) // blank: dropped
        bus.publish(ScanEvent(value: "B-2", source: .camera, symbology: "QR_CODE"))
        let first = await it.next()
        let second = await it.next()
        #expect(first == ScanEvent(value: "A-1", source: .keyboard, symbology: nil))
        #expect(second == ScanEvent(value: "B-2", source: .camera, symbology: "QR_CODE"))
    }

    @Test func whitespaceOnlyValuesAreDropped() async {
        let bus = ScanBus()
        var it = bus.events().makeAsyncIterator()
        bus.publish(ScanEvent(value: "  \n\t ", source: .keyboard, symbology: nil))
        bus.publish(ScanEvent(value: "X", source: .keyboard, symbology: nil))
        #expect(await it.next()?.value == "X")
    }

    @Test func aSecondListenerReplacesTheFirst() async {
        let bus = ScanBus()
        var first = bus.events().makeAsyncIterator()
        var second = bus.events().makeAsyncIterator()
        #expect(await first.next() == nil) // finished by the replacement
        bus.publish(ScanEvent(value: "Z", source: .camera, symbology: nil))
        #expect(await second.next()?.value == "Z")
    }

    @Test func anEventWithNoListenerIsDropped() async {
        let bus = ScanBus()
        bus.publish(ScanEvent(value: "lost", source: .keyboard, symbology: nil))
        var it = bus.events().makeAsyncIterator()
        bus.publish(ScanEvent(value: "kept", source: .keyboard, symbology: nil))
        #expect(await it.next()?.value == "kept")
    }
}
