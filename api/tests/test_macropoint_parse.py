"""MacroPoint email parser — every field of each sample kind, pasted text
in both copy styles, the cross-format dedup key and the error reasons."""

import time
from datetime import UTC, datetime
from email.message import EmailMessage
from pathlib import Path

import pytest

from serversherpa.trucks.macropoint.client import MacroPointClient
from serversherpa.trucks.macropoint.parse import (
    ParsedMessage,
    ParseError,
    normalize_id,
    parse_eml,
    parse_inputs,
    parse_text,
    source_ref_for,
)

FIX = Path(__file__).parent / "fixtures" / "macropoint"


def one(name: str) -> ParsedMessage:
    [msg] = parse_eml((FIX / name).read_bytes(), name)
    assert isinstance(msg, ParsedMessage), msg
    return msg


def utc(*args) -> datetime:
    return datetime(*args, tzinfo=UTC)


def test_location_landstar_pt():
    m = one("loc_landstar_pt.eml")
    assert m.kind == "location"
    assert m.source == "loc_landstar_pt.eml"
    assert m.carrier == "Landstar - ATL"
    assert m.id_number == "QR01294949 - CA-NV"
    assert m.order_token == "Dk4ScKJ-t64u-XiTR8UdjQ__"
    assert m.recorded_at == utc(2024, 6, 8, 1, 24)          # 6:24 PM PDT
    assert (m.lat, m.lng) == (35.34956359, -115.94153837)
    assert m.address == "Mojave Freeway (I-15) Nipton CA 92364 United States"
    assert m.event is None and m.event_kind is None and m.stop is None


def test_location_longboard_ct_has_no_order_token():
    m = one("loc_longboard_ct.eml")
    assert m.carrier == "Longboard Transportation"
    assert m.id_number == "TEAM MARTHA & JOEL- BROADCOM EQUINIX- TX TO VA"
    assert m.order_token is None                          # visibility link: per message
    assert m.recorded_at == utc(2026, 3, 13, 18, 22)        # 1:22 PM CDT
    assert m.address == "Stony Point Rd Harrisonburg VA 22802 USA"   # doubled space squashed


def test_location_et_with_slash_id_and_bang_token():
    m = one("loc_landstar_et_slash.eml")
    assert m.id_number == "CL01287769/TX-MN"
    assert m.order_token == "TU7xeFzI44nw4JRZWxxw!A__"
    assert m.recorded_at == utc(2024, 5, 17, 22, 22)        # 6:22 PM EDT
    assert m.address == "Inver Grove Heights MN 55077 United States"


def test_location_heavy_whitespace():
    m = one("loc_heavy_whitespace.eml")
    assert m.id_number == "TEAM WRIGHT WA TO NV- LARGE PROJECT"
    assert m.address == "I-90 Post Falls ID 83854 United States"
    assert m.recorded_at == utc(2024, 10, 12, 0, 47)


@pytest.mark.parametrize(("name", "event", "kind", "stop", "at"), [
    ("trip_arrived_pickup.eml", "Arrived at Pickup", "arrived", "pickup", utc(2024, 10, 15, 14, 36)),
    ("trip_departed_pickup.eml", "Departed at Pickup", "departed", "pickup", utc(2024, 10, 15, 15, 11)),
    ("trip_arrived_dropoff.eml", "Arrived at Drop-Off", "arrived", "drop_off", utc(2024, 10, 16, 2, 28)),
    ("trip_departed_dropoff.eml", "Departed at Drop-Off", "departed", "drop_off", utc(2024, 10, 16, 15, 27)),
    ("trip_named_stop.eml", "Arrived at BROADCOM DRT ACC4", "arrived", "BROADCOM DRT ACC4",
     utc(2026, 3, 13, 20, 11)),
])
def test_trip_events(name, event, kind, stop, at):
    m = one(name)
    assert m.kind == "trip_event"
    assert m.event == event
    assert m.event_kind == kind
    assert m.stop == stop
    assert m.recorded_at == at
    assert m.lat is None and m.address == ""


def test_trip_event_reads_html_not_truncated_plain():
    # The text/plain part of this email stops at "JAMIE" (truncated at "&").
    assert one("trip_departed_pickup.eml").id_number == "JAMIE & PATRICK -NV TO PALO ALTO"


def test_load_shares_one_order_token_across_kinds():
    tokens = {one(n).order_token for n in (
        "loc_jamie.eml", "trip_arrived_pickup.eml", "trip_departed_dropoff.eml")}
    assert tokens == {"VM0s7D8QTl5j92QfqQgTmQ__"}


def test_non_macropoint_email_is_an_error_not_a_crash():
    assert parse_eml((FIX / "locus_traxx.eml").read_bytes(), "locus_traxx.eml") == [
        ParseError("locus_traxx.eml", "not_macropoint")]
    assert parse_eml(b"", "empty.eml") == [ParseError("empty.eml", "not_macropoint")]


