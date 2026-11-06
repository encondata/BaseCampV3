"""Country-standard phone and lowercase email formatting for people imports."""

import phonenumbers


def format_phone(text: str, default_region: str = "US") -> str | None:
    """Format a phone number as "+C NNN NNN NNNN".

    Returns "" for blank input and None when the text cannot be parsed or is
    not a valid number.
    """
    raw = (text or "").strip()
    if not raw:
        return ""
    try:
        number = phonenumbers.parse(raw, default_region)
    except phonenumbers.NumberParseException:
        return None
    if not phonenumbers.is_valid_number(number):
        return None
    national = str(number.national_number)
    if number.country_code == 31 and len(national) == 9 and national.startswith("6"):
        # Dutch mobiles read "+31 6 2074 6385", not libphonenumber's "+31 6 20746385"
        return f"+31 6 {national[1:5]} {national[5:]}"
    formatted = phonenumbers.format_number(number, phonenumbers.PhoneNumberFormat.INTERNATIONAL)
    return formatted.replace("-", " ")


def lower_email(text: str) -> str:
    """Strip and lowercase an email address."""
    return (text or "").strip().lower()
