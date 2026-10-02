import Testing
@testable import ServerSherpa_Kiosk

struct RfidTests {
    @Test func padsTo24AndUppercases() {
        let p = padRfid(" 10 03 48 ")
        #expect(p.tag == "000000000000000000100348")
        #expect(p.problem == nil)
        #expect(padRfid("abcd").tag == "00000000000000000000ABCD")
    }

    @Test func problems() {
        #expect(padRfid("   ").problem == .empty)
        #expect(padRfid("10-03").problem == .notAlphanumeric)
        #expect(padRfid(String(repeating: "1", count: 25)).problem == .tooLong)
        #expect(rfidProblemText(.empty) == "Scan the RFID tag.")
        #expect(rfidProblemText(.tooLong) == "That tag is longer than 24 characters.")
    }

    @Test func displayStripsLeadingZerosButKeepsOne() {
        #expect(displayRfid("000000000000000000100348") == "100348")
        #expect(displayRfid("0000") == "0")
        #expect(displayRfid(nil) == "—")
        #expect(displayRfid("") == "—")
    }
}