def test_pasted_outlook_two_emails():
    text = (FIX / "pasted_outlook_two.txt").read_text()
    loc, trip = parse_text(text, "Pasted text")
    assert loc.source == "Pasted text #1" and trip.source == "Pasted text #2"
    assert loc.kind == "location" and loc.order_token is None
    assert loc.id_number == "JAMIE & PATRICK -NV TO PALO ALTO"
    assert loc.recorded_at == utc(2024, 10, 15, 20, 32)
    assert (loc.lat, loc.lng) == (35.48169252, -119.14035278)
    assert loc.address == "CA-99 Bakersfield CA 93308 United States"
    assert trip.event == "Arrived at Pickup" and trip.stop == "pickup"


def test_pasted_plain_run_together():
    text = (FIX / "pasted_plain_runtogether.txt").read_text()
    loc, trip = parse_text(text, "Pasted text")
    assert loc.id_number == "QR01294949 - CA-NV"
    assert loc.recorded_at == utc(2024, 6, 8, 1, 24)
    assert loc.address == "Mojave Freeway (I-15) Nipton CA 92364 United States"
    assert trip.id_number == "TEAM WRIGHT WA TO NV- LARGE PROJECT"
    assert trip.recorded_at == utc(2024, 10, 12, 8, 53)
    assert trip.event == "Departed at Pickup"


def test_same_update_eml_and_pasted_share_source_ref():
    pasted = parse_text((FIX / "pasted_outlook_two.txt").read_text(), "Pasted text")
    assert pasted[0].source_ref == one("loc_jamie.eml").source_ref
    assert pasted[1].source_ref == one("trip_arrived_pickup.eml").source_ref
    plain = parse_text((FIX / "pasted_plain_runtogether.txt").read_text(), "Pasted text")
    assert plain[0].source_ref == one("loc_landstar_pt.eml").source_ref


def test_source_ref_shape_and_sensitivity():
    at = utc(2024, 1, 1, 10, 5, 42)
    ref = source_ref_for("location", "Load  A", at, lat=1.0, lng=2.0)
    assert len(ref) == 32
    assert ref == source_ref_for("location", "load a", utc(2024, 1, 1, 10, 5), lat=1.0, lng=2.0)
    assert ref != source_ref_for("location", "load a", at, lat=1.0, lng=2.00002)
    assert ref != source_ref_for("trip_event", "load a", at, event="Arrived at Pickup")


def test_normalize_id():
    assert normalize_id("  TEAM  Wright\tWA ") == "team wright wa"


def _loc_text(time_line: str, location: str = "35.1,-115.2") -> str:
    return ("Location Update from Landstar - ATL\nID Number 'L1'\n"
            f"Date/Time: {time_line}\nLocation: {location} (View All Updates)\n")


@pytest.mark.parametrize(("text", "reason"), [
    (_loc_text("6/7/2024 @ 6:24 PM ZZ"), "unknown_zone"),
    (_loc_text("13/45/2024 @ 6:24 PM PT"), "bad_time"),
    ("Location Update from Landstar - ATL\nID Number 'L1'\nLocation: 1,2", "missing_field:date_time"),
    (_loc_text("6/7/2024 @ 6:24 PM PT", location="none"), "missing_field:location"),
    (_loc_text("6/7/2024 @ 6:24 PM PT", location="95.0,10.0"), "bad_location"),
    ("Location Update from Landstar - ATL\nDate/Time: 6/7/2024 @ 6:24 PM PT", "missing_field:id_number"),
    ("Trip Event Update from Landstar - ATL\nID Number : L1\nDate/Time: 6/7/2024 @ 6:24 PM PT\n",
     "missing_field:event"),
    ("hello, nothing to see", "not_macropoint"),
])
def test_parse_errors(text, reason):
    [result] = parse_text(text, "Pasted text")
    assert result == ParseError("Pasted text", reason)


def test_parse_inputs_files_then_text():
    files = [("loc_jamie.eml", (FIX / "loc_jamie.eml").read_bytes()),
             ("locus_traxx.eml", (FIX / "locus_traxx.eml").read_bytes())]
    out = parse_inputs(files, (FIX / "pasted_plain_runtogether.txt").read_text())
    assert [o.source for o in out] == [
        "loc_jamie.eml", "locus_traxx.eml", "Pasted text #1", "Pasted text #2"]
    assert parse_inputs([], "   ") == []


def test_api_client_is_a_placeholder():
    with pytest.raises(NotImplementedError):
        MacroPointClient().fetch_updates("token")


