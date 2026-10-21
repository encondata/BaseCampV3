import Testing
import Foundation
@testable import ServerSherpa_Kiosk

struct RawJsonTests {
    // Number literals, escapes and non-ASCII text the label generator must see as sent.
    private let first = #"{"id":"a1","raw_ft":{"RU":12.0,"Qty":7,"Tiny":1e-05,"Neg":-0.5E+3,"Flag":true,"Off":false,"None":null},"name":"é😀\"\\ é \/","nest":[[1,2.50],{"k":[]}]}"#
    private let second = #"{"id":"a2","label":{},"raw_ft":{}}"#

    @Test func arrayElementsAreTheExactTextSent() throws {
        let body = #"{"initiative_id":"i1","assets":["# + first + "," + second + #"],"label_context":{"move_name":"Move A","n":3.0}}"#
        let elements = try RawJson.arrayElements(of: body, key: "assets")
        #expect(elements == [first, second])
        #expect(elements[0].contains(#""RU":12.0,"Qty":7,"Tiny":1e-05,"Neg":-0.5E+3,"Flag":true,"Off":false,"None":null"#))
        #expect(elements[0].contains(#""name":"é😀\"\\ é \/""#))
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
        #expect(try RawJson.arrayElements(of: #"{"assets":[2]}"#, key: "assets") == ["2"])
    }

    @Test func malformedTextThrows() {
        for bad in [#"["#, #"[1]"#, #"{"assets":[1,]}"#, #"{"assets":[1}"#, #"{"assets":"open}"#, #"{"a":01}"#,
                    #"{"a":1.}"#, #"{"a":tru}"#, #"{"a":1} x"#, #"{"a":"\q"}"#, "{\"a\":\"\u{01}\"}", ""] {
            #expect(throws: RawJson.Malformed.self, "\(bad)") { try RawJson.arrayElements(of: bad, key: "a") }
        }
    }
}
