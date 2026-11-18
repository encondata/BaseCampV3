import Foundation
import Testing
@testable import ServerSherpa_Kiosk

// A ZD421-300dpi's `~HS` reply (2026-10-19 over port 9100): its third string is the printer's
// front-panel password (0000) and a flag.
private let HS_REPLY = "\u{02}030,0,0,0612,000,0,0,0,000,0,0,0\u{03}\r\n\u{02}000,0,0,0,0,1,6,0,00000000,1,000\u{03}\r\n\u{02}0000,0\u{03}\r\n"

/// What the Troubleshooting report masks before it is copied or shared (Android's
/// `TroubleshootingModelTest` redaction cases, ported one for one): bearer tokens, JWTs, values of
/// names that say they are secrets (quoted, unquoted, JSON and SGD forms), URL passwords, the
/// replies to a secret setting, and `~HS`'s front-panel password. A line that can't be checked is
/// replaced whole.
struct SecretRedactionTests {
    /// `unit` repeated to `n` characters (every unit here is ASCII).
    private func run(_ unit: String, _ n: Int) -> String {
        String(String(repeating: unit, count: n / unit.count + 1).prefix(n))
    }

    private func milliseconds(_ work: () -> Void) -> Int {
        let elapsed = ContinuousClock().measure(work)
        return Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
    }

    @Test func redactionHidesEachQuotedFormWhole() {
        #expect(redactSecrets("! U1 setvar \"wlan.wpa.psk\" \"a b c\"␍␊") == "! U1 setvar \"wlan.wpa.psk\" \"[redacted]\"␍␊")
        #expect(redactSecrets("password: \"a b c\" next") == "password: \"[redacted]\" next")
        #expect(redactSecrets("token='a \"b\" c' next") == "token='[redacted]' next")
        #expect(redactSecrets("{\"api_key\": \"a b c\", \"user\": \"tina\"}") == "{\"api_key\": \"[redacted]\", \"user\": \"tina\"}")
        #expect(redactSecrets("password=\"a \\\"b\\\" c\" next") == "password=\"[redacted]\" next")
        #expect(redactSecrets("passphrase: \"a b c") == "passphrase: \"[redacted]\"")
        // Unquoted values end at a space or a delimiter, as before.
        #expect(redactSecrets("password=hunter2&token=abc.def") == "password=[redacted]&token=[redacted]")
        // A setting whose name says nothing secret is left alone.
        #expect(redactSecrets("! U1 setvar \"print.tone\" \"10\"") == "! U1 setvar \"print.tone\" \"10\"")
    }

    /// Bearer tokens and JSON web tokens go wherever they are.
    @Test func bearerTokensAndJwtsAreMasked() {
        let token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0aW5hIn0.c2VjcmV0LXRva2VuLTdmM2E"
        #expect(redactSecrets("sent Bearer abc.def-ghi to the printer") == "sent Bearer [redacted] to the printer")
        #expect(redactSecrets("the token \(token) leaked") == "the token [redacted] leaked")
        #expect(!redactSecrets("Authorization: Bearer \(token); station_key=sk-9c41").contains("9c41"))
        #expect(!redactSecrets("Authorization: Bearer \(token); station_key=sk-9c41").contains("eyJ"))
    }

    /// The redaction patterns stay linear on long runs a pasted label or a 64 KB one-line reply can
    /// hold (each was seconds to minutes before they were anchored and bounded).
    @Test func redactionStaysFastOnLongRuns() {
        let inputs = [
            ("a hex run", run("0123456789ABCDEF", 100_000)),
            ("a repeated secret word", run("password", 100_000)),
            ("\"password \" over and over", run("password ", 100_000)),
            ("a repeated short secret word", run("pin_", 100_000)),
            ("a repeated token start", run("eyJ-", 100_000)),
            ("secret names with separators", run("wlan.wpa.psk=", 100_000)),
            ("URL starts", run("a://b:c", 100_000)),
            ("an object that never closes", "psk:" + run("{\"a\":", 100_000)),
            ("nested arrays", "\"tokens\":" + run("[", 100_000)),
            ("escaped tabs after a separator", "password:" + run("<09>", 100_000)),
            ("chained secrets", run("password=token=", 100_000)),
            ("chained quoted secrets", run("psk:'a' ", 100_000)),
            ("Authorization headers", run("Authorization: Basic ", 100_000)),
        ]
        _ = redactSecrets(run("password ", 1_000)) // warm up
        for (what, text) in inputs {
            let ms = milliseconds { _ = redactSecrets(text) }
            #expect(ms < 1_000, "\(what) took \(ms) ms")
        }
    }

