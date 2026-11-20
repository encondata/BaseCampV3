import Foundation
import Testing
@testable import ServerSherpa_Kiosk

struct EnvironmentsTests {
    private func body(_ entries: String, version: String = "1") -> Data {
        Data(#"{"version": \#(version), "environments": [\#(entries)]}"#.utf8)
    }
    private func entry(_ id: String, _ name: String, _ domain: String) -> String {
        #"{"id":"\#(id)","name":"\#(name)","domain":"\#(domain)"}"#
    }
    private var good: String {
        entry("rc1", "RC1", "rc1.serversherpa.com") + "," + entry("qa", "QA", "qa.serversherpa.com")
    }

    @Test func builtInOrderAndUrls() {
        #expect(Environments.builtIn.map(\.id) == ["prod", "rc1", "uat", "beta", "alpha", "dev"])
        #expect(Environments.builtIn[0].apiUrl == "https://api.serversherpa.com")
        #expect(Environments.builtIn[2].portalUrl == "https://portal.uat.serversherpa.com")
        #expect(Environments.byId("uat")?.name == "UAT")
        #expect(Environments.byId("nope") == nil)
        let prods = Environments.builtIn.map { SavedEnvironment.named(id: $0.id, name: $0.name, domain: $0.domain) }
            .filter(\.isProd).map { _ in 1 }
        #expect(prods.count == 1)
        #expect(Environments.statusListURL == "https://status.serversherpa.com/environments.json")
        #expect(Environments.password == "cumulus")
        #expect(Environments.maxBody == 65536)
    }

    @Test func parseDropsBadEntriesKeepsGood() {
        let raw = body([
            entry("x", "X", "evil.com"),
            entry("y", "Y", "api.serversherpa.com:443"),
            entry("z", "Z", "serversherpa.com/p"),
            entry("Bad", "B", "b.serversherpa.com"),
            entry("rc1", "RC1", "rc1.serversherpa.com"),
            entry("rc1", "dup", "x.serversherpa.com"),
            entry("n", "  ", "n.serversherpa.com"),
        ].joined(separator: ","))
        #expect(Environments.parseList(raw) == [Env(id: "rc1", name: "RC1", domain: "rc1.serversherpa.com")])
    }

    @Test func parseDomainRules() {
        for bad in ["Evil.serversherpa.com", "a..serversherpa.com", "-a.serversherpa.com",
                    "a-.serversherpa.com", "xserversherpa.com", "serversherpa.com.evil.com",
                    "u@serversherpa.com", "http://serversherpa.com", "serversherpa.com\n", ""] {
            #expect(Environments.parseList(body(entry("ab", "N", bad))) == nil, "\(bad)")
        }
        #expect(Environments.parseList(body(entry("ab", "N", "a.b-c.serversherpa.com"))) != nil)
    }

    @Test func parseKeepsFileOrderAndTrimsName() throws {
        let envs = try #require(Environments.parseList(
            body(entry("qa", " QA ", "qa.serversherpa.com") + "," + entry("ab", "AB", "serversherpa.com"))))
        #expect(envs.map(\.id) == ["qa", "ab"])
        #expect(envs[0].name == "QA")
    }

    @Test func parseRejectsWrongVersionEmptyAndBadJson() {
        #expect(Environments.parseList(body(good, version: "2")) == nil)
        #expect(Environments.parseList(body(good, version: "\"1\"")) == nil)
        #expect(Environments.parseList(body(good, version: "true")) == nil)
        #expect(Environments.parseList(body(good, version: "1.0")) == nil)
        #expect(Environments.parseList(body(good, version: "null")) == nil)
        #expect(Environments.parseList(body("")) == nil)
        #expect(Environments.parseList(Data("{not json".utf8)) == nil)
        #expect(Environments.parseList(Data("[]".utf8)) == nil)
        #expect(Environments.parseList(Data(#"{"version":1}"#.utf8)) == nil)
        #expect(Environments.parseList(Data(#"{"version":1,"environments":{}}"#.utf8)) == nil)
        #expect(Environments.parseList(body(entry(String(repeating: "a", count: 30), String(repeating: "X", count: 70000),
                                                  "a.serversherpa.com"))) == nil)
        #expect(Environments.parseList(Data()) == nil)
    }

    @Test func parseCapsBytesNotCharacters() {
        // 'é' is two UTF-8 bytes: 33000 of them is under 65536 characters but over the byte cap.
        let wide = String(repeating: "é", count: 33000)
        #expect(Environments.parseList(body(entry("ab", wide, "a.serversherpa.com"))) == nil)
        let narrow = String(repeating: "e", count: 60000)
        #expect(Environments.parseList(body(entry("ab", narrow, "a.serversherpa.com"))) != nil)
    }

    @Test func parseIdRules() {
        for bad in ["a", "ab-", "1ab", String(repeating: "a", count: 33), "ab\n", "a_b"] {
            #expect(Environments.parseList(body(entry(bad, "N", "n.serversherpa.com"))) == nil, "\(bad)")
        }
        for ok in ["ab", "a-1", String(repeating: "a", count: 32)] {
            #expect(Environments.parseList(body(entry(ok, "N", "n.serversherpa.com"))) != nil, "\(ok)")
        }
    }

    @Test func parseSkipsNonObjectEntriesAndNonStringFields() throws {
        let raw = Data(#"""
        {"version":1,"environments":[1,"x",null,{"id":5,"name":"N","domain":"a.serversherpa.com"},
        {"id":"ab","name":7,"domain":"a.serversherpa.com"},{"id":"cd","name":"N"},
        {"id":"ef","name":"Ok","domain":"ef.serversherpa.com"}]}
        """#.utf8)
        #expect(try #require(Environments.parseList(raw)).map(\.id) == ["ef"])
    }

    @Test func isValidRevalidatesASavedNamedEnvironment() {
        #expect(Environments.isValid(Env(id: "uat", name: "UAT", domain: "uat.serversherpa.com")))
        #expect(!Environments.isValid(Env(id: "uat", name: " ", domain: "uat.serversherpa.com")))
        #expect(!Environments.isValid(Env(id: "uat", name: "UAT", domain: "evil.com")))
        #expect(!Environments.isValid(Env(id: "Uat", name: "UAT", domain: "uat.serversherpa.com")))
        #expect(!Environments.isValid(Env(id: "ab-", name: "UAT", domain: "uat.serversherpa.com")))
    }

    @Test func migrateNamedFromTypedApi() {
        let uat = SavedEnvironment.named(id: "uat", name: "UAT", domain: "uat.serversherpa.com")
        #expect(Environments.migrate(savedApi: "https://api.uat.serversherpa.com/", savedPortal: nil,
                                     defaultPortal: "https://portal.x") == uat)
        #expect(Environments.migrate(savedApi: " HTTPS://API.UAT.serversherpa.com:443 ", savedPortal: "http://other",
                                     defaultPortal: "https://portal.x") == uat)
        #expect(Environments.migrate(savedApi: "https://api.serversherpa.com", savedPortal: nil,
                                     defaultPortal: "https://portal.x")
            == .named(id: "prod", name: "Prod", domain: "serversherpa.com"))
    }

    @Test func migrateCustom() {
        #expect(Environments.migrate(savedApi: "http://10.10.48.103:8000", savedPortal: "http://10.10.48.103:5173/",
                                     defaultPortal: "https://portal.x")
            == .custom(apiUrl: "http://10.10.48.103:8000", portalUrl: "http://10.10.48.103:5173"))
        #expect(Environments.migrate(savedApi: "http://10.10.48.103:8000", savedPortal: nil,
                                     defaultPortal: "https://portal.x")
            == .custom(apiUrl: "http://10.10.48.103:8000", portalUrl: "https://portal.x"))
        // http, another port, a path, a query or user info is not the built-in address
        for api in ["http://api.uat.serversherpa.com", "https://api.uat.serversherpa.com:8443",
                    "https://api.uat.serversherpa.com/v1", "https://api.uat.serversherpa.com?x=1",
                    "https://user@api.uat.serversherpa.com", "https://user:pw@api.uat.serversherpa.com",
                    "https://api.uat.serversherpa.com#frag"] {
            let saved = Environments.migrate(savedApi: api, savedPortal: nil, defaultPortal: "p")
            guard case .custom = saved else { Issue.record("\(api) became \(String(describing: saved))"); continue }
        }
    }

    @Test func migrateAcceptsUnderscoreHostsAsCustom() {
        #expect(Environments.migrate(savedApi: "http://my_host:8000", savedPortal: nil, defaultPortal: "https://portal.x")
            == .custom(apiUrl: "http://my_host:8000", portalUrl: "https://portal.x"))
    }

    @Test func migrateNothingSaved() {
        #expect(Environments.migrate(savedApi: nil, savedPortal: nil, defaultPortal: "https://portal.x") == nil)
        #expect(Environments.migrate(savedApi: "  ", savedPortal: "http://p", defaultPortal: "https://portal.x") == nil)
        #expect(Environments.migrate(savedApi: "ftp://nope", savedPortal: nil, defaultPortal: "https://portal.x") == nil)
        #expect(Environments.migrate(savedApi: "http://", savedPortal: nil, defaultPortal: "https://portal.x") == nil)
    }

    @Test func serializationRoundTrip() throws {
        let named = SavedEnvironment.named(id: "uat", name: "UAT", domain: "uat.serversherpa.com")
        let custom = SavedEnvironment.custom(apiUrl: "http://a:1", portalUrl: "http://p:2")
        let namedData = try KioskJSON.encoder.encode(named)
        let customData = try KioskJSON.encoder.encode(custom)
        #expect(try JSONSerialization.jsonObject(with: namedData) as? [String: String]
            == ["kind": "named", "id": "uat", "name": "UAT", "domain": "uat.serversherpa.com"])
        #expect(try JSONSerialization.jsonObject(with: customData) as? [String: String]
            == ["kind": "custom", "api_url": "http://a:1", "portal_url": "http://p:2"])
        #expect(try KioskJSON.decoder.decode(SavedEnvironment.self, from: namedData) == named)
        #expect(try KioskJSON.decoder.decode(SavedEnvironment.self, from: customData) == custom)
        #expect(throws: (any Error).self) {
            try KioskJSON.decoder.decode(SavedEnvironment.self, from: Data(#"{"kind":"other"}"#.utf8))
        }
    }

    @Test func savedEnvironmentProperties() {
        let prod = SavedEnvironment.named(id: "prod", name: "Prod", domain: "serversherpa.com")
        let rc = SavedEnvironment.named(id: "rc1", name: "RC1", domain: "rc1.serversherpa.com")
        let custom = SavedEnvironment.custom(apiUrl: "http://a:1", portalUrl: "http://p:2")
        #expect(prod.isProd); #expect(!rc.isProd); #expect(!custom.isProd)
        #expect(rc.apiUrl == "https://api.rc1.serversherpa.com")
        #expect(prod.portalUrl == "https://portal.serversherpa.com")
        #expect(custom.apiUrl == "http://a:1"); #expect(custom.portalUrl == "http://p:2")
        #expect(rc.label == "RC1"); #expect(custom.label == "Custom")
    }
}
