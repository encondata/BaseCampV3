var labelgenModule = function(exports) {
  "use strict";var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  function isPyDict(v) {
    return v instanceof Map;
  }
  function isPyNumber(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && (v.kind === "int" || v.kind === "float") && typeof v.text === "string";
  }
  const WS = /[ \t\n\r]*/y;
  const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
  const CONSTANTS = [
    ["null", null],
    ["true", true],
    ["false", false],
    ["NaN", { kind: "float", text: "NaN" }],
    ["Infinity", { kind: "float", text: "Infinity" }],
    ["-Infinity", { kind: "float", text: "-Infinity" }]
  ];
  class Reader {
    constructor(text2) {
      __publicField(this, "pos", 0);
      this.text = text2;
    }
    fail(what) {
      throw new SyntaxError(`${what} at char ${this.pos}`);
    }
    ws() {
      WS.lastIndex = this.pos;
      WS.exec(this.text);
      this.pos = WS.lastIndex;
    }
    value() {
      const ch = this.text[this.pos];
      if (ch === '"') return this.string();
      if (ch === "{") return this.object();
      if (ch === "[") return this.array();
      for (const [word, value] of CONSTANTS) {
        if (this.text.startsWith(word, this.pos)) {
          this.pos += word.length;
          return isPyNumber(value) ? { ...value } : value;
        }
      }
      NUMBER.lastIndex = this.pos;
      const m = NUMBER.exec(this.text);
      if (!m) this.fail("Expecting value");
      this.pos = NUMBER.lastIndex;
      return { kind: m[1] !== void 0 || m[2] !== void 0 ? "float" : "int", text: m[0] };
    }
    string() {
      const start = this.pos;
      let i = start + 1;
      for (; ; ) {
        const ch = this.text[i];
        if (ch === void 0) {
          this.pos = start;
          this.fail("Unterminated string");
        }
        if (ch === "\\") i += 2;
        else if (ch === '"') break;
        else i += 1;
      }
      this.pos = i + 1;
      return JSON.parse(this.text.slice(start, i + 1));
    }
    array() {
      this.pos += 1;
      const out = [];
      this.ws();
      if (this.text[this.pos] === "]") {
        this.pos += 1;
        return out;
      }
      for (; ; ) {
        this.ws();
        out.push(this.value());
        this.ws();
        const ch = this.text[this.pos];
        this.pos += 1;
        if (ch === "]") return out;
        if (ch !== ",") this.fail("Expecting ',' delimiter");
      }
    }
    object() {
      this.pos += 1;
      const out = /* @__PURE__ */ new Map();
      this.ws();
      if (this.text[this.pos] === "}") {
        this.pos += 1;
        return out;
      }
      for (; ; ) {
        this.ws();
        if (this.text[this.pos] !== '"') this.fail("Expecting property name enclosed in double quotes");
        const key = this.string();
        this.ws();
        if (this.text[this.pos] !== ":") this.fail("Expecting ':' delimiter");
        this.pos += 1;
        this.ws();
        out.set(key, this.value());
        this.ws();
        const ch = this.text[this.pos];
        this.pos += 1;
        if (ch === "}") return out;
        if (ch !== ",") this.fail("Expecting ',' delimiter");
      }
    }
  }
  function parsePyJson(text2) {
    const r = new Reader(text2);
    r.ws();
    const value = r.value();
    r.ws();
    if (r.pos !== text2.length) r.fail("Extra data");
    return value;
  }
  function pyRound(x) {
    if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x} to an integer`);
    const f = Math.floor(x);
    const diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f === 0 ? 0 : f;
    return f % 2 === 0 ? f : f + 1;
  }
  function floorDiv(a, b) {
    if (b === 0) throw new RangeError("integer division or modulo by zero");
    return Math.floor(a / b);
  }
  function codePoints(s) {
    return Array.from(s);
  }
  function cpLength(s) {
    let n = 0;
    for (const _ of s) n += 1;
    return n;
  }
  function cpSlice(s, start, end) {
    const cps = codePoints(s);
    const len = cps.length;
    const norm = (i) => i < 0 ? Math.max(0, len + i) : Math.min(i, len);
    const a = norm(start);
    const b = end === void 0 ? len : norm(end);
    return a < b ? cps.slice(a, b).join("") : "";
  }
  function cmpCodePoints(a, b) {
    const x = codePoints(a);
    const y = codePoints(b);
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
      const d = x[i].codePointAt(0) - y[i].codePointAt(0);
      if (d !== 0) return d;
    }
    return x.length - y.length;
  }
  const sortedStrings = (items) => [...items].sort(cmpCodePoints);
  function rjust(s, width, fill) {
    const pad2 = width - cpLength(s);
    return pad2 > 0 ? fill.repeat(pad2) + s : s;
  }
  const PY_SPACE = "	\n\v\f\r              \u2028\u2029  　";
  function isPySpace(ch) {
    return ch.length === 1 && PY_SPACE.includes(ch);
  }
  function pyStrip(s) {
    let a = 0;
    let b = s.length;
    while (a < b && isPySpace(s[a])) a += 1;
    while (b > a && isPySpace(s[b - 1])) b -= 1;
    return s.slice(a, b);
  }
  function utf8Encode(s) {
    const out = [];
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp < 128) {
        out.push(cp);
      } else if (cp < 2048) {
        out.push(192 | cp >> 6, 128 | cp & 63);
      } else if (cp >= 55296 && cp <= 57343) {
        throw new RangeError(`'utf-8' codec can't encode character '\\u${cp.toString(16)}': surrogates not allowed`);
      } else if (cp < 65536) {
        out.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
      } else {
        out.push(
          240 | cp >> 18,
          128 | cp >> 12 & 63,
          128 | cp >> 6 & 63,
          128 | cp & 63
        );
      }
    }
    return out;
  }
  function utf8Length(s) {
    return utf8Encode(s).length;
  }
  const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
  const hex = (cp, width) => cp.toString(16).padStart(width, "0");
  function reprString(s) {
    const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (ch === quote || ch === "\\") out += `\\${ch}`;
      else if (ch === "	") out += "\\t";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (cp < 32 || cp === 127) out += `\\x${hex(cp, 2)}`;
      else if (cp < 127) out += ch;
      else if (!NOT_PRINTABLE.test(ch)) out += ch;
      else if (cp <= 255) out += `\\x${hex(cp, 2)}`;
      else if (cp <= 65535) out += `\\u${hex(cp, 4)}`;
      else out += `\\U${hex(cp, 8)}`;
    }
    return out + quote;
  }
  function floatRepr(x) {
    if (Number.isNaN(x)) return "nan";
    if (x === Infinity) return "inf";
    if (x === -Infinity) return "-inf";
    if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
    const sign = x < 0 ? "-" : "";
    const [mantissa, expText] = Math.abs(x).toExponential().split("e");
    const digits = mantissa.replace(".", "");
    const e = Number(expText);
    if (e < -4 || e >= 16) {
      const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
      return `${sign}${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
    }
    if (e < 0) return `${sign}0.${"0".repeat(-e - 1)}${digits}`;
    if (digits.length <= e + 1) return `${sign}${digits}${"0".repeat(e + 1 - digits.length)}.0`;
    return `${sign}${digits.slice(0, e + 1)}.${digits.slice(e + 1)}`;
  }
  function numberStr(text2, kind) {
    if (kind === "int") return text2 === "-0" ? "0" : text2;
    if (text2 === "NaN") return "nan";
    if (text2 === "Infinity") return "inf";
    if (text2 === "-Infinity") return "-inf";
    return floatRepr(Number(text2));
  }
  function pyRepr(v) {
    if (v === null || v === void 0) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "string") return reprString(v);
    if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
    if (isPyDict(v)) {
      return `{${[...v].map(([k, item]) => `${reprString(k)}: ${pyRepr(item)}`).join(", ")}}`;
    }
    if (isPyNumber(v)) return numberStr(v.text, v.kind);
    throw new TypeError("not a parsed JSON value");
  }
  function pyStr(v) {
    return typeof v === "string" ? v : pyRepr(v);
  }
  function pyText(v) {
    if (v === null || v === void 0) return "";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return pyStr(v);
  }
  const PREC = 28;
  const EMAX = 999999;
  const DECIMAL_RE = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
  const SPECIAL_RE = /^([+-])?(?:(inf|infinity)|(nan|snan)(\d*))$/i;
  const ND = /\p{Nd}/u;
  const MAX_EXPONENT = 1e6;
  function digitValue(cp) {
    let start = cp;
    while (ND.test(String.fromCodePoint(start - 1))) start -= 1;
    return (cp - start) % 10;
  }
  function parseDecimal(text2) {
    let ascii = "";
    for (const ch of pyStrip(text2).split("_").join("")) {
      const cp = ch.codePointAt(0);
      if (cp > 0 && cp <= 127) ascii += ch;
      else if (ND.test(ch)) ascii += String(digitValue(cp));
      else return null;
    }
    const m = DECIMAL_RE.exec(ascii);
    if (m) {
      const [, sign, whole, frac, onlyFrac, expText] = m;
      const intPart = whole ?? "";
      const fracPart = frac ?? onlyFrac ?? "";
      const exp = Number(expText ?? "0") - fracPart.length;
      if (!(Math.abs(exp) <= MAX_EXPONENT)) {
        throw new RangeError(`decimal exponent out of range: ${expText}`);
      }
      return { negative: sign === "-", kind: "finite", digits: intPart + fracPart, exp };
    }
    const s = SPECIAL_RE.exec(ascii);
    if (!s) return null;
    const negative = s[1] === "-";
    if (s[2]) return { negative, kind: "inf", digits: "", exp: 0 };
    return {
      negative,
      kind: s[3].toLowerCase() === "snan" ? "snan" : "nan",
      digits: s[4].replace(/^0+/, ""),
      exp: 0
    };
  }
  function fixedText(negative, digits, exp) {
    const sign = negative ? "-" : "";
    if (exp >= 0) return sign + (digits === "0" ? "0" : digits + "0".repeat(exp));
    const point = digits.length + exp;
    if (point > 0) return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
    return `${sign}0.${"0".repeat(-point)}${digits}`;
  }
  function roundToPrecision(digits) {
    if (digits.length <= PREC) return [digits, 0];
    const shift = digits.length - PREC;
    let kept = digits.slice(0, PREC);
    const first = digits[PREC];
    const rest = digits.slice(PREC + 1);
    const up = first > "5" || first === "5" && (/[1-9]/.test(rest) || Number(kept[PREC - 1]) % 2 === 1);
    if (!up) return [kept, shift];
    const chars = kept.split("");
    let i = chars.length - 1;
    while (i >= 0 && chars[i] === "9") {
      chars[i] = "0";
      i -= 1;
    }
    if (i < 0) return [`1${"0".repeat(PREC - 1)}`, shift + 1];
    chars[i] = String(Number(chars[i]) + 1);
    kept = chars.join("");
    return [kept, shift];
  }
  function decimalNormalize(text2) {
    const d = parseDecimal(text2);
    if (d === null || d.kind !== "finite") return null;
    let digits = d.digits.replace(/^0+/, "");
    if (digits === "") return d.negative ? "-0" : "0";
    const [rounded, shift] = roundToPrecision(digits);
    digits = rounded;
    let exp = d.exp + shift;
    if (exp + digits.length - 1 > EMAX) throw new RangeError("decimal Overflow");
    while (digits.length > 1 && digits.endsWith("0") && exp < EMAX) {
      digits = digits.slice(0, -1);
      exp += 1;
    }
    return fixedText(d.negative, digits, exp);
  }
  function ruText(raw) {
    if (raw === null || raw === void 0) return "";
    const text2 = pyStrip(pyStr(raw));
    if (!text2) return "";
    return decimalNormalize(text2) ?? text2;
  }
  const INT_RE = /^([+-])?(\p{Nd}(?:_?\p{Nd})*)$/u;
  const INT_MAX_DIGITS = 4300;
  function pyIntFromStr(text2) {
    const m = INT_RE.exec(pyStrip(text2));
    if (!m) return null;
    const digits = codePoints(m[2]).filter((ch) => ch !== "_");
    if (digits.length > INT_MAX_DIGITS) return null;
    const ascii = digits.map((ch) => String(digitValue(ch.codePointAt(0)))).join("");
    const n = Number(ascii);
    return m[1] === "-" && n !== 0 ? -n : n;
  }
  function pyInt(v) {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") return pyIntFromStr(v);
    if (!isPyNumber(v)) return null;
    const n = Number(v.text);
    if (v.kind === "int") return n;
    if (Number.isNaN(n)) return null;
    if (!Number.isFinite(n)) throw new RangeError("cannot convert float infinity to integer");
    return Math.trunc(n) || 0;
  }
  const rstrip = (s, ch) => {
    let end = s.length;
    while (end > 0 && s[end - 1] === ch) end -= 1;
    return s.slice(0, end);
  };
  function formatRu(text2) {
    if (text2 === null || text2 === void 0 || text2 === "") return "";
    const d = parseDecimal(text2);
    if (d === null) return "";
    if (d.kind === "snan") throw new RangeError("[<class 'decimal.InvalidOperation'>]");
    if (d.kind === "inf") throw new RangeError("cannot convert Infinity to integer");
    if (d.kind === "nan") {
      const formatted = `${d.negative ? "-" : ""}NaN${d.digits}`;
      return `U${rstrip(rstrip(formatted, "0"), ".")}`;
    }
    const digits = d.digits.replace(/^0+/, "") || "0";
    const fracDigits = d.exp < 0 ? digits.slice(Math.max(0, digits.length + d.exp)) : "";
    if (/^0*$/.test(fracDigits)) {
      const whole = d.exp >= 0 ? digits + "0".repeat(d.exp) : digits.slice(0, Math.max(0, digits.length + d.exp));
      const intText2 = whole.replace(/^0+/, "") || "0";
      return `U${d.negative && intText2 !== "0" ? "-" : ""}${intText2}`;
    }
    return `U${rstrip(rstrip(fixedText(d.negative, digits, d.exp), "0"), ".")}`;
  }
  const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = (y, m) => m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m];
  function ymdToOrd(y, m, d) {
    const py = y - 1;
    return py * 365 + floorDiv(py, 4) - floorDiv(py, 100) + floorDiv(py, 400) + DAYS_BEFORE_MONTH[m] + 0 + d;
  }
  function ordToYmd(ord) {
    let n = ord - 1;
    const n400 = floorDiv(n, 146097);
    n -= n400 * 146097;
    let year = n400 * 400 + 1;
    const n100 = floorDiv(n, 36524);
    n -= n100 * 36524;
    const n4 = floorDiv(n, 1461);
    n -= n4 * 1461;
    const n1 = floorDiv(n, 365);
    n -= n1 * 365;
    year += n100 * 100 + n4 * 4 + n1;
    if (n1 === 4 || n100 === 4) return { year: year - 1, month: 12, day: 31 };
    const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
    let month = n + 50 >> 5;
    let preceding = DAYS_BEFORE_MONTH[month] + (month > 2 && leap ? 1 : 0);
    if (preceding > n) {
      month -= 1;
      preceding -= DAYS_IN_MONTH[month] + (month === 2 && leap ? 1 : 0);
    }
    return { year, month, day: n - preceding + 1 };
  }
  function isoWeek1Monday(year) {
    const first = ymdToOrd(year, 1, 1);
    const weekday = (first + 6) % 7;
    return first - weekday + (weekday > 3 ? 7 : 0);
  }
  function dateFromIsoformat(text2) {
    let size;
    try {
      size = utf8Length(text2);
    } catch {
      return null;
    }
    if (size !== 7 && size !== 8 && size !== 10) return null;
    const cps = codePoints(text2);
    let p = 0;
    const digits = (n) => {
      let v = 0;
      for (let i = 0; i < n; i += 1) {
        const ch = cps[p + i];
        if (ch === void 0 || ch < "0" || ch > "9" || ch.length !== 1) return null;
        v = v * 10 + (ch.charCodeAt(0) - 48);
      }
      p += n;
      return v;
    };
    const year = digits(4);
    if (year === null) return null;
    const sep = cps[p] === "-";
    if (sep) p += 1;
    let ymd;
    if (cps[p] === "W") {
      p += 1;
      const week = digits(2);
      if (week === null) return null;
      let weekday = 1;
      if (p < cps.length) {
        if (sep && cps[p++] !== "-") return null;
        const d2 = digits(1);
        if (d2 === null) return null;
        weekday = d2;
      }
      if (year < 1 || year > 9999) return null;
      if (week <= 0 || week >= 53) {
        const first = ymdToOrd(year, 1, 1) % 7;
        if (!(week === 53 && (first === 4 || first === 3 && isLeap(year)))) return null;
      }
      if (weekday <= 0 || weekday >= 8) return null;
      ymd = ordToYmd(isoWeek1Monday(year) + (week - 1) * 7 + weekday - 1);
    } else {
      const month = digits(2);
      if (month === null) return null;
      if (sep && cps[p++] !== "-") return null;
      const day = digits(2);
      if (day === null) return null;
      ymd = { year, month, day };
    }
    const { year: y, month: m, day: d } = ymd;
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return ymd;
  }
  const MONTHS_UPPER = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC"
  ];
  const pad = (n, width) => String(n).padStart(width, "0");
  function moveDates(isoDay) {
    const day = typeof isoDay === "string" && isoDay ? dateFromIsoformat(isoDay) : null;
    if (day === null) return ["", ""];
    return [
      `${pad(day.month, 2)}/${pad(day.day, 2)}/${pad(day.year, 4)}`,
      `${pad(day.day, 2)}-${MONTHS_UPPER[day.month - 1]}-${day.year}`
    ];
  }
  function fromPlain(v) {
    if (v === null || v === void 0) return null;
    if (typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number") return numberOf(v);
    if (Array.isArray(v)) return v.map(fromPlain);
    if (v instanceof Map) return v;
    if (typeof v === "object") {
      const out = /* @__PURE__ */ new Map();
      for (const [k, item] of Object.entries(v)) {
        if (item !== void 0) out.set(k, fromPlain(item));
      }
      return out;
    }
    throw new TypeError(`not a JSON value: ${typeof v}`);
  }
  function numberOf(n) {
    if (Number.isNaN(n)) return { kind: "float", text: "NaN" };
    if (!Number.isFinite(n)) return { kind: "float", text: n > 0 ? "Infinity" : "-Infinity" };
    if (Number.isInteger(n)) return { kind: "int", text: BigInt(n).toString() };
    return { kind: "float", text: String(n) };
  }
  function asPy(raw) {
    return isPyDict(raw) ? raw : fromPlain(raw);
  }
  function pyTruthy(v) {
    if (v === null || v === void 0 || v === false) return false;
    if (v === true) return true;
    if (typeof v === "string") return v !== "";
    if (Array.isArray(v)) return v.length > 0;
    if (isPyDict(v)) return v.size > 0;
    return Number(v.text) !== 0;
  }
  function toFloat(v) {
    const n = Number(v.text);
    if (v.kind === "int" && !Number.isFinite(n)) throw new RangeError("int too large to convert to float");
    return n;
  }
  const intOf = (v) => Number(v.text);
  function isNum(v) {
    return isPyNumber(v) && Number.isFinite(toFloat(v));
  }
  function isInt$2(v) {
    return isPyNumber(v) && v.kind === "int";
  }
  function isOneOf(v, choices) {
    return typeof v === "string" && choices.includes(v);
  }
  const get = (d, key) => d.get(key);
  const getOr = (d, key, dflt) => d.has(key) ? d.get(key) : dflt;
  const LABEL_TAG_LABELS = {
    priority: "Priority",
    vendor: "Vendor",
    accessories: "Accessories",
    ewaste: "E-Waste",
    warehouse: "Warehouse"
  };
  const ASSET_LABEL_TYPES = ["top", "front", "rail"];
  const CONTAINER_LABEL_TYPES = ["container", "container_info"];
  const ALL_LABEL_TYPES = [...ASSET_LABEL_TYPES, ...CONTAINER_LABEL_TYPES];
  const PERSON_LABEL_TYPES = ["id_badge"];
  const FT_PREFIX = "ft:";
  const UNTAGGED_LABEL = "CONTAINER";
  const PLACEHOLDER_MOCK_VALUES = {
    "asset_id": "100000",
    "asset_name": "SAMPLE-SERVER-01",
    "serial_number": "SN0000001",
    "make": "Dell",
    "model": "PowerEdge R740",
    "make_model": "Dell PowerEdge R740",
    "source_raw": "A1.R01.U12",
    "source_ru": "U12",
    "source_site": "Sample Site A",
    "destination_raw": "B2.R04.U12",
    "destination_ru": "U12",
    "destination_site": "Sample Site B",
    "move_name": "Sample Move",
    "move_date": "09/01/2026",
    "move_date_long": "01-SEP-2026",
    "container_name": "SAMPLE-CRATE-01",
    "container_id": "200000",
    "label_tag": "PRIORITY"
  };
  const MOCK_VALUES = {
    // Asset
    "asset_id": "100000",
    "asset_name": "SAMPLE-SERVER-01",
    "serial_number": "SN0000001",
    "rfid_tag": "000000000000000000100000",
    "pod_number": "P4",
    "asset_status": "Racked",
    "has_rails": "Yes",
    "location_detail": "F01 U18",
    // Make & model
    "make_model": "Dell PowerEdge R740",
    // On this move
    "source_rack": "09.01.05D.02.10",
    "source_ru": "12",
    "source_position": "Front",
    "source_pod": "P4",
    "destination_rack": "14.01.07C.02.03",
    "destination_ru": "12",
    "destination_position": "Front",
    "destination_pod": "D4",
    "priority_wave": "Wave 1",
    "disposition": "Relocate",
    "owner": "Data Services",
    "cable_data_1": "SW01/01",
    "cable_data_2": "SW01/02",
    "cable_data_3": "SW01/03",
    "cable_data_4": "SW01/04",
    "cable_data_5": "SW01/05",
    "cable_data_6": "SW01/06",
    "cable_mgmt_1": "MGMT01/01",
    "cable_mgmt_2": "MGMT01/02",
    "vendor_involved": "No",
    "roster_status": "Labeled",
    // Move
    "move_name": "Sample Move",
    "move_code": "SMPL",
    "move_date": "09/01/2026",
    "move_date_long": "01-SEP-2026",
    // Sites
    "origin_site_name": "Sample Site A",
    "origin_site_code": "SITE-A",
    "destination_site_name": "Sample Site B",
    "destination_site_code": "SITE-B",
    // Container
    "container_name": "SAMPLE-CRATE-01",
    "container_id": "200000",
    "label_tag": "PRIORITY",
    "container_rfid_tag": "000000000000000000200000",
    "container_type": "D-container",
    "container_status": "Available",
    // Person (an ID badge): a plausible worker
    "person_name": "Jordan Rivera",
    "first_name": "Jordan",
    "last_name": "Rivera",
    "preferred_name": "Jordan",
    "person_type": "Worker",
    "company": "Rivera Electric",
    "parent_company": "Rivera Holdings",
    "job_title": "Lead Electrician",
    "roles": "Admin, Staff",
    "trade": "Electrician",
    "level": "L3 Technician",
    "worker_status": "Active",
    "employee_id": "E-10482",
    "email": "jordan.rivera@example.com",
    "phone": "(555) 010-4821",
    "person_rfid_tag": "100418",
    "badge_id": "3f2a9c1e-7b4d-4e21-9a0c-5d6e7f809a1b",
    "badge_short": "3f2a9c1e"
  };
  const cable = (n) => Array.from({ length: n }, (_, i) => `cable_data_${i + 1}`);
  const CATALOG = [
    ["asset", ASSET_LABEL_TYPES, [
      "asset_id",
      "asset_name",
      "serial_number",
      "rfid_tag",
      "pod_number",
      "asset_status",
      "has_rails",
      "location_detail"
    ]],
    ["model", ASSET_LABEL_TYPES, ["make_model"]],
    ["move_row", ASSET_LABEL_TYPES, [
      "source_rack",
      "source_ru",
      "source_position",
      "source_pod",
      "destination_rack",
      "destination_ru",
      "destination_position",
      "destination_pod",
      "priority_wave",
      "disposition",
      "owner",
      ...cable(6),
      "cable_mgmt_1",
      "cable_mgmt_2",
      "vendor_involved",
      "roster_status"
    ]],
    ["move", ALL_LABEL_TYPES, ["move_name", "move_code", "move_date", "move_date_long"]],
    ["sites", ALL_LABEL_TYPES, [
      "origin_site_name",
      "origin_site_code",
      "destination_site_name",
      "destination_site_code"
    ]],
    ["container", CONTAINER_LABEL_TYPES, [
      "container_name",
      "container_id",
      "label_tag",
      "container_rfid_tag",
      "container_type",
      "container_status"
    ]],
    ["person", PERSON_LABEL_TYPES, [
      "person_name",
      "first_name",
      "last_name",
      "preferred_name",
      "person_type",
      "company",
      "parent_company",
      "job_title",
      "roles",
      "trade",
      "level",
      "worker_status",
      "employee_id",
      "email",
      "phone",
      "person_rfid_tag",
      "badge_id",
      "badge_short"
    ]]
  ];
  const PERSON_GROUPS = new Set(CATALOG.filter(([, types]) => types.every((t) => PERSON_LABEL_TYPES.includes(t))).map(([key]) => key));
  function groupsFor(labelType) {
    if (labelType === null) return [...CATALOG];
    if (!ALL_LABEL_TYPES.includes(labelType) && !PERSON_LABEL_TYPES.includes(labelType)) {
      return CATALOG.filter(([key]) => !PERSON_GROUPS.has(key));
    }
    return CATALOG.filter(([, types]) => types.includes(labelType));
  }
  function allowsFromTo(labelType) {
    return labelType === null || !CONTAINER_LABEL_TYPES.includes(labelType) && !PERSON_LABEL_TYPES.includes(labelType);
  }
  function catalogKeys(labelType) {
    return groupsFor(labelType).flatMap(([, , keys]) => keys);
  }
  const ASSET_KEYS = catalogKeys("top");
  const CONTAINER_KEYS = catalogKeys("container");
  const isInt$1 = (v) => isPyNumber(v) && v.kind === "int";
  function designFieldKeys(design) {
    const out = /* @__PURE__ */ new Set();
    if (!isPyDict(design)) return out;
    const schema = design.has("schema") ? design.get("schema") : { kind: "int", text: "1" };
    if (!isInt$1(schema) || Number(schema.text) < 2) return out;
    const elements = design.get("elements");
    for (const el of Array.isArray(elements) ? elements : []) {
      if (!isPyDict(el) || el.get("type") === "image") continue;
      const field = el.get("field");
      if (typeof field === "string" && field) out.add(field);
    }
    return out;
  }
  function mockFieldValues(labelType, fieldKeys) {
    const out = /* @__PURE__ */ Object.create(null);
    for (const key of catalogKeys(labelType)) out[key] = MOCK_VALUES[key];
    if (!allowsFromTo(labelType)) return out;
    for (const key of sortedStrings(fieldKeys ?? [])) {
      if (key.startsWith(FT_PREFIX)) out[key] = key.slice(FT_PREFIX.length);
    }
    return out;
  }
  const getText = (d, key) => pyText(d.get(key));
  function status(p, key) {
    const label = p.get(`${key}_label`);
    return pyText(pyTruthy(label) ? label : p.get(key));
  }
  function either(p, a, b) {
    const first = p.get(a);
    return pyTruthy(first) ? first : p.get(b);
  }
  function contextDates(raw) {
    return moveDates(typeof raw === "string" && raw ? cpSlice(raw, 0, 10) : null);
  }
  function moveValues(context) {
    const [moveDate, moveDateLong] = contextDates(context.get("move_day"));
    return {
      move_name: getText(context, "move_name"),
      move_code: getText(context, "move_code"),
      move_date: moveDate,
      move_date_long: moveDateLong,
      origin_site_name: getText(context, "source_site"),
      origin_site_code: getText(context, "source_site_code"),
      destination_site_name: getText(context, "destination_site"),
      destination_site_code: getText(context, "destination_site_code")
    };
  }
  function assetValues(p) {
    const rawCable = p.get("cable_info");
    const cableInfo = isPyDict(rawCable) ? rawCable : /* @__PURE__ */ new Map();
    const out = {
      asset_id: getText(p, "asset_id"),
      asset_name: getText(p, "name"),
      serial_number: getText(p, "serial_number"),
      rfid_tag: getText(p, "rfid"),
      pod_number: getText(p, "pod_number"),
      asset_status: status(p, "asset_status"),
      has_rails: getText(p, "has_rails"),
      location_detail: getText(p, "location_detail"),
      make_model: getText(p, "make_model"),
      source_rack: getText(p, "source_rack"),
      source_ru: ruText(either(p, "source_ru_raw", "source_ru")),
      source_position: getText(p, "source_position"),
      source_pod: getText(p, "source_pod"),
      destination_rack: getText(p, "destination_rack"),
      destination_ru: ruText(either(p, "destination_ru_raw", "destination_ru")),
      destination_position: getText(p, "destination_position"),
      destination_pod: getText(p, "destination_pod"),
      priority_wave: getText(p, "priority_wave"),
      disposition: getText(p, "disposition"),
      owner: getText(p, "owner"),
      vendor_involved: getText(p, "vendor_involved"),
      roster_status: status(p, "roster_status")
    };
    for (let i = 1; i <= 6; i += 1) out[`cable_data_${i}`] = getText(cableInfo, `data_${i}`);
    for (let i = 1; i <= 2; i += 1) out[`cable_mgmt_${i}`] = getText(cableInfo, `mgmt_${i}`);
    return out;
  }
  function containerValues(p) {
    const rawTag = p.get("label_tag");
    const tag = pyTruthy(rawTag) ? rawTag : "";
    if (typeof tag !== "string") throw new TypeError("label_tag is not text");
    const known = Object.prototype.hasOwnProperty.call(LABEL_TAG_LABELS, tag) ? LABEL_TAG_LABELS[tag] : tag;
    return {
      container_name: getText(p, "name"),
      container_id: getText(p, "legacy_id"),
      label_tag: (known || UNTAGGED_LABEL).toUpperCase(),
      container_rfid_tag: getText(p, "rfid_tag"),
      container_type: pyText(either(p, "container_type_label", "container_type")),
      container_status: status(p, "status")
    };
  }
  function fieldValues(payload, context) {
    if (!isPyDict(payload)) throw new TypeError("the payload is not a mapping");
    const ctx = pyTruthy(context) ? context : /* @__PURE__ */ new Map();
    if (!isPyDict(ctx)) throw new TypeError("label_context is not a mapping");
    const computed = moveValues(ctx);
    const out = /* @__PURE__ */ Object.create(null);
    if (payload.has("asset_id")) {
      Object.assign(computed, assetValues(payload));
      for (const key of ASSET_KEYS) out[key] = computed[key];
      const rawFt = payload.get("raw_ft");
      if (isPyDict(rawFt)) {
        for (const [header, value] of rawFt) out[`${FT_PREFIX}${header}`] = pyText(value);
      }
      return out;
    }
    Object.assign(computed, containerValues(payload));
    for (const key of CONTAINER_KEYS) out[key] = computed[key];
    return out;
  }
  const or = (a, b) => pyTruthy(a) ? a : b;
  function makeModelText(make, model) {
    if (pyTruthy(make) && pyTruthy(model)) return `${pyStr(make)} ${pyStr(model)}`;
    return or(make, model);
  }
  function applyPositionRules(out, rules, sourceRaw, destinationRaw) {
    for (const [side, raw] of [["source", sourceRaw], ["destination", destinationRaw]]) {
      const mapping = rules.get(side);
      if (!isPyDict(mapping) || !pyTruthy(raw)) continue;
      if (typeof raw !== "string") throw new TypeError(`${side} location is not text`);
      const parts = raw.split(".");
      for (const [posKey, name] of mapping) {
        const pos = pyInt(posKey);
        if (pos === null) continue;
        if (typeof name !== "string" || !name) continue;
        const idx = pos - 1;
        if (idx >= 0 && idx < parts.length) out[name] = parts[idx];
      }
    }
  }
  function applyLengthLimits(out, rules) {
    const limits = rules.get("length_limits");
    if (!isPyDict(limits)) return;
    for (const [field, maxLen] of limits) {
      if (!Object.prototype.hasOwnProperty.call(out, field)) continue;
      const value = out[field];
      if (typeof value !== "string") continue;
      const limit = pyInt(maxLen);
      if (limit === null) continue;
      if (limit > 0 && cpLength(value) > limit) out[field] = cpSlice(value, 0, limit);
    }
  }
  function applyGenerationRules(out, rules, sourceRaw, destinationRaw) {
    if (!pyTruthy(rules)) return;
    if (!isPyDict(rules)) throw new TypeError("generation_rules is not a mapping");
    applyPositionRules(out, rules, sourceRaw, destinationRaw);
    applyLengthLimits(out, rules);
  }
  function assetLabelValues(asset, move, catalogKeys2, generationRules) {
    const make = or(asset.make, "");
    const model = or(asset.model, "");
    const sourceRaw = or(asset.sourcePosition, or(asset.sourceRack, ""));
    const destinationRaw = or(asset.destinationPosition, or(asset.destinationRack, ""));
    const [moveDate, moveDateLong] = moveDates(move.day);
    const legacy = asset.legacyId;
    const computed = /* @__PURE__ */ new Map([
      ["asset_id", legacy !== null && legacy !== void 0 ? pyStr(legacy) : ""],
      ["asset_name", or(asset.name, "")],
      ["serial_number", or(asset.serialNumber, "")],
      ["make", make],
      ["model", model],
      ["make_model", makeModelText(make, model)],
      ["source_raw", sourceRaw],
      ["source_ru", formatRu(asset.sourceRu)],
      ["source_site", or(move.sourceSite, "")],
      ["destination_raw", destinationRaw],
      ["destination_ru", formatRu(asset.destinationRu)],
      ["destination_site", or(move.destinationSite, "")],
      ["move_name", or(move.name, "")],
      ["move_date", moveDate],
      ["move_date_long", moveDateLong],
      // an asset row never carries container fields
      ["container_name", ""],
      ["container_id", ""]
    ]);
    const out = /* @__PURE__ */ Object.create(null);
    for (const key of catalogKeys2) out[key] = computed.has(key) ? computed.get(key) : "";
    applyGenerationRules(out, generationRules, sourceRaw, destinationRaw);
    return out;
  }
  function decimalText(raw) {
    if (raw === null || raw === void 0 || raw === "") return null;
    return pyStr(raw);
  }
  function labelAsset(a) {
    return {
      legacyId: a.get("legacy_id"),
      name: a.get("name"),
      serialNumber: a.get("serial_number"),
      make: a.get("make"),
      model: a.get("model"),
      sourceRack: a.get("source_rack"),
      sourceRu: decimalText(a.get("source_ru_raw")),
      sourcePosition: a.get("source_position"),
      destinationRack: a.get("destination_rack"),
      destinationRu: decimalText(a.get("destination_ru_raw")),
      destinationPosition: a.get("destination_position")
    };
  }
  function labelMove(context) {
    const day = context.get("move_day");
    return {
      name: context.get("move_name"),
      day: typeof day === "string" ? day : null,
      sourceSite: context.get("source_site"),
      destinationSite: context.get("destination_site")
    };
  }
  const GENERIC_FAMILY = "generic rack and ru";
  const isGeneric = (t) => t.family.toLowerCase() === GENERIC_FAMILY;
  const STEPS = {
    destination: ["The destination site's", (t) => t.scope === "destination" || t.scope === "both"],
    source: ["The source site's", (t) => t.scope === "source"],
    global: ["The global", (t) => t.scope === "global" && !isGeneric(t)],
    // the fallback is the move's last resort whatever its site links
    generic: ["The fallback", isGeneric]
  };
  const ORDER = {
    top: ["destination", "source", "global", "generic"],
    front: ["destination", "global"]
  };
  const KIND_LABEL = { top: "Top", front: "Front" };
  function best(templates) {
    let top = templates[0];
    for (const t of templates.slice(1)) {
      if (t.version > top.version || t.version === top.version && cmpCodePoints(t.updated_at, top.updated_at) > 0) top = t;
    }
    return top;
  }
  function pickTemplate(templates, kind, dpiKey) {
    const ofKind = templates.filter((t) => t.label_type === kind);
    const notes = [];
    for (const step of ORDER[kind]) {
      const [who, holds] = STEPS[step];
      const inStep = ofKind.filter(holds);
      if (!inStep.length) continue;
      const atDpi = inStep.filter((t) => t.dpi_key === dpiKey);
      if (atDpi.length) return [best(atDpi), notes];
      notes.push(`${who} ${KIND_LABEL[kind]} template "${best(inStep).family}" isn't available at ${dpiKey} DPI.`);
    }
    return [null, notes];
  }
  class DesignError extends Error {
    constructor(problems) {
      super(problems.join("; "));
      __publicField(this, "problems");
      this.name = "DesignError";
      this.problems = problems;
    }
  }
  function splitValue(value) {
    return value.split(".");
  }
  function piece(value, index) {
    const pieces = splitValue(value);
    return index >= 0 && index < pieces.length ? pieces[index] : "";
  }
  function strip(value, rules) {
    const s = rules.strip || "";
    if (!s) return value;
    const where = rules.strip_where || "front";
    if (where === "anywhere") return value.split(s).join("");
    let out = value;
    if (where === "rear") {
      while (out.endsWith(s)) out = out.slice(0, out.length - s.length);
      return out;
    }
    while (out.startsWith(s)) out = out.slice(s.length);
    return out;
  }
  function maxTrim(value, rules) {
    const maxChars = rules.max_chars || 0;
    if (maxChars <= 0 || cpLength(value) <= maxChars) return value;
    if (rules.trim === "front") return cpSlice(value, -maxChars);
    return cpSlice(value, 0, maxChars);
  }
  function padNumber(value, rules) {
    const length = rules.expected_length || 0;
    if (!value || rules.display !== "number" || length <= 0) return value;
    const dot = value.indexOf(".");
    const head = dot < 0 ? value : value.slice(0, dot);
    const tail = dot < 0 ? "" : value.slice(dot);
    return rjust(head, length, "0") + tail;
  }
  function applyRules(value, rules) {
    return padNumber(maxTrim(strip(value, rules), rules), rules);
  }
  function isBlank(value, rules) {
    return maxTrim(strip(value, rules), rules) === "";
  }
  const WEIGHTS = ["regular", "bold"];
  const DEFAULT_FAMILY = "swiss721-cond-bold";
  const RESIDENT_FONT = "TT0003M_.TTF";
  function family(label, regular, bold, { resident = false, mono = false } = {}) {
    return { label, objects: { regular, bold }, resident, mono };
  }
  const FAMILIES = {
    "swiss721-cond-bold": family("Swiss 721 (printer built-in)", RESIDENT_FONT, null, { resident: true }),
    "roboto-condensed": family("Roboto Condensed", "ROBOCO_R.TTF", "ROBOCO_B.TTF"),
    roboto: family("Roboto", "ROBOTO_R.TTF", "ROBOTO_B.TTF"),
    oswald: family("Oswald", "OSWALD_R.TTF", "OSWALD_B.TTF"),
    "roboto-mono": family("Roboto Mono", "ROBOMO_R.TTF", "ROBOMO_B.TTF", { mono: true }),
    "ibm-plex-mono": family("IBM Plex Mono", "PLEXMO_R.TTF", "PLEXMO_B.TTF", { mono: true }),
    "atkinson-hyperlegible": family("Atkinson Hyperlegible", "ATKINS_R.TTF", "ATKINS_B.TTF"),
    "source-sans-3": family("Source Sans 3", "SRCSAN_R.TTF", "SRCSAN_B.TTF")
  };
  const hasFamily = (slug) => Object.prototype.hasOwnProperty.call(FAMILIES, slug);
  function fontObject(fam, weight) {
    if (!WEIGHTS.includes(weight)) {
      throw new RangeError(`unknown font weight: ${pyRepr(weight)}`);
    }
    if (!hasFamily(fam)) throw new RangeError(`unknown font family: ${pyRepr(fam)}`);
    const objs = FAMILIES[fam].objects;
    const bold = weight === "bold" ? objs.bold : null;
    return bold ? [bold, false] : [objs.regular, weight === "bold"];
  }
  const ROTATIONS = [0, 90, 180, 270];
  const SYMBOLOGIES = ["code128", "code39"];
  const ALIGNS = ["left", "center", "right"];
  const SCHEMAS = [1, 2, 3];
  const DISPLAYS = ["text", "number", "barcode", "qr"];
  const TRIMS = ["front", "rear"];
  const STRIP_WHERES = ["front", "rear", "anywhere"];
  const IMAGE_SOURCES = ["photo", "logo", "static"];
  const FITS = ["cover", "contain"];
  const MODES = ["dither", "threshold"];
  const BRIGHTNESS = [-100, 100];
  const CONTRAST = [0, 300];
  const THRESHOLD = [1, 254];
  const IMAGE_DEFAULTS = {
    photo: ["cover", "dither"],
    logo: ["contain", "threshold"],
    static: ["contain", "threshold"]
  };
  const MAX_COUNT = 64;
  const MAX_LINES = 50;
  const MAX_ELEMENTS = 500;
  const MAX_IMAGE_ELEMENTS = 8;
  const own$2 = (values, key) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "";
  function rawValue(el, values) {
    const raw = own$2(values, el.field) || "";
    return el.piece === null ? raw : piece(raw, el.piece);
  }
  function elementValue(el, values) {
    if (el.type === "field") return applyRules(rawValue(el, values), el.rules);
    if (el.type === "text") return el.content;
    if (el.type === "barcode" || el.type === "qr") {
      return el.field !== null ? own$2(values, el.field) || "" : el.data;
    }
    return "";
  }
  function elementHidden(el, values) {
    if (el.type === "field") {
      const blank = isBlank(rawValue(el, values), el.rules);
      return blank && (el.hideWhenEmpty || el.inverted);
    }
    if (el.type === "text") return el.inverted && el.content === "";
    if (el.type === "barcode" || el.type === "qr") {
      return el.hideWhenEmpty && elementValue(el, values) === "";
    }
    return false;
  }
  function needNum(el, field, p, allowZero = true) {
    const v = get(el, field);
    const n = isNum(v) ? toFloat(v) : NaN;
    if (!isNum(v) || n < 0 || n === 0 && !allowZero) {
      p.push(allowZero ? `${field} must be a non-negative number` : `${field} must be a positive number`);
      return 0;
    }
    return n;
  }
  function align(el, p) {
    const a = getOr(el, "align", "left");
    if (!isOneOf(a, ALIGNS)) {
      p.push("align must be left/center/right");
      return "left";
    }
    return a;
  }
  function lines(el, p) {
    const v = getOr(el, "lines", numberOf(1));
    if (!isInt$2(v) || intOf(v) < 1) {
      p.push("lines must be an integer of 1 or more");
      return 1;
    }
    if (intOf(v) > MAX_LINES) {
      p.push(`lines must be at most ${MAX_LINES}`);
      return 1;
    }
    return intOf(v);
  }
  function symbology(el, p) {
    const sym = get(el, "symbology");
    if (!isOneOf(sym, SYMBOLOGIES)) {
      p.push("symbology must be code128 or code39");
      return "code128";
    }
    return sym;
  }
  function moduleIn(el, p) {
    const v = get(el, "moduleIn");
    if (v === null || v === void 0) return null;
    if (!isNum(v) || toFloat(v) <= 0) {
      p.push("moduleIn must be a positive number");
      return null;
    }
    return toFloat(v);
  }
  function barcodeOpts(el, p) {
    const sym = symbology(el, p);
    const mod = moduleIn(el, p);
    return [sym, mod, pyTruthy(getOr(el, "showText", true))];
  }
  function stroke(el, p) {
    const v = get(el, "strokeIn");
    if (!isNum(v) || toFloat(v) <= 0) {
      p.push("strokeIn must be a positive number");
      return 0.01;
    }
    return toFloat(v);
  }
  function flag(el, key, dflt) {
    return pyTruthy(getOr(el, key, dflt));
  }
  function contentOf(el, p) {
    const content = get(el, "content");
    if (typeof content !== "string") {
      p.push("content must be a string");
      return "";
    }
    return content;
  }
  function staticData(el, p) {
    const data = get(el, "data");
    if (typeof data !== "string" || !data) {
      p.push("data must be a non-empty string");
      return "";
    }
    return data;
  }
  function v1Element(el, base, p) {
    const etype = get(el, "type");
    if (etype === "text") {
      const content = contentOf(el, p);
      const fs = get(el, "fontSizePt");
      let size = 10;
      if (!isNum(fs) || toFloat(fs) <= 0) p.push("fontSizePt must be a positive number");
      else size = toFloat(fs);
      const bold = flag(el, "bold", false);
      const al = align(el, p);
      const reverse = flag(el, "reverse", false);
      const ln = lines(el, p);
      return {
        ...base,
        type: "text",
        content,
        fontSizePt: size,
        bold,
        align: al,
        reverse,
        lines: ln,
        font: null,
        baselineIn: null,
        inverted: false,
        invertPad: null
      };
    }
    if (etype === "barcode") {
      const sym = symbology(el, p);
      const data = staticData(el, p);
      const showText = flag(el, "showText", true);
      return {
        ...base,
        type: "barcode",
        symbology: sym,
        data,
        showText,
        moduleIn: moduleIn(el, p),
        field: null,
        hideWhenEmpty: false
      };
    }
    if (etype === "qr") {
      return { ...base, type: "qr", data: staticData(el, p), field: null, hideWhenEmpty: false };
    }
    if (etype === "line") return { ...base, type: "line", strokeIn: stroke(el, p) };
    if (etype === "box") return { ...base, type: "box", strokeIn: stroke(el, p), fill: false };
    p.push(`unknown type ${pyRepr(etype)}`);
    return null;
  }
  function isFamily(v) {
    if (Array.isArray(v) || isPyDict(v)) throw new TypeError("unhashable type");
    return typeof v === "string" && Object.prototype.hasOwnProperty.call(FAMILIES, v);
  }
  function font(el, p) {
    const raw = get(el, "font");
    if (raw === null || raw === void 0) return { family: DEFAULT_FAMILY, weight: "regular" };
    if (!isPyDict(raw) || !isFamily(get(raw, "family")) || !isOneOf(getOr(raw, "weight", "regular"), WEIGHTS)) {
      p.push("font must name a known family and a weight of regular or bold");
      return { family: DEFAULT_FAMILY, weight: "regular" };
    }
    return { family: get(raw, "family"), weight: getOr(raw, "weight", "regular") };
  }
  function typeset(el, p, required = true) {
    const f = font(el, p);
    const sizeRaw = get(el, "sizePt");
    let size;
    if ((sizeRaw === null || sizeRaw === void 0) && !required) {
      size = 0;
    } else if (!isNum(sizeRaw) || toFloat(sizeRaw) <= 0) {
      p.push("sizePt must be a positive number");
      size = 10;
    } else {
      size = toFloat(sizeRaw);
    }
    const baseRaw = get(el, "baselineIn");
    let baseline;
    if ((baseRaw === null || baseRaw === void 0) && !required) {
      baseline = 0;
    } else if (!isNum(baseRaw) || toFloat(baseRaw) < 0) {
      p.push("baselineIn must be a non-negative number");
      baseline = 0;
    } else {
      baseline = toFloat(baseRaw);
    }
    return [f, size, baseline];
  }
  function invertPad(el, p, sizePt) {
    const dflt = { x: 0.25 * sizePt / 72, y: 0.1 * sizePt / 72 };
    const raw = get(el, "invertPad");
    if (raw === null || raw === void 0) return dflt;
    const x = isPyDict(raw) ? get(raw, "x") : void 0;
    const y = isPyDict(raw) ? get(raw, "y") : void 0;
    if (!isNum(x) || toFloat(x) < 0 || !isNum(y) || toFloat(y) < 0) {
      p.push("invertPad must hold non-negative numbers x and y");
      return dflt;
    }
    return { x: toFloat(x), y: toFloat(y) };
  }
  function optCount(el, key, p) {
    const v = get(el, key);
    if (v === null || v === void 0) return null;
    if (!isInt$2(v) || intOf(v) < 1) {
      p.push(`${key} must be a whole number of 1 or more`);
      return null;
    }
    if (intOf(v) > MAX_COUNT) {
      p.push(`${key} must be at most ${MAX_COUNT}`);
      return null;
    }
    return intOf(v);
  }
  function optChoice(el, key, choices, p) {
    const v = get(el, key);
    if (v === null || v === void 0) return null;
    if (!isOneOf(v, choices)) {
      p.push(`${key} must be one of ${choices.join("/")}`);
      return null;
    }
    return v;
  }
  function source(el, p) {
    const fieldRaw = get(el, "field");
    const data = get(el, "data");
    const noField = fieldRaw === null || fieldRaw === void 0;
    const noData = data === null || data === void 0;
    if (noField === noData) {
      p.push("needs exactly one of field or data");
      return [null, ""];
    }
    if (!noField) {
      if (typeof fieldRaw !== "string" || !fieldRaw) {
        p.push("field must be a non-empty string");
        return [null, ""];
      }
      return [fieldRaw, ""];
    }
    if (typeof data !== "string" || !data) {
      p.push("data must be a non-empty string");
      return [null, ""];
    }
    return [null, data];
  }
  function fieldRulesOf(display, expectedLength, maxChars, trim, strip2, stripWhere) {
    const rules = { display };
    if (expectedLength !== null) rules.expected_length = expectedLength;
    if (maxChars !== null) rules.max_chars = maxChars;
    if (trim !== null) rules.trim = trim;
    if (strip2 !== null) rules.strip = strip2;
    if (stripWhere !== null) rules.strip_where = stripWhere;
    return rules;
  }
  function v2Field(el, base, p, splits) {
    const keyRaw = get(el, "field");
    let key = "";
    if (typeof keyRaw !== "string" || !keyRaw) p.push("field must be a non-empty string");
    else key = keyRaw;
    const pieceRaw = get(el, "piece");
    let piece2 = null;
    if (pieceRaw !== null && pieceRaw !== void 0) {
      if (!isInt$2(pieceRaw) || intOf(pieceRaw) < 0) {
        p.push("piece must be a whole number of 0 or more");
      } else {
        piece2 = intOf(pieceRaw);
        const names = splits.get(key);
        if (names === void 0) {
          p.push(`piece ${pyRepr(pieceRaw)} needs a Split defined for ${reprString(key)}`);
        } else if (piece2 >= names.length) {
          p.push(`piece ${pyRepr(pieceRaw)} is beyond ${reprString(key)}'s Split (${names.length} pieces)`);
        }
      }
    }
    let display = getOr(el, "display", "text");
    if (!isOneOf(display, DISPLAYS)) {
      p.push(`display must be one of ${DISPLAYS.join("/")}`);
      display = "text";
    }
    const disp = display;
    const [f, size, baseline] = typeset(el, p, disp === "text" || disp === "number");
    let strip2 = get(el, "strip");
    if (strip2 !== null && strip2 !== void 0 && typeof strip2 !== "string") {
      p.push("strip must be a string");
      strip2 = null;
    }
    const [sym, mod, showText] = disp === "barcode" ? barcodeOpts(el, p) : ["code128", null, true];
    const al = align(el, p);
    const inverted = flag(el, "inverted", false);
    const pad2 = invertPad(el, p, size);
    const hideWhenEmpty = flag(el, "hideWhenEmpty", false);
    const expectedLength = optCount(el, "expectedLength", p);
    const maxChars = optCount(el, "maxChars", p);
    const trim = optChoice(el, "trim", TRIMS, p);
    const stripText = typeof strip2 === "string" && strip2 ? strip2 : null;
    const stripWhere = optChoice(el, "stripWhere", STRIP_WHERES, p);
    return {
      ...base,
      type: "field",
      field: key,
      piece: piece2,
      display: disp,
      font: f,
      fontSizePt: size,
      baselineIn: baseline,
      align: al,
      inverted,
      invertPad: pad2,
      hideWhenEmpty,
      expectedLength,
      maxChars,
      trim,
      strip: stripText,
      stripWhere,
      symbology: sym,
      moduleIn: mod,
      showText,
      bold: f.weight === "bold",
      rules: fieldRulesOf(disp, expectedLength, maxChars, trim, stripText, stripWhere)
    };
  }
  function wholeIn(el, key, dflt, bounds, p) {
    const v = getOr(el, key, numberOf(dflt));
    const [lo, hi] = bounds;
    if (!isInt$2(v) || !(lo <= intOf(v) && intOf(v) <= hi)) {
      p.push(`${key} must be a whole number from ${lo} to ${hi}`);
      return dflt;
    }
    return intOf(v);
  }
  function v2Image$1(el, base, p) {
    let src = get(el, "source");
    if (!isOneOf(src, IMAGE_SOURCES)) {
      p.push(`source must be one of ${IMAGE_SOURCES.join("/")}`);
      src = "static";
    }
    const source_ = src;
    let imageId = null;
    const idRaw = get(el, "imageId");
    if (source_ === "static" && idRaw !== null && idRaw !== void 0) {
      if (typeof idRaw !== "string" || !idRaw) p.push("imageId must be a non-empty string");
      else imageId = idRaw;
    }
    const [fitDefault, modeDefault] = IMAGE_DEFAULTS[source_];
    let fit = getOr(el, "fit", fitDefault);
    if (!isOneOf(fit, FITS)) {
      p.push("fit must be cover or contain");
      fit = fitDefault;
    }
    let mode = getOr(el, "mode", modeDefault);
    if (!isOneOf(mode, MODES)) {
      p.push("mode must be dither or threshold");
      mode = modeDefault;
    }
    const brightness = wholeIn(el, "brightness", 0, BRIGHTNESS, p);
    const contrast = wholeIn(el, "contrast", 100, CONTRAST, p);
    const threshold = wholeIn(el, "threshold", 128, THRESHOLD, p);
    if (base.w <= 0 || base.h <= 0) p.push("an image needs a positive w and h");
    return {
      ...base,
      type: "image",
      source: source_,
      imageId,
      fit,
      mode,
      brightness,
      contrast,
      threshold,
      invert: flag(el, "invert", false),
      hideWhenEmpty: flag(el, "hideWhenEmpty", true)
    };
  }
  function v2Element$1(el, base, p, splits, schema) {
    const etype = get(el, "type");
    if (etype === "image") {
      if (schema < 3) p.push("an image element needs schema 3");
      return v2Image$1(el, base, p);
    }
    if (etype === "field") return v2Field(el, base, p, splits);
    if (etype === "text") {
      const content = contentOf(el, p);
      const [f, size, baseline] = typeset(el, p);
      const al = align(el, p);
      const ln = lines(el, p);
      const inverted = flag(el, "inverted", false);
      return {
        ...base,
        type: "text",
        content,
        fontSizePt: size,
        bold: f.weight === "bold",
        align: al,
        reverse: false,
        lines: ln,
        font: f,
        baselineIn: baseline,
        inverted,
        invertPad: invertPad(el, p, size)
      };
    }
    if (etype === "barcode" || etype === "qr") {
      const [field, data] = source(el, p);
      const hide = flag(el, "hideWhenEmpty", false);
      if (etype === "qr") return { ...base, type: "qr", data, field, hideWhenEmpty: hide };
      const [sym, mod, showText] = barcodeOpts(el, p);
      return {
        ...base,
        type: "barcode",
        symbology: sym,
        data,
        showText,
        moduleIn: mod,
        field,
        hideWhenEmpty: hide
      };
    }
    if (etype === "line") return { ...base, type: "line", strokeIn: stroke(el, p) };
    if (etype === "box") {
      return { ...base, type: "box", strokeIn: stroke(el, p), fill: flag(el, "fill", false) };
    }
    p.push(`unknown type ${pyRepr(etype)}`);
    return null;
  }
  function parseSplits(raw, problems) {
    const out = /* @__PURE__ */ new Map();
    if (raw === null || raw === void 0) return out;
    if (!isPyDict(raw)) {
      problems.push("splits must be an object");
      return out;
    }
    for (const [key, spec] of raw) {
      const pieces = isPyDict(spec) ? get(spec, "pieces") : void 0;
      if (!Array.isArray(pieces) || pieces.length === 0 || !pieces.every((n) => typeof n === "string")) {
        problems.push(`splits: ${reprString(key)} must hold a non-empty list of piece names`);
        continue;
      }
      out.set(key, [...pieces]);
    }
    return out;
  }
  function rotationOf(v) {
    if (v === false) return 0;
    if (!isPyNumber(v)) return null;
    const n = Number(v.text);
    return ROTATIONS.includes(n) ? n : null;
  }
  function parseDesign(input) {
    const raw = asPy(input);
    const problems = [];
    if (!isPyDict(raw)) throw new DesignError(["design must be an object"]);
    const schemaRaw = getOr(raw, "schema", numberOf(1));
    const schemaNum = isInt$2(schemaRaw) ? intOf(schemaRaw) : NaN;
    if (!SCHEMAS.includes(schemaNum)) {
      throw new DesignError([`schema must be 1, 2 or 3, not ${pyRepr(schemaRaw)}`]);
    }
    const schema = schemaNum;
    const size = get(raw, "size");
    const sw = isPyDict(size) ? get(size, "w") : void 0;
    const sh = isPyDict(size) ? get(size, "h") : void 0;
    if (!isNum(sw) || !isNum(sh) || toFloat(sw) <= 0 || toFloat(sh) <= 0) {
      throw new DesignError(["size must hold positive numbers w and h"]);
    }
    const elements = get(raw, "elements");
    if (!Array.isArray(elements)) throw new DesignError(["elements must be a list"]);
    if (elements.length > MAX_ELEMENTS) {
      throw new DesignError([`a design holds at most ${MAX_ELEMENTS} elements`]);
    }
    const splits = schema >= 2 ? parseSplits(get(raw, "splits"), problems) : /* @__PURE__ */ new Map();
    const parsed = [];
    const seen = /* @__PURE__ */ new Set();
    elements.forEach((el, i) => {
      if (!isPyDict(el)) {
        problems.push(`element ${i}: must be an object`);
        return;
      }
      const idRaw = get(el, "id");
      const eid = typeof idRaw === "string" ? idRaw : `element ${i}`;
      const p = [];
      const x = needNum(el, "x", p);
      const y = needNum(el, "y", p);
      const w = needNum(el, "w", p);
      const h = needNum(el, "h", p);
      let rotation = rotationOf(getOr(el, "rotation", numberOf(0)));
      if (rotation === null) {
        p.push("rotation must be one of 0/90/180/270");
        rotation = 0;
      }
      const base = { id: eid, x, y, w, h, rotation };
      const parsedEl = schema === 1 ? v1Element(el, base, p) : v2Element$1(el, base, p, splits, schema);
      if (parsedEl !== null) parsed.push(Object.freeze(parsedEl));
      if (schema === 3) {
        if (seen.has(eid)) p.push("id is used by another element");
        seen.add(eid);
      }
      for (const msg of p) problems.push(`${eid}: ${msg}`);
    });
    const images = parsed.filter((e) => e.type === "image").length;
    if (schema === 3 && images === 0) problems.push("a schema 3 design needs an image element");
    if (images > MAX_IMAGE_ELEMENTS) problems.push(`a design holds at most ${MAX_IMAGE_ELEMENTS} images`);
    if (problems.length) throw new DesignError(problems);
    return Object.freeze({
      widthIn: toFloat(sw),
      heightIn: toFloat(sh),
      elements: Object.freeze(parsed),
      schema,
      splits
    });
  }
  const TOKEN_PATTERN = /\{([a-z0-9_]+)\}/;
  const TOKEN_RE = new RegExp(TOKEN_PATTERN.source, "g");
  const own$1 = (values, key) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "";
  function applyPlaceholders(code, values) {
    return code.replace(TOKEN_RE, (_, key) => own$1(values, key));
  }
  const START = { B: ">:", C: ">;" };
  function code128Subset(data) {
    const n = cpLength(data);
    return n >= 2 && n % 2 === 0 && /^[0-9]+$/.test(data) ? "C" : "B";
  }
  function code128Data(fd2) {
    if (!fd2) return "";
    return START[code128Subset(fd2)] + fd2.split(">").join(">0");
  }
  class QrTooLong extends DesignError {
    constructor(message) {
      super([message]);
      this.name = "QrTooLong";
    }
  }
  const CAPACITY_M = [
    [34, 20, 14],
    [63, 38, 26],
    [101, 61, 42],
    [149, 90, 62],
    [202, 122, 84],
    [255, 154, 106],
    [293, 178, 122],
    [365, 221, 152],
    [432, 262, 180],
    [513, 311, 213]
  ];
  const QR_FO_OFFSET_IN = 0.2;
  function qrFoOffsetDots(dpi) {
    return pyRound(QR_FO_OFFSET_IN * dpi);
  }
  const NUMERIC = /^[0-9]*$/;
  const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;
  const MODE_NAMES = ["digits", "characters", "bytes"];
  function qrModules(value) {
    let mode;
    let length;
    if (NUMERIC.test(value)) {
      mode = 0;
      length = value.length;
    } else if (ALPHANUMERIC.test(value)) {
      mode = 1;
      length = value.length;
    } else {
      mode = 2;
      length = utf8Length(value);
    }
    for (let version = 1; version <= CAPACITY_M.length; version += 1) {
      if (length <= CAPACITY_M[version - 1][mode]) return 17 + 4 * version;
    }
    throw new QrTooLong(`QR data too long for version 10 at error correction M (${length} ${MODE_NAMES[mode]})`);
  }
  const ROT = { 0: "N", 90: "R", 180: "I", 270: "B" };
  const JUST = { left: "L", center: "C", right: "R" };
  const own = (values, key) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "";
  function intText(n) {
    return Number.isSafeInteger(n) ? String(n) : BigInt(n).toString();
  }
  function z(strings, ...args) {
    let out = strings[0];
    args.forEach((arg, i) => {
      out += (typeof arg === "number" ? intText(arg) : arg) + strings[i + 1];
    });
    return out;
  }
  function dots(v, dpi) {
    return pyRound(v * dpi);
  }
  function esc(literal) {
    let out = "";
    for (const ch of literal) {
      const cp = ch.codePointAt(0);
      if ("^~_\\".includes(ch) || cp < 32 || cp > 126) {
        for (const b of utf8Encode(ch)) out += `_${b.toString(16).padStart(2, "0")}`;
      } else {
        out += ch;
      }
    }
    return out;
  }
  function fd(value, subs) {
    let out = "";
    let pos = 0;
    for (const m of value.matchAll(TOKEN_RE)) {
      out += esc(value.slice(pos, m.index));
      out += subs === null ? m[0] : esc(own(subs, m[1]));
      pos = m.index + m[0].length;
    }
    return out + esc(value.slice(pos));
  }
  function text(el, dpi, subs) {
    const h = pyRound(el.fontSizePt * dpi / 72);
    const w = el.bold ? pyRound(h * 1.2) : h;
    let line = z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}`;
    if (el.align !== "left" || el.lines > 1) {
      line += z`^FB${dots(el.w, dpi)},${el.lines},0,${JUST[el.align]},0`;
    }
    line += z`^A0${ROT[el.rotation]},${h},${w}`;
    if (el.reverse) line += "^FR";
    return `${line}^FH_^FD${fd(el.content, subs)}^FS`;
  }
  function barcodeField(el, dpi, data, start = false) {
    let fdata = data;
    if (el.symbology === "code128") fdata = start ? code128Data(data) : data.split(">").join(">0");
    const hd = dots(el.h, dpi);
    const flag2 = el.showText ? "Y" : "N";
    const module = el.moduleIn === null ? 2 : Math.max(1, Math.min(10, dots(el.moduleIn, dpi)));
    const cmd = el.symbology === "code128" ? z`^BC${ROT[el.rotation]},${hd},${flag2},N,N` : z`^B3${ROT[el.rotation]},N,${hd},${flag2},N`;
    return z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}^BY${module}${cmd}^FH_^FD${fdata}^FS`;
  }
  function qr(el, dpi, subs) {
    const mag = Math.min(10, Math.max(1, pyRound(dots(el.w, dpi) / 25)));
    return z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}^BQ${ROT[el.rotation]},2,${mag}` + z`^FH_^FDQA,${fd(el.data, subs)}^FS`;
  }
  function shape(el, dpi) {
    const t = Math.max(1, dots(el.strokeIn, dpi));
    const w = Math.max(t, dots(el.w, dpi));
    const h = Math.max(t, dots(el.h, dpi));
    return z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}^GB${w},${h},${t}^FS`;
  }
  const STEP = {
    0: [1, 0],
    90: [0, 1],
    180: [-1, 0],
    270: [0, -1]
  };
  function origin(el, dpi, b) {
    const { x, y, w, h } = el;
    let pos;
    if (el.rotation === 90) pos = [x + h - b, y];
    else if (el.rotation === 180) pos = [x + w, y + h - b];
    else if (el.rotation === 270) pos = [x + b, y + w];
    else pos = [x, y + b];
    return [dots(pos[0], dpi), dots(pos[1], dpi)];
  }
  function invertBox(el, dpi) {
    const pad2 = el.invertPad;
    const px = dots(pad2.x, dpi);
    const py = dots(pad2.y, dpi);
    const along = dots(el.w, dpi) + 2 * px;
    const across = dots(el.h, dpi) + 2 * py;
    const x = dots(el.x, dpi);
    const y = dots(el.y, dpi);
    let [bx, by, bw, bh] = el.rotation === 90 || el.rotation === 270 ? [x - py, y - px, across, along] : [x - px, y - py, along, across];
    if (bx < 0) [bw, bx] = [bw + bx, 0];
    if (by < 0) [bh, by] = [bh + by, 0];
    bw = Math.max(1, bw);
    bh = Math.max(1, bh);
    return z`^FO${bx},${by}^GB${bw},${bh},${Math.min(bw, bh)}^FS`;
  }
  function textData(el, value, lines2) {
    if (el.type !== "text") return esc(value);
    const parts = value.split("\r\n").join("\n").split("\r").join("\n").split("\n");
    return parts.map(esc).join(lines2 > 1 ? "\\&" : "");
  }
  function v2Text(el, value, dpi) {
    const [obj, faux] = fontObject(el.font.family, el.font.weight);
    const h = pyRound(el.fontSizePt * dpi / 72);
    const w = faux && el.inverted ? pyRound(h * 1.15) : h;
    const lines2 = el.type === "text" ? el.lines : 1;
    const [ox, oy] = origin(el, dpi, el.baselineIn + (lines2 - 1) * el.fontSizePt / 72);
    const block = el.align !== "left" || lines2 > 1 ? z`^FB${dots(el.w, dpi)},${lines2},0,${JUST[el.align]},0` : "";
    const rest = z`${block}^A@${ROT[el.rotation]},${h},${w},E:${obj}` + (el.inverted ? "^FR" : "") + z`^FH_^FD${textData(el, value, lines2)}^FS`;
    const out = el.inverted ? [invertBox(el, dpi)] : [];
    out.push(z`^FT${ox},${oy}${rest}`);
    if (faux && !el.inverted) {
      const [dx, dy] = STEP[el.rotation];
      out.push(z`^FT${Math.max(0, ox + dx)},${Math.max(0, oy + dy)}${rest}`);
    }
    return out;
  }
  function v2Qr(el, value, dpi) {
    let modules;
    try {
      modules = qrModules(value);
    } catch (e) {
      if (e instanceof QrTooLong) throw new QrTooLong(`${el.id}: ${e.problems[0]}`);
      throw e;
    }
    const wd = dots(el.w, dpi);
    const hd = dots(el.h, dpi);
    const mag = Math.min(10, Math.max(1, pyRound(wd / modules)));
    const side = modules * mag;
    const x = Math.max(0, dots(el.x, dpi) + floorDiv(wd - side, 2));
    const top = dots(el.y, dpi) + floorDiv(hd - side, 2);
    const y = Math.max(0, top - qrFoOffsetDots(dpi));
    return z`^FO${x},${y}^BQN,2,${mag}^FH_^FDMA,${esc(value)}^FS`;
  }
  function v2Shape(el, dpi) {
    let t = Math.max(1, dots(el.strokeIn, dpi));
    const along = dots(el.w, dpi);
    const across = dots(el.h, dpi);
    let [w, h] = el.rotation === 90 || el.rotation === 270 ? [across, along] : [along, across];
    w = Math.max(t, w);
    h = Math.max(t, h);
    if (el.type === "box" && el.fill) t = Math.min(w, h);
    return z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}^GB${w},${h},${t}^FS`;
  }
  const EMPTY_IMAGE_STROKE = 2;
  function v2Image(el, dpi) {
    if (el.hideWhenEmpty) return [];
    const along = dots(el.w, dpi);
    const across = dots(el.h, dpi);
    const [w, h] = el.rotation === 90 || el.rotation === 270 ? [across, along] : [along, across];
    const t = EMPTY_IMAGE_STROKE;
    return [z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}^GB${Math.max(t, w)},${Math.max(t, h)},${t}^FS`];
  }
  function v2Element(el, dpi, values) {
    if (el.type === "image") return v2Image(el, dpi);
    if (el.type === "line" || el.type === "box") return [v2Shape(el, dpi)];
    if (elementHidden(el, values)) return [];
    const value = elementValue(el, values);
    const display = el.type === "field" ? el.display : null;
    if (el.type === "barcode" || el.type === "field" && display === "barcode") {
      return [barcodeField(el, dpi, esc(value), true)];
    }
    if (el.type === "qr" || el.type === "field" && display === "qr") return [v2Qr(el, value, dpi)];
    return v2Text(el, value, dpi);
  }
  function compileZpl(design, dpi, substitutions) {
    const lines2 = ["^XA", z`^PW${dots(design.widthIn, dpi)}`, z`^LL${dots(design.heightIn, dpi)}`, "^CI28"];
    const subs = substitutions ?? null;
    if (design.schema >= 2) {
      if (subs === null) throw new Error("v2 designs render with values");
      for (const el of design.elements) lines2.push(...v2Element(el, dpi, subs));
      lines2.push("^XZ");
      return lines2.join("\n");
    }
    for (const el of design.elements) {
      if (el.type === "text") lines2.push(text(el, dpi, subs));
      else if (el.type === "barcode") lines2.push(barcodeField(el, dpi, fd(el.data, subs)));
      else if (el.type === "qr") lines2.push(qr(el, dpi, subs));
      else if (el.type === "line" || el.type === "box") lines2.push(shape(el, dpi));
    }
    lines2.push("^XZ");
    return lines2.join("\n");
  }
  class UnsupportedLanguage extends Error {
    constructor(key) {
      super(`unsupported language: ${key}`);
      __publicField(this, "key");
      this.name = "UnsupportedLanguage";
      this.key = key;
    }
  }
  const has = (values, key) => Object.prototype.hasOwnProperty.call(values, key);
  function unknownOf(keys, values) {
    return [...new Set(keys)].filter((key) => !has(values, key));
  }
  const tokensIn = (text2) => [...text2.matchAll(TOKEN_RE)].map((m) => m[1]);
  function sized(design, widthIn, heightIn) {
    const raw = asPy(design);
    let out;
    if (!pyTruthy(raw)) out = /* @__PURE__ */ new Map();
    else if (isPyDict(raw)) out = new Map(raw);
    else throw new TypeError("the design is not a mapping");
    out.set("size", /* @__PURE__ */ new Map([["w", numberOf(widthIn)], ["h", numberOf(heightIn)]]));
    return out;
  }
  function renderTemplate(t, values, opts) {
    if (t.language_key !== "zpl") throw new UnsupportedLanguage(t.language_key);
    if (t.kind === "code") {
      const code = t.code || "";
      return { zpl: applyPlaceholders(code, values), unknown: unknownOf(tokensIn(code), values) };
    }
    const design = parseDesign(sized(t.design, opts.width_in, opts.height_in));
    const zpl = compileZpl(design, opts.dots, values);
    const keys = [];
    for (const el of design.elements) {
      if (design.schema >= 2) {
        if ((el.type === "field" || el.type === "barcode" || el.type === "qr") && el.field) {
          keys.push(el.field);
        }
      } else if (el.type === "text") {
        keys.push(...tokensIn(el.content));
      } else if (el.type === "barcode" || el.type === "qr") {
        keys.push(...tokensIn(el.data));
      }
    }
    return { zpl, unknown: unknownOf(keys, values) };
  }
  const EXTRA = "\\u0130\\u0131\\u017f\\u212a";
  const NAME = `([A-Z0-9_\\-${EXTRA}]+\\.TTF)`;
  const SPACE = `[${[...PY_SPACE].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}]`;
  const A_AT_RE = new RegExp(`\\^A@[^\\^~]*?E:${NAME}`, "gi");
  const CW_RE = new RegExp(`\\^CW[A-Z0-9${EXTRA}],${SPACE}*E:${NAME}`, "gi");
  function fontsUsed(code) {
    const text2 = code || "";
    const out = /* @__PURE__ */ new Set();
    for (const rx of [A_AT_RE, CW_RE]) {
      for (const m of text2.matchAll(rx)) out.add(m[1].toUpperCase());
    }
    return out;
  }
  const isInt = (v) => isPyNumber(v) && v.kind === "int";
  const schemaOf = (v) => isInt(v) ? Number(v.text) : 1;
  function designFonts(design) {
    const names = /* @__PURE__ */ new Set();
    if (!isPyDict(design)) return names;
    const schema = design.has("schema") ? design.get("schema") : void 0;
    if (schema !== void 0 && !isInt(schema)) return names;
    if (schemaOf(schema) < 2) return names;
    let parsed;
    try {
      parsed = parseDesign(design);
    } catch (e) {
      if (e instanceof DesignError) return names;
      throw e;
    }
    for (const el of parsed.elements) {
      if (el.type === "field" && el.display !== "text" && el.display !== "number") continue;
      const font2 = el.type === "field" || el.type === "text" ? el.font : null;
      if (font2 !== null) names.add(fontObject(font2.family, font2.weight)[0]);
    }
    return names;
  }
  function templateSchema(t) {
    const design = t.get("design");
    const schema = t.get("kind") === "design" && isPyDict(design) ? schemaOf(design.has("schema") ? design.get("schema") : void 0) : 1;
    return Math.max(schema, schemaOf(t.has("schema_version") ? t.get("schema_version") : void 0));
  }
  function templateFonts(t) {
    if (t === null) return [];
    if (templateSchema(t) >= 2) return sortedStrings(designFonts(t.get("design")));
    const code = t.get("code");
    const text2 = pyTruthy(code) ? code : "";
    if (typeof text2 !== "string") throw new TypeError("the template code is not text");
    return sortedStrings(fontsUsed(text2));
  }
  const NO_TEMPLATE = "no_template_at_dpi";
  const TEMPLATE_FAILED = "template_failed";
  const TEMPLATE_UNSUPPORTED = "template_unsupported";
  const SUPPORTED_SCHEMA = 2;
  function cyrb53(text2) {
    let h1 = 3735928559;
    let h2 = 1103547991;
    for (let i = 0; i < text2.length; i += 1) {
      const ch = text2.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
    h1 ^= Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
    h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  function canonical(v) {
    if (v === null || v === void 0) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") return Number.isInteger(v) ? BigInt(v).toString() : floatRepr(v);
    if (isPyNumber(v)) return v.kind === "int" ? BigInt(v.text).toString() : floatRepr(Number(v.text));
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (isPyDict(v)) {
      return `{${sortedStrings(v.keys()).map((k) => `${JSON.stringify(k)}:${canonical(v.get(k))}`).join(",")}}`;
    }
    throw new TypeError("not a fingerprint part");
  }
  function fingerprint(parts) {
    return cyrb53(canonical(parts)).toString(16).padStart(14, "0");
  }
  function readBody(text2) {
    let body;
    try {
      body = parsePyJson(text2);
    } catch {
      return null;
    }
    return isPyDict(body) ? body : null;
  }
  function iterate(raw, what) {
    if (!pyTruthy(raw)) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") return Array.from(raw);
    if (isPyDict(raw)) return [...raw.keys()];
    throw new TypeError(`${what} is not iterable`);
  }
  const REQUIRED = ["id", "family", "label_type", "dpi_key", "version"];
  function choiceOf(t) {
    if (!REQUIRED.every((k) => t.has(k))) return null;
    const version = pyInt(t.get("version"));
    if (version === null || !t.has("updated_at")) return null;
    const scope = t.get("scope");
    return {
      id: pyStr(t.get("id")),
      family: pyStr(t.get("family")),
      label_type: pyStr(t.get("label_type")),
      dpi_key: pyStr(t.get("dpi_key")),
      version,
      updated_at: pyStr(t.get("updated_at")),
      scope: pyTruthy(scope) ? scope : "global"
    };
  }
  function readTemplates(templatesJson) {
    const body = readBody(templatesJson);
    const choices = [];
    const byId = /* @__PURE__ */ new Map();
    for (const t of iterate(body?.get("templates"), "templates")) {
      const choice = isPyDict(t) ? choiceOf(t) : null;
      if (choice !== null) {
        byId.set(choice.id, t);
        choices.push(choice);
      }
    }
    return { choices, byId };
  }
  const ALL_DIGITS = /^\p{Nd}+$/u;
  function availableDpis(choices, kind) {
    const keys = new Set(choices.filter((t) => t.label_type === kind).map((t) => t.dpi_key));
    const out = /* @__PURE__ */ new Set();
    for (const key of keys) {
      if (!ALL_DIGITS.test(key) || pickTemplate(choices, kind, key)[0] === null) continue;
      const n = pyIntFromStr(key);
      if (n !== null) out.add(n);
    }
    return [...out].sort((a, b) => a - b);
  }
  function catalogKeysOf(context) {
    return iterate(context.get("catalog_keys"), "catalog_keys").map((k) => {
      if (typeof k !== "string") throw new TypeError("a catalog key is not text");
      return k;
    });
  }
  function checkInput(input) {
    if (input.kind !== "top" && input.kind !== "front") throw new TypeError(`unknown label kind: ${String(input.kind)}`);
    if (!Number.isInteger(input.dpi) || input.dpi <= 0) throw new TypeError(`bad printer DPI: ${String(input.dpi)}`);
  }
  const asMap = (values) => new Map(Object.entries(values));
  function planWithValues(input, only) {
    checkInput(input);
    const { kind, dpi } = input;
    const { choices, byId } = readTemplates(input.templatesJson);
    const [template, notes] = pickTemplate(choices, kind, String(dpi));
    const available = template === null ? availableDpis(choices, kind) : [];
    const templateJson = template !== null ? byId.get(template.id) : null;
    const rulesRaw = templateJson?.get("generation_rules");
    const rules = pyTruthy(rulesRaw) ? rulesRaw : null;
    const schema = templateJson !== null ? templateSchema(templateJson) : 1;
    const placed = schema >= 2 ? sortedStrings(designFieldKeys(templateJson.get("design"))) : [];
    let fonts = [];
    try {
      fonts = templateFonts(templateJson);
    } catch {
    }
    const assets = readBody(input.assetsJson);
    const context = assets?.get("label_context");
    const rows = assets?.get("assets");
    const hasAssetData = isPyDict(context) && Array.isArray(rows);
    const jobs = [];
    if (hasAssetData) {
      const move = labelMove(context);
      const catalogKeys2 = catalogKeysOf(context);
      for (const a of rows) {
        if (!isPyDict(a) || !pyTruthy(a.get("id"))) continue;
        const assetId = pyStr(a.get("id"));
        if (only && !only.has(assetId)) continue;
        let values;
        let fp;
        if (template === null) {
          values = assetLabelValues(labelAsset(a), move, catalogKeys2, rules);
          fp = fingerprint(["no_template", dpi, kind]);
        } else if (schema > SUPPORTED_SCHEMA) {
          values = /* @__PURE__ */ Object.create(null);
          fp = fingerprint([
            "unsupported",
            template.id,
            template.version,
            schema,
            SUPPORTED_SCHEMA,
            dpi,
            kind
          ]);
        } else {
          if (schema >= 2) {
            const every = fieldValues(a, context);
            values = /* @__PURE__ */ Object.create(null);
            for (const k of placed) {
              if (Object.prototype.hasOwnProperty.call(every, k)) values[k] = every[k];
            }
          } else {
            values = assetLabelValues(labelAsset(a), move, catalogKeys2, rules);
          }
          const tj = templateJson;
          fp = fingerprint([
            asMap(values),
            template.id,
            template.version,
            dpi,
            kind,
            tj.get("width_in"),
            tj.get("height_in"),
            tj.get("dots"),
            tj.get("language_key")
          ]);
        }
        jobs.push({ assetId, values, fingerprint: fp });
      }
    }
    return {
      template,
      templateJson,
      templateId: template?.id ?? null,
      templateFamily: template?.family ?? null,
      notes,
      fonts,
      availableDpis: available,
      hasAssetData,
      jobs
    };
  }
  function buildPlan(input) {
    const p = planWithValues(input);
    return {
      templateId: p.templateId,
      templateFamily: p.templateFamily,
      notes: p.notes,
      fonts: p.fonts,
      availableDpis: p.availableDpis,
      hasAssetData: p.hasAssetData,
      jobs: p.jobs.map(({ assetId, fingerprint: fp }) => ({ assetId, fingerprint: fp }))
    };
  }
  const positive = (v) => isPyNumber(v) && Number(v.text) > 0;
  const numberIn = (v) => isPyNumber(v) ? Number(v.text) : 0;
  function escIterated(v) {
    const items = Array.isArray(v) ? v : isPyDict(v) ? [...v.keys()] : null;
    if (items === null) return null;
    const ok = items.every((item) => typeof item === "string" && (cpLength(item) === 1 || "^~_\\".includes(item)));
    return ok ? items.join("") : null;
  }
  function renderJob(templateJson, values) {
    if (templateJson === null) return { zpl: null, outcome: NO_TEMPLATE };
    if (templateSchema(templateJson) > SUPPORTED_SCHEMA) return { zpl: null, outcome: TEMPLATE_UNSUPPORTED };
    const kindRaw = templateJson.get("kind");
    const kind = pyTruthy(kindRaw) ? kindRaw : "code";
    if (kind === "design" && !["width_in", "height_in", "dots"].every((k) => positive(templateJson.get(k)))) {
      return { zpl: null, outcome: TEMPLATE_FAILED };
    }
    const languageRaw = templateJson.get("language_key");
    const language = pyTruthy(languageRaw) ? languageRaw : "zpl";
    const text2 = /* @__PURE__ */ Object.create(null);
    const odd = /* @__PURE__ */ new Set();
    for (const [k, v] of Object.entries(values)) {
      const printed = typeof v === "string" ? v : kind === "code" ? null : escIterated(v);
      if (printed !== null) text2[k] = printed;
      else odd.add(k);
    }
    try {
      let code = null;
      if (kind === "code") {
        const raw = templateJson.get("code");
        if (pyTruthy(raw) && typeof raw !== "string") throw new TypeError("the template code is not text");
        code = typeof raw === "string" ? raw : null;
      }
      const rendered = renderTemplate({
        kind: kind === "code" ? "code" : "design",
        code,
        design: kind === "design" ? templateJson.get("design") ?? null : null,
        language_key: typeof language === "string" ? language : pyStr(language)
      }, text2, {
        width_in: numberIn(templateJson.get("width_in")),
        height_in: numberIn(templateJson.get("height_in")),
        dots: numberIn(templateJson.get("dots"))
      });
      if (rendered.unknown.some((k) => odd.has(k))) return { zpl: null, outcome: TEMPLATE_FAILED };
      return { zpl: rendered.zpl, outcome: "ok" };
    } catch (e) {
      return { zpl: null, outcome: e instanceof UnsupportedLanguage ? TEMPLATE_UNSUPPORTED : TEMPLATE_FAILED };
    }
  }
  function renderLabels(input, assetIds) {
    const plan = planWithValues(input, new Set(assetIds));
    const byId = new Map(plan.jobs.map((job) => [job.assetId, job]));
    const out = [];
    for (const assetId of assetIds) {
      const job = byId.get(assetId);
      if (!job) continue;
      const { zpl, outcome } = renderJob(plan.templateJson, job.values);
      out.push({ assetId, zpl, outcome, fingerprint: job.fingerprint });
    }
    return out;
  }
  function applyPrintSettings(zpl, s, { singleCopy = false } = {}) {
    let out = zpl;
    if (s.horizontalOffset !== 0) {
      const lsValue = -s.horizontalOffset;
      if (/\^LS-?\d+/i.test(out)) out = out.replace(/\^LS-?\d+/i, `^LS${lsValue}`);
      else out = out.replace(/\^XA/i, `^XA
^LS${lsValue}`);
      if (s.horizontalOffset > 0) {
        out = out.replace(/\^PW(\d+)/i, (_m, w) => `^PW${parseInt(w, 10) + s.horizontalOffset}`);
      }
    }
    if (s.verticalOffset !== 0) {
      out = out.replace(/\^XA/i, `^XA
^LT${s.verticalOffset}`);
    }
    const copies = s.copies ?? 1;
    if (!singleCopy && copies > 1) {
      out = out.replace(/\^XZ/i, `^PQ${copies}^XZ`);
    }
    return out;
  }
  function alignmentTestZpl(widthDots, heightDots, sizeLabel, dpi) {
    const lines2 = ["^XA", `^PW${widthDots}`, `^LL${heightDots}`, "^LH0,0"];
    const outerInset = 5;
    lines2.push(`^FO${outerInset},${outerInset}^GB${widthDots - 2 * outerInset},${heightDots - 2 * outerInset},4^FS`);
    for (let inset = outerInset + 25; widthDots - 2 * inset >= 50 && heightDots - 2 * inset >= 50; inset += 25) {
      lines2.push(`^FO${inset},${inset}^GB${widthDots - 2 * inset},${heightDots - 2 * inset},2^FS`);
    }
    lines2.push(`^FO0,${Math.round(heightDots / 2) - 12}^A0N,24,24^FB${widthDots},1,0,C,0^FDALIGN ${sizeLabel} ${dpi}DPI^FS`);
    lines2.push("^XZ");
    return lines2.join("\n");
  }
  const PRINT_MODE_RE = /\^MM[A-Z]?(?:,[A-Z])?/gi;
  function withPrintMode(zpl, peel) {
    const mode = peel ? "^MMP" : "^MMT";
    return zpl.replace(PRINT_MODE_RE, "").replace(/\^XA/gi, (xa) => `${xa}${mode}`);
  }
  function placeholderMocks(rules) {
    const out = Object.assign(/* @__PURE__ */ Object.create(null), PLACEHOLDER_MOCK_VALUES);
    applyGenerationRules(out, rules, PLACEHOLDER_MOCK_VALUES.source_raw, PLACEHOLDER_MOCK_VALUES.destination_raw);
    return out;
  }
  function sampleLabel(templatesJson, kind, dpi) {
    const input = { assetsJson: "{}", templatesJson, kind, dpi };
    const plan = planWithValues(input);
    const t = plan.templateJson;
    if (t === null) return { zpl: null, reason: plan.notes.length ? plan.notes.join(" ") : NO_TEMPLATE };
    let values;
    try {
      if (templateSchema(t) >= 2) {
        values = mockFieldValues(pyStr(t.get("label_type")), designFieldKeys(t.get("design")));
      } else {
        values = placeholderMocks(t.get("generation_rules"));
      }
    } catch {
      return { zpl: null, reason: TEMPLATE_FAILED };
    }
    const { zpl, outcome } = renderJob(t, values);
    return outcome === "ok" ? { zpl, reason: null } : { zpl: null, reason: outcome };
  }
  const VERSION = "1";
  function str(args, key) {
    const v = args[key];
    if (typeof v !== "string") throw new TypeError(`${key} must be a string`);
    return v;
  }
  function num(args, key) {
    const v = args[key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new TypeError(`${key} must be a number`);
    return v;
  }
  function planInput(args) {
    const kind = str(args, "kind");
    if (kind !== "top" && kind !== "front") throw new TypeError('kind must be "top" or "front"');
    return {
      assetsJson: str(args, "assetsJson"),
      templatesJson: str(args, "templatesJson"),
      kind,
      dpi: num(args, "dpi")
    };
  }
  function call(fn) {
    return (argsJson) => {
      try {
        const args = JSON.parse(argsJson);
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          throw new TypeError("the arguments must be a JSON object");
        }
        return JSON.stringify(fn(args));
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message || e.name : String(e) });
      }
    };
  }
  const surface = {
    version: VERSION,
    buildPlan: call((a) => buildPlan(planInput(a))),
    renderLabels: call((a) => {
      const ids = a.assetIds;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
        throw new TypeError("assetIds must be a list of strings");
      }
      return { results: renderLabels(planInput(a), ids) };
    }),
    sampleLabel: call((a) => {
      const { templatesJson, kind, dpi } = planInput({ ...a, assetsJson: "{}" });
      return sampleLabel(templatesJson, kind, dpi);
    }),
    applyPrintSettings: call((a) => ({
      zpl: applyPrintSettings(
        str(a, "zpl"),
        { verticalOffset: num(a, "verticalOffset"), horizontalOffset: num(a, "horizontalOffset") },
        { singleCopy: true }
      )
    })),
    withPrintMode: call((a) => {
      if (typeof a.peel !== "boolean") throw new TypeError("peel must be a boolean");
      return { zpl: withPrintMode(str(a, "zpl"), a.peel) };
    }),
    alignmentTestZpl: call((a) => ({
      zpl: alignmentTestZpl(num(a, "widthDots"), num(a, "heightDots"), str(a, "sizeLabel"), num(a, "dpi"))
    }))
  };
  globalThis.labelgen = surface;
  exports.VERSION = VERSION;
  exports.surface = surface;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
}({});