    /// `pin` and `pwd` are secret only as a whole part of a name (`bluetooth.bluetooth_pin`), never
    /// inside an ordinary word (`spinning`, `mapping`, `ping`).
    @Test func pinAndPwdAreSecretOnlyAsAWholePartOfAName() {
        #expect(redactSecrets("! U1 setvar \"bluetooth.bluetooth_pin\" \"1234\"") == "! U1 setvar \"bluetooth.bluetooth_pin\" \"[redacted]\"")
        #expect(redactSecrets("pwd=hunter2 pin: 0000") == "pwd=[redacted] pin: [redacted]")
        for plain in ["spinning: yes", "mapping=on", "ping: 12 ms", "\"print.spin_count\" \"3\"", "pinned: 2", "dpi: 300"] {
            #expect(redactSecrets(plain) == plain)
        }
    }

    /// A secret's name is masked whatever its length: a bound on it would fail open.
    @Test func aSecretNameOfAnyLengthIsMasked() {
        for n in [65, 200, 10_000] {
            let pad = String(repeating: "x", count: n)
            for line in [
                "\(pad)password=hunter2",
                "password\(pad)=hunter2",
                "\(pad).wlan.wpa.psk\(pad): \"hunter2 a b\"",
                "! U1 setvar \"\(pad).wpa.psk\" \"hunter2 a b\"",
                "{\"\(pad)_api_key\": \"hunter2\"}",
            ] {
                let out = redactSecrets(line)
                #expect(!out.contains("hunter2"), "\(n): \(out.suffix(80))")
                #expect(out.contains("[redacted]"), "\(n): \(out.suffix(80))")
            }
        }
    }

    /// A quoted secret of a million characters, or of 100,000 escaped quotes, is hidden whole and
    /// quickly (a regex recursing once a character overflowed the stack at about 2,000).
    @Test func longQuotedSecretsAreHiddenWholeAndQuickly() {
        let lines = [
            ("a 1,000,000-character value", "password: \"" + String(repeating: "a", count: 1_000_000) + "\" next"),
            ("100,000 escaped quotes", "password: \"" + String(repeating: "\\\"", count: 100_000) + "\" next"),
            ("a 1,000,000-character single-quoted value", "password: '" + String(repeating: "b ", count: 500_000) + "' next"),
            ("a 1,000,000-character value never closed", "password: \"" + String(repeating: "c", count: 1_000_000)),
        ]
        for (what, line) in lines {
            var out = ""
            let ms = milliseconds { out = redactSecrets(line) }
            #expect(ms < 1_000, "\(what) took \(ms) ms")
            #expect(out.count < 40, "\(what): \(out.prefix(80))")
            #expect(out.hasPrefix("password: ") && out.contains("[redacted]"), "\(what): \(out.prefix(80))")
        }
    }

    private struct StackOverflowStandIn: Error {}
    private struct StateError: LocalizedError { var errorDescription: String? { "password=hunter2" } }
    private struct IndexError: Error {}

    /// A line whose redaction fails is replaced whole: never a crash, never the line as it was.
    @Test func aRedactionThatFailsMasksTheWholeLine() {
        for failure: Error in [StackOverflowStandIn(), StateError(), IndexError()] {
            let out = redactSecrets("password=hunter2 and more") { _ in throw failure }
            #expect(out == REDACTION_FAILED_TEXT)
        }
        #expect(REDACTION_FAILED_TEXT == "[redacted: this line couldn't be checked for secrets]")
        #expect(redactSecrets("print.tone: 10") == "print.tone: 10")
    }

