import pytest

from serversherpa.people.contact_format import format_phone, lower_email


@pytest.mark.parametrize("raw,want", [
    ("5125551212", "+1 512 555 1212"), ("(512) 555-1212", "+1 512 555 1212"),
    ("+1 512-555-1212", "+1 512 555 1212"), ("1-512-555-1212", "+1 512 555 1212"),
    ("+44 20 1234 5678", "+44 20 1234 5678"), ("+442012345678", "+44 20 1234 5678"),
    ("+31620746385", "+31 6 2074 6385"), ("+31 6 20746385", "+31 6 2074 6385"),
    ("+31 20 123 4567", "+31 20 123 4567"),
    ("", ""), ("   ", ""),
])
def test_format_phone(raw, want):
    assert format_phone(raw) == want


@pytest.mark.parametrize("raw", ["abc", "12", "+999 1234"])
def test_format_phone_unparseable(raw):
    assert format_phone(raw) is None


def test_lower_email():
    assert lower_email("  Person.A@Example.COM ") == "person.a@example.com"
