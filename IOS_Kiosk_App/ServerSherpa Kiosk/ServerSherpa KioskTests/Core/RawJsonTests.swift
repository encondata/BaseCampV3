import Testing
import Foundation
@testable import ServerSherpa_Kiosk

struct RawJsonTests {
    // Number literals, escapes and non-ASCII text the label generator must see as sent.
    private let first = #"{"id":"a1","raw_ft":{"RU":12.0,"Qty":7,"Tiny":1e-05,"Neg":-0.5E+3,"Flag":true,"Off":false,"None":null},"name":"é😀\"\\ \u00e9 \/","nest":[[1,2.50],{"k":[]}]}"#
    private let second = #"{"id":"a2","label":{},"raw_ft":{}}"#

    @Test func arrayElementsAreTheExactTextSent() throws {
        let body = #"{"initiative_id":"i1","assets":["# + first + "," + second + #"],"label_context":{"move_name":"Move A","n":3.0}}"#
        let elements = try RawJson.arrayElements(of: body, key: "assets")
        #expect(elements == [first, second])
        #expect(elements[0].contains(#""RU":12.0,"Qty":7,"Tiny":1e-05,"Neg":-0.5E+3,"Flag":true,"Off":false,"None":null"#))
        #expect(elements[0].contains(#""name":"é😀\"\\ \u00e9 \/""#))
        #expect(try RawJson.member(of: body, key: "label_context") == #"{"move_name":"Move A","n":3.0}"#)
        #expect(try RawJson.member(of: body, key: "initiative_id") == #""i1""#)
    }

    @Test func whitespaceBetweenTokensIsKeptInsideAnElementButNotAround() throws {
        let body = "{ \"assets\" : [ {\"a\" : 1.0 ,\n \"b\":[ ]} ,\t7 , \"x\" , null , true ] }"
        #expect(try RawJson.arrayElements(of: body, key: "assets") == ["{\"a\" : 1.0 ,\n \"b\":[ ]}", "7", "\"x\"", "null", "true"])
    }

    @Test func scalarsAtTheTopOfAnArrayKeepTheirText() throws {
        let body = #"{"v":[12.0,1e-05,7,true,false,null,"é😀\"\\",-0,0.0e0]}"#
        #expect(try RawJson.arrayElements(of: body, key: "v") == ["12.0", "1e-05", "7", "true", "false", "null", #""é😀\"\\""#, "-0", "0.0e0"])
    }

    @Test func absentNullAndNonArrayMembersReadEmpty() throws {
        #expect(try RawJson.arrayElements(of: #"{"other":[1]}"#, key: "assets") == [])
        #expect(try RawJson.arrayElements(of: #"{"assets":null}"#, key: "assets") == [])
        #expect(try RawJson.arrayElements(of: #"{"assets":{"a":1}}"#, key: "assets") == [])
        #expect(try RawJson.arrayElements(of: #"{"assets":[]}"#, key: "assets") == [])
        #expect(try RawJson.member(of: #"{"label_context":null}"#, key: "label_context") == nil)
        #expect(try RawJson.member(of: #"{}"#, key: "label_context") == nil)
    }

    @Test func onlyTopLevelMembersMatch() throws {
        // A nested "assets" and a string holding `"assets":` never count.
        let body = #"{"note":"\"assets\":[9]","inner":{"assets":[8]},"assets":[1]}"#
        #expect(try RawJson.arrayElements(of: body, key: "assets") == ["1"])
    }

    @Test func escapedMemberNamesAreCompared() throws {
        // Written with escapes; the bytes really hold the backslashes.
        let spelled = #"{"\u0061\u0073\u0073\u0065\u0074\u0073":[1]}"#
        #expect(spelled.utf8.filter { $0 == UInt8(ascii: "\\") }.count == 6)
        #expect(try RawJson.arrayElements(of: spelled, key: "assets") == ["1"])
        #expect(try RawJson.arrayElements(of: #"{"\u0061ssets":[2]}"#, key: "assets") == ["2"])
        // A surrogate pair spells one emoji.
        let emoji = #"{"\ud83d\ude00":[2],"x":0}"#
        #expect(try RawJson.arrayElements(of: emoji, key: "😀") == ["2"])
        #expect(try RawJson.arrayElements(of: emoji, key: #"\ud83d\ude00"#) == [])
        // An escaped quote and backslash inside a member name.
        #expect(try RawJson.arrayElements(of: #"{"a\"b\\c":[3]}"#, key: #"a"b\c"#) == ["3"])
        #expect(try RawJson.member(of: #"{"\n\t":true}"#, key: "\n\t") == "true")
    }

    @Test func elementEscapesComeBackExactlyAsWritten() throws {
        let element = #"{"name":"\u00e9\ud83d\ude00","plain":"é😀","q":"\"\\\/\b\f\n\r\t"}"#
        let body = #"{"assets":["# + element + #","\u00e9"]}"#
        let out = try RawJson.arrayElements(of: body, key: "assets")
        #expect(out == [element, #""\u00e9""#])
        #expect(Array(out[0].utf8) == Array(element.utf8))
        #expect(out[0].contains(#""\u00e9\ud83d\ude00""#))
        #expect(out[0].contains("\"é😀\""))
    }

    @Test func oneScanReadsTheElementsAndTheMember() throws {
        let body = #"{"label_context":{"n":1.0},"assets":[{"id":"a"},7.50]}"#
        let both = try RawJson.arrayElementsAndMember(of: body, arrayKey: "assets", memberKey: "label_context")
        #expect(both.elements == [#"{"id":"a"}"#, "7.50"])
        #expect(both.member == #"{"n":1.0}"#)
        let none = try RawJson.arrayElementsAndMember(of: #"{"assets":[],"label_context":null}"#, arrayKey: "assets", memberKey: "label_context")
        #expect(none.elements == []); #expect(none.member == nil)
        #expect(throws: RawJson.Malformed.self) {
            try RawJson.arrayElementsAndMember(of: #"{"assets":[1,]}"#, arrayKey: "assets", memberKey: "label_context")
        }
    }

    @Test func nestingDeeperThanTheLimitThrows() throws {
        let ok = #"{"v":["# + String(repeating: "[", count: 500) + String(repeating: "]", count: 500) + "]}"
        #expect(try RawJson.arrayElements(of: ok, key: "v").count == 1)
        let deep = #"{"v":["# + String(repeating: "[", count: 600) + String(repeating: "]", count: 600) + "]}"
        #expect(throws: RawJson.Malformed.self) { try RawJson.arrayElements(of: deep, key: "v") }
        let objects = #"{"v":"# + String(repeating: #"{"a":"#, count: 600) + "1" + String(repeating: "}", count: 600) + "}"
        #expect(throws: RawJson.Malformed.self) { try RawJson.member(of: objects, key: "v") }
    }

    @Test func malformedTextThrows() {
        for bad in [#"["#, #"[1]"#, #"{"assets":[1,]}"#, #"{"assets":[1}"#, #"{"assets":"open}"#, #"{"a":01}"#,
                    #"{"a":1.}"#, #"{"a":tru}"#, #"{"a":1} x"#, #"{"a":"\q"}"#, "{\"a\":\"\u{01}\"}", ""] {
            #expect(throws: RawJson.Malformed.self, "\(bad)") { try RawJson.arrayElements(of: bad, key: "a") }
        }
    }
}