    /// A lowercase-to-uppercase step, an acronym's end and a digit start a new word part:
    /// `userPin`, `adminPwd`, `apiKey`, `pin2` and `PINCode` are secrets' names; `spinning`,
    /// `mapping`, `ping`, `pinned`, `dpi` and `Shipping` aren't.
    @Test func camelCaseAndDigitsSplitWordParts() {
        #expect(redactSecrets("userPin=1234") == "userPin=[redacted]")
        #expect(redactSecrets("adminPwd: x") == "adminPwd: [redacted]")
        #expect(redactSecrets("apiKey=y") == "apiKey=[redacted]")
        #expect(redactSecrets("pin2=z") == "pin2=[redacted]")
        #expect(redactSecrets("userPIN=1 PINCode=2") == "userPIN=[redacted] PINCode=[redacted]")
        #expect(redactSecrets("\"bluetooth.bluetoothPin\" \"1234\"") == "\"bluetooth.bluetoothPin\" \"[redacted]\"")
        for plain in [
            "spinning: yes", "mapping=on", "ping: 12", "pinned: 2", "dpi: 300", "Shipping: 3",
            "Spinning=1", "shippingPinball=4", "\"head.resolution.in_dpi\" \"300\"",
        ] {
            #expect(redactSecrets(plain) == plain)
        }
    }

    /// `~HS`'s front-panel password is hidden however the command was typed.
    @Test func thePanelPasswordIsHiddenWhateverTheCaseOrSpacing() {
        for command in ["~HS", " ~hs ", "~Hs\r\n", "\t~HS\r\n"] {
            let shown = withoutPanelPassword(command: command, reply: HS_REPLY)
            #expect(shown.contains("\u{02}****,0\u{03}"), "\(command)")
            #expect(!shown.contains("\u{02}0000,0\u{03}"), "\(command)")
        }
        #expect(withoutPanelPassword(command: "~HI", reply: HS_REPLY) == HS_REPLY)
    }

    /// A compound command with `~HS` in it still hides the front-panel password.
    @Test func aCompoundStatusCommandHidesThePanelPassword() {
        for command in ["~HS~HI", "~HS\r\n~HS", "~HS ~HS", "^XA~HS^XZ", "~hi~hs"] {
            let shown = withoutPanelPassword(command: command, reply: HS_REPLY)
            #expect(!shown.contains("\u{02}0000,0\u{03}"), "\(command)")
            #expect(shown.contains("\u{02}****,0\u{03}"), "\(command)")
        }
    }

    /// A getvar of a setting whose name says it is a secret: its reply is that secret.
    @Test func aGetvarOfASecretSettingAsksForASecret() {
        for command in ["! U1 getvar \"wlan.wpa.psk\"\r\n", "! U1 getvar \"wlan.private_key_password\"\r\n",
                        "! U1 GETVAR  \"bluetooth.bluetooth_pin\"", "! U1 getvar \"ip.addr\" ! U1 getvar \"wlan.wep.key1\""] {
            #expect(asksForASecret(command), "\(command)")
        }
        for command in ["! U1 getvar \"head.resolution.in_dpi\"\r\n", "! U1 getvar \"device.unique_id\"\r\n", "~HS", "! U1 setvar \"wlan.wpa.psk\" \"x\""] {
            #expect(!asksForASecret(command), "\(command)")
        }
    }