def test_huge_whitespace_runs_do_not_hang():
    pad = " " * 200_000
    text = (f"Location Update from Landstar - ATL\nID Number : LOAD{pad}A\n"
            f"Date/Time: 6/7/2024 @ 6:24 PM PT\nLocation: 35.1,-115.2 (View All Updates)\n"
            f"Approximate Address(if available): Main St{pad}Reno NV Notes:\n")
    start = time.perf_counter()
    [msg] = parse_text(text, "Pasted text")
    assert time.perf_counter() - start < 1.0
    assert isinstance(msg, ParsedMessage)
    assert msg.id_number == "LOAD A"
    assert msg.address == "Main St Reno NV"


_LOC_HEAD = ("Location Update from Landstar - ATL\nID Number : L1\n"
             "Date/Time: 6/7/2024 @ 6:24 PM PT\nLocation: 35.1,-115.2 (View All Updates)\n"
             "Approximate Address(if available): Main St")


@pytest.mark.parametrize("gap", ["\n" * 200_000, " \n" * 100_000])
def test_huge_newline_runs_in_address_do_not_hang(gap):
    start = time.perf_counter()
    [msg] = parse_text(f"{_LOC_HEAD}{gap}Reno NV", "Pasted text")
    assert time.perf_counter() - start < 2.0
    assert isinstance(msg, ParsedMessage)
    assert msg.address.startswith("Main St")


def test_many_repeated_headers_without_newlines_do_not_hang():
    start = time.perf_counter()
    out = parse_text("Location Update from X " * 20_000, "Pasted text")
    assert time.perf_counter() - start < 2.0
    assert isinstance(out, list)


@pytest.mark.parametrize("gap", ["\r" * 500_000, "\u3000" * 500_000, "\f" * 500_000])
def test_other_whitespace_runs_in_address_do_not_hang(gap):
    start = time.perf_counter()
    [msg] = parse_text(f"{_LOC_HEAD}{gap}Reno NV", "Pasted text")
    assert time.perf_counter() - start < 2.0
    assert isinstance(msg, ParsedMessage)
    assert msg.address.startswith("Main St")


def test_huge_space_run_after_carrier_and_id_does_not_hang():
    pad = " " * 500_000
    text = (f"Location Update from Landstar - ATL{pad}\nID Number : L1{pad}\n"
            "Date/Time: 6/7/2024 @ 6:24 PM PT\nLocation: 35.1,-115.2 (View All Updates)\n")
    start = time.perf_counter()
    [msg] = parse_text(text, "Pasted text")
    assert time.perf_counter() - start < 2.0
    assert isinstance(msg, ParsedMessage)
    assert (msg.carrier, msg.id_number) == ("Landstar - ATL", "L1")


def _html_eml(markup: str) -> bytes:
    msg = EmailMessage()
    msg["Subject"] = "Location Update"
    msg.set_content(markup, subtype="html")
    return msg.as_bytes()


@pytest.mark.parametrize("junk", ["OrderSetup.aspx?", "<title", "<a", "<script"])
def test_huge_repeated_html_fragments_do_not_hang(junk):
    """~1 MB of one fragment repeated: the order-token and tag-stripping
    patterns must stay linear (they were quadratic: minutes per file)."""
    data = _html_eml(junk * (1_000_000 // len(junk)))
    start = time.perf_counter()
    out = parse_eml(data, "big.eml")
    assert time.perf_counter() - start < 2.0
    assert out == [ParseError("big.eml", "not_macropoint")]


def test_order_token_forms():
    def token(link: str) -> str | None:
        body = (f'<p>Location Update from Landstar - ATL<br>ID Number \'L1\'<br>'
                f'Date/Time: 6/7/2024 @ 6:24 PM PT<br>Location: 35.1,-115.2 '
                f'(<a href="{link}">View All Updates</a>)</p>')
        [msg] = parse_eml(_html_eml(body), "x.eml")
        assert isinstance(msg, ParsedMessage), msg
        return msg.order_token

    base = "https://MacroPoint-Lite.com/Secure/OrderSetup.aspx?"
    assert token(base + "Mode=CreateWithQuery&amp;Data=Tok_1") == "Tok_1"
    assert token(base + "Mode=CreateWithQuery&Data=Tok_2") == "Tok_2"
    assert token(base + "Data=Tok_3") == "Tok_3"
    assert token(base + "UserData=nope") is None
    assert token(base + "Mode=" + "x" * 1000 + "&Data=far") is None    # bounded scan


def test_unclosed_title_is_dropped_to_the_end():
    from serversherpa.trucks.macropoint.parse import html_to_text
    assert html_to_text("<p>keep</p><title>gone") == "keep"
    assert html_to_text("a<title>t</title >b") == "ab"
    assert html_to_text("1 < 2 <b>bold</b>") == "1 < 2 bold"