    /// A masked unquoted value never swallows the next secret's name and leaves its value showing:
    /// quoted values are masked first, across the line, then unquoted ones (as the regex did).
    @Test func aSecretAfterAnotherSecretsSeparatorIsStillMasked() {
        let cases = [
            ("Cookie: session_id=\"hunter2 abc\"", "Cookie: [redacted]\"[redacted]\""),
            ("Cookie: session_id = \"hunter2 abc\"", "Cookie: [redacted] = \"[redacted]\""),
            ("password=token=\"hunter2 abc\"", "password=[redacted]\"[redacted]\""),
            ("Authorization: token=\"hunter2\"", "Authorization: [redacted]\"[redacted]\""),
            ("password=wlan.wpa.psk\" \"hunter2 x\"", "password=[redacted]\" \"[redacted]\""),
            ("    password: psk = 'hunter2 abc'␍␊", "    password: [redacted] = '[redacted]'␍␊"),
        ]
        for (line, masked) in cases { #expect(redactSecrets(line) == masked, "\(line)") }
    }

    /// What the differential fuzz against the old regex found (each leaked `ZZ` before its fix): a
    /// masked value that ends in a separator takes the next value, an object's mask takes what is
    /// glued to its close, an object's mask never hides the next secret's name, and a URL's
    /// password goes last so it can't hide a secret's name.
    @Test func whatTheFuzzFoundStaysMasked() {
        for line in [
            "PinPin=__session_idx= ZZ&x",
            "pin\"2pin:api_key\":ZZ,",
            "pin:{}ZZZZ",
            "2token={passwordapi_key}xZZuser{",
            "x.Pinpassword:{}.Cookie=\"ZZ",
            "Bearer spin.://;Pin~HSpIn:pinCookie=psk@ZZ{␍␊",
            "pin:<09> [;Cookie: ZZ://]Z",
        ] {
            #expect(!redactSecrets(line).contains("ZZ"), "\(line) -> \(redactSecrets(line))")
        }
    }

    /// `pin` and `pwd` in any mix of cases are secrets' names too; ordinary words still aren't.
    @Test func mixedCasePinAndPwdAreSecretNames() {
        for name in ["pIn", "PiN", "pWd", "PwD", "x.pIn", "PiN2"] { #expect(redactSecrets("\(name)=1234") == "\(name)=[redacted]") }
        for plain in ["spinning: yes", "mapping=on", "ping: 12", "pinned: 2", "dpi: 300", "Shipping: 3", "SpInNiNg: 1"] {
            #expect(redactSecrets(plain) == plain)
        }
    }

    /// A control byte shown as `<XX>` (a tab is `<09>`) counts as the space it was around a
    /// separator, and never ends or hides a value.
    @Test func aControlByteShownAsAnEscapeIsNoWayAround() {
        let cases = [
            ("password:<09>hunter2␍␊", "password:<09>[redacted]␍␊"),
            ("! U1 setvar \"wlan.wpa.psk\"<09>\"hunter2 x\"␍␊", "! U1 setvar \"wlan.wpa.psk\"<09>\"[redacted]\"␍␊"),
            ("    {\"password\":<09>\"hunter2\"}␍␊", "    {\"password\":<09>\"[redacted]\"}␍␊"),
            ("    password=hun<01>ter2␍␊", "    password=[redacted]␍␊"),
            ("password=<01>hunter2", "password=[redacted]"),
            ("password<09>=<0C>hunter2", "password<09>=<0C>[redacted]"),
        ]
        for (line, masked) in cases { #expect(redactSecrets(line) == masked, "\(line)") }
    }

    /// A secret's value that is an object or an array (Zebra's allconfig JSON) goes whole, up to its
    /// matching close (braces inside strings don't count; one that never closes runs to the end).
    @Test func aSecretsObjectOrArrayValueIsHiddenWhole() {
        let cases = [
            ("{\"wlan.wpa.psk\":{\"value\":\"hunter2\",\"type\":\"string\"},\"ip.addr\":{\"value\":\"10.0.0.5\"}}",
             "{\"wlan.wpa.psk\":{[redacted]},\"ip.addr\":{\"value\":\"10.0.0.5\"}}"),
            ("{\"psk\": {\"v\":\"a}b{c hunter2\", \"w\": [1, {\"x\": \"}\"}]}, \"n\": 1}", "{\"psk\": {[redacted]}, \"n\": 1}"),
            ("{\"tokens\":[\"hunter2\",\"x\"],\"a\":1}", "{\"tokens\":[[redacted]],\"a\":1}"),
            ("\"wlan.wpa.psk\":{\"value\":\"hunter2 a", "\"wlan.wpa.psk\":{[redacted]}"),
            ("password: ['hun]ter2', \"x\"", "password: [[redacted]]"),
        ]
        for (line, masked) in cases { #expect(redactSecrets(line) == masked, "\(line)") }
    }

    /// A URL's password (`https://admin:hunter2@host`) and a Basic credential are masked; the URL's
    /// user and host stay.
    @Test func urlPasswordsAndBasicCredentialsAreMasked() {
        #expect(redactSecrets("https://admin:hunter2@10.0.0.1/") == "https://admin:[redacted]@10.0.0.1/")
        #expect(redactSecrets("get ftp://u:p@ss@h:21/x and http://h/a@b") == "get ftp://u:[redacted]@h:21/x and http://h/a@b")
        #expect(redactSecrets("https://10.0.0.1:8443/status") == "https://10.0.0.1:8443/status")
        #expect(redactSecrets("Authorization: Basic aHVudGVyMg==") == "Authorization: [redacted] [redacted]")
        #expect(redactSecrets("Proxy-Authorization: Basic aHVudGVyMg==") == "Proxy-Authorization: [redacted] [redacted]")
        #expect(redactSecrets("Authorization: Bearer abc.def") == "Authorization: [redacted] [redacted]")
    }

    /// A chain that takes a quoted SGD name (`pin=abc: "wlan.wpa.psk" hunter2`) still pairs that
    /// name with the value after it, with `" "`, `":` or a tab as the separator; and the chains that
    /// already worked keep their shape.
    @Test func aChainedQuotedKeyStillPairsWithItsValue() {
        let cases = [
            ("pin=abc: \"wlan.wpa.psk\" hunter2", "pin=[redacted] \"[redacted]\" [redacted]"),
            ("Cookie: a= \"session_id\" hunter2", "Cookie: [redacted] \"[redacted]\" [redacted]"),
            ("pin=1234 = \"wlan.wpa.psk\" hunter2", "pin=[redacted] = \"[redacted]\" [redacted]"),
            ("pin=1234\" \"wlan.wpa.psk\" hunter2", "pin=[redacted]\" \"[redacted]\" [redacted]"),
            ("pin=1234 : \"wlan.wpa.psk\"\thunter2", "pin=[redacted] : \"[redacted]\"\t[redacted]"),
            ("! U1 setvar \"bluetooth.bluetooth_pin\" 12:34: \"wlan.wpa.psk\" hunter2",
             "! U1 setvar \"bluetooth.bluetooth_pin\" [redacted] \"[redacted]\" [redacted]"),
            ("pin=a:\"psk\":hunter2", "pin=[redacted]\"[redacted]\":[redacted]"),
            // A quoted text that is no secret's name pairs with nothing: what follows it stays.
            ("pin=a: \"x\" hunter2", "pin=[redacted] \"[redacted]\" hunter2"),
        ]
        for (line, masked) in cases { #expect(redactSecrets(line) == masked, "\(line)") }
    }

    /// A URL whose `://` begins at the character that ended the last URL's authority (`h,https://`)
    /// still loses its password.
    @Test func aUrlRightAfterAnotherUrlsAuthorityStillLosesItsPassword() {
        #expect(redactSecrets("http://h,https://u:hunter2@h2/") == "http://h,https://u:[redacted]@h2/")
        #expect(redactSecrets("x://y:z://admin:hunter2@host") == "x://y:z://admin:[redacted]@host")
        #expect(redactSecrets("a://b:c://d:p1@e f://g:p2@h") == "a://b:c://d:[redacted]@e f://g:[redacted]@h")
    }

    /// An object or array that never closes runs to the end of the text, not to the line break: a
    /// name inside it would otherwise pair with a value on the next line. One that closes on a later
    /// line is masked up to its close.
    @Test func anUnclosedObjectRunsToTheEndOfTheText() {
        #expect(redactSecrets("token={a pin:\nhunter2") == "token={[redacted]}")
        #expect(redactSecrets("token={a \"pin\"\nhunter2") == "token={[redacted]}")
        #expect(redactSecrets("token=[a\npsk: \"x y\"") == "token=[[redacted]]")
        #expect(redactSecrets("psk:{a\n} next=1") == "psk:{[redacted]} next=1")
    }

    /// A quoted text masked as a value may have been a key's name (`pin<09>:"wlan.wpa.psk":x`): the
    /// value after `:`, `=` or SGD's spaces goes too, while a quoted value followed by plain text
    /// (`password: "a b c" next`) takes nothing with it.
    @Test func aQuotedKeyMaskedAsAValueStillHidesItsOwnValue() {
        let cases = [
            ("pin<09>:\"wlan.wpa.psk\":x", "pin<09>:\"[redacted]\":[redacted]"),
            ("pin<09>:\"wlan.wpa.psk\" hunter2", "pin<09>:\"[redacted]\" [redacted]"),
            ("pin<09>:\"wlan.wpa.psk\"<09>hunter2", "pin<09>:\"[redacted]\"<09>[redacted]"),
            ("pin<09>:\"foo\" = hunter2", "pin<09>:\"[redacted]\" = [redacted]"),
            ("pin<09>:\"psk\":session_id=\"hunter2 abc\"", "pin<09>:\"[redacted]\":[redacted]\"[redacted]\""),
            ("password: \"a b c\" next", "password: \"[redacted]\" next"),
            ("! U1 setvar \"wlan.wpa.psk\" \"hunter2 x\" , Choices: 0-64", "! U1 setvar \"wlan.wpa.psk\" \"[redacted]\" , Choices: 0-64"),
        ]
        for (line, masked) in cases { #expect(redactSecrets(line) == masked, "\(line)") }
    }

    /// A masked object or array takes what is glued to its close, but not a parent's closing braces:
    /// `{"tokens":["x"]}` keeps its last `}`.
    @Test func aMaskedObjectKeepsItsParentsClosingBrace() {
        #expect(redactSecrets("{\"tokens\":[\"x\"]}") == "{\"tokens\":[[redacted]]}")
        #expect(redactSecrets("{\"psk\":{\"a\":1}}") == "{\"psk\":{[redacted]}}")
        #expect(redactSecrets("{\"a\":{\"psk\":[1,2]}}") == "{\"a\":{\"psk\":[[redacted]]}}")
        #expect(redactSecrets("pin:{}ZZZZ") == "pin:{[redacted]}")
        #expect(redactSecrets("pin:{}ZZ}}") == "pin:{[redacted]}}}")
    }

    /// What the round-4 differential fuzz found: a quoted text that holds a key and separator
    /// (`"&session_id:"`, `'a token="b'`, `'x psk" '`) pairs them with a quoted value that opens at
    /// its closing quote, or at the last quote of the other kind inside it, and runs on past the
    /// mask; and an object masked in a chain takes what is glued to its close. Each leaked before.
    @Test func aKeyInsideAMaskedQuotedTextStillPairsWithItsValue() {
        let cases = [
            ("token:<09>\"&session_id:\"hunter2 x", "token:<09>\"[redacted]\"[redacted]"),
            ("psk<09>=\"session_id:\"hunter2\" next", "psk<09>=\"[redacted]\"[redacted] next"),
            ("pin=<09>'a token=\"b' c\"", "pin=<09>'[redacted]'[redacted]"),
            ("pinZAZ='x psk\" ' y'", "pinZAZ='[redacted]'[redacted]"),
            ("pin:\t\"\"={&:psk::}hunter2 x", "pin:\t\"[redacted]\"={[redacted]} x"),
            // One that never closed ends at its line break, and its key pairs across the break.
            ("pin=a:'wlan.wpa.psk\"  \n  hunter2 x", "pin=[redacted]'[redacted]'\n  [redacted] x"),
            ("pin=a:'psk=  \nhunter2", "pin=[redacted]'[redacted]'\n[redacted]"),
            // A quoted value that ends in a colon after an ordinary word pairs with nothing.
            ("wlan.wpa.psk : \"abc:\" , Choices: 0-64", "wlan.wpa.psk : \"[redacted]\" , Choices: 0-64"),
        ]
        for (line, masked) in cases { #expect(redactSecrets(line) == masked, "\(line)") }
        // The fuzz's own inputs, with the markers the regex they replaced had masked.
        let found = [
            ("=ZAZBasic token:<09>\"&session_id:\"passwordCookie;Authorization\\ZBZ", ["ZBZ"]),
            ("@ZAZ=Basic session_id:\t\"\"={&:session_id::}ZBZaZCZ{{", ["ZBZ", "ZCZ"]),
            ("=:\"psk<09>\n:'://;]&token]&\"session_id=\"'ZAZwlan.wpa.psk", ["ZAZ"]),
            ("pin\"=ZAZ\"::<0D>[ passwordZBZhttps://u:{]]ZCZhttp://h,{<09>;ZDZ", ["ZAZ", "ZCZ"]),
            ("}Basic }=\"psk<09><09>=\"ZAZZBZ\\token=\"[ZCZ&", ["ZCZ"]),
        ]
        for (line, markers) in found {
            let out = redactSecrets(line)
            for marker in markers { #expect(!out.contains(marker), "\(line) -> \(out)") }
        }
    }

    /// An object or array may hold a quoted string whose text ends in a key and separator
    /// (`{"password:"}`, `['sessionid=']`, `{pIn" "}`): the regex this replaced paired that key with
    /// a quoted value opening at the string's closing quote and running on past the close, so the
    /// mask runs on to that value's end, however deep the string sits. A string that ends in no key,
    /// or whose key's value closes inside, takes nothing with it.
    @Test func aKeyInsideAMaskedObjectStillPairsWithItsValue() {
        let cases = [
            ("psk={\"password:\"} hunter2", "psk={[redacted]}[redacted]"),
            ("token=['sessionid=']\"hunter2", "token=[[redacted]][redacted]"),
            ("pin:{'token:'} x", "pin:{[redacted]}[redacted]"),
            ("{\"psk\":{\"token:\"} x}", "{\"psk\":{[redacted]}[redacted]"),
            ("pin=[\"x\",\"psk=\"] x", "pin=[[redacted]][redacted]"),
            ("psk:{pIn\" \"},x", "psk:{[redacted]}[redacted]"),
            ("Authorization:'':[\"pwd:\"] x", "Authorization:'[redacted]':[[redacted]][redacted]"),
            ("psk:{\"a\":[{\"b\":{'c':\"token:\"}}]} hunter2", "psk:{[redacted]}[redacted]"),
            ("pin:[['x', {\"a\":'psk:'}]] hunter2", "pin:[[redacted]][redacted]"),
            ("psk:{\"token:\" \"x\"} y", "psk:{[redacted]} y"),
            ("{\"wlan.wpa.psk\":{\"value\":\"abc:\",\"type\":\"string\"},\"ip.addr\":{\"value\":\"10.0.0.5\"}}",
             "{\"wlan.wpa.psk\":{[redacted]},\"ip.addr\":{\"value\":\"10.0.0.5\"}}"),
        ]
        for (line, masked) in cases { #expect(redactSecrets(line) == masked, "\(line)") }
    }

    /// `Authorization`'s credential goes with its scheme when the name is reached by a chain
    /// (`pin:"a":Authorization: Basic cred`) just as when the scan finds the name itself; a chained
    /// name that is no `Authorization` takes one value only.
    @Test func anAuthorizationNameReachedByAChainStillLosesItsCredential() {
        let cases = [
            ("pin=a: \"wlan.wpa.psk\" Authorization: Basic cred", "pin=[redacted] \"[redacted]\" [redacted] [redacted] [redacted]"),
            ("token:<09>\"x\" = Authorization: Basic cred", "token:<09>\"[redacted]\" = [redacted] [redacted] [redacted]"),
            ("pin:\"a\":Proxy-Authorization: Basic cred", "pin:\"[redacted]\":[redacted] [redacted] [redacted]"),
            ("pin:\"a\":Authorization=Basic cred", "pin:\"[redacted]\":[redacted] [redacted]"),
            ("pin=Authorization: Basic cred", "pin=[redacted] [redacted] [redacted]"),
            // The name quoted (a JSON key, say) and reached by a chain: the same, when a separator follows the quote.
            ("pin:\"a\":\"Authorization\": Basic cred", "pin:\"[redacted]\":\"[redacted]\": [redacted] [redacted]"),
            ("pin:\"a\":'Authorization': Basic cred", "pin:\"[redacted]\":'[redacted]': [redacted] [redacted]"),
            ("pin:\"a\":\"Proxy-Authorization\"=Basic cred", "pin:\"[redacted]\":\"[redacted]\"=[redacted] [redacted]"),
            ("pin:\"a\":\"Authorization\": \"Basic\" cred", "pin:\"[redacted]\":\"[redacted]\": \"[redacted]\" cred"),
            ("pin:\"a\":psk: x y", "pin:\"[redacted]\":[redacted] [redacted] y"),
            ("Authorization: Basic cred", "Authorization: [redacted] [redacted]"),
            ("Authorization: \"Basic\" cred", "Authorization: \"[redacted]\" cred"),
        ]
        for (line, masked) in cases { #expect(redactSecrets(line) == masked, "\(line)") }
    }

    /// An object masked in a chain shows a parent's closing braces glued to its close, as one the
    /// scan found does, and the chain still looks on from after them.
    @Test func aChainedObjectKeepsItsParentsClosingBrace() {
        #expect(redactSecrets("{\"pin\":a: {\"c\":1}}") == "{\"pin\":[redacted] {[redacted]}}")
        #expect(redactSecrets("{\"pin\":a: [\"c\"]]}") == "{\"pin\":[redacted] [[redacted]]]}")
        #expect(redactSecrets("pin:a: {x}y}") == "pin:[redacted] {[redacted]}}")
        #expect(redactSecrets("pin:a: {x}} =y") == "pin:[redacted] {[redacted]}} =[redacted]")
    }

    /// Text that isn't ASCII (an emoji, accented letters) passes through untouched, and a secret
    /// beside it still goes.
    @Test func textBeyondAsciiPassesThrough() {
        #expect(redactSecrets("José’s printer 🖨️ is ready") == "José’s printer 🖨️ is ready")
        #expect(redactSecrets("🖨️ password=hunter2 ✓") == "🖨️ password=[redacted] ✓")
        #expect(redactSecrets("") == "")
    }
}
