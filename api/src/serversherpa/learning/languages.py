"""The languages learning can be offered in. Learning settings switch them
on (`languages`, English always); a language that is on can be translated
into, read and signed in. The portal and the learn site name each one with
the browser's own Intl.DisplayNames, so this list only holds the tags and
which of them read right to left. Adding a language is one line here."""

ENGLISH = "en"

# tag → reads right to left (the comment is the English name)
CATALOG: dict[str, bool] = {
    "en": False,       # English
    "ar": True,        # Arabic
    "bn": False,       # Bangla
    "my": False,       # Burmese
    "zh-Hans": False,  # Chinese (Simplified)
    "zh-Hant": False,  # Chinese (Traditional)
    "cs": False,       # Czech
    "da": False,       # Danish
    "nl": False,       # Dutch
    "fil": False,      # Filipino
    "fi": False,       # Finnish
    "fr": False,       # French
    "de": False,       # German
    "el": False,       # Greek
    "he": True,        # Hebrew
    "hi": False,       # Hindi
    "hu": False,       # Hungarian
    "id": False,       # Indonesian
    "it": False,       # Italian
    "ja": False,       # Japanese
    "km": False,       # Khmer
    "ko": False,       # Korean
    "ms": False,       # Malay
    "ne": False,       # Nepali
    "nb": False,       # Norwegian
    "fa": True,        # Persian
    "pl": False,       # Polish
    "pt": False,       # Portuguese
    "pa": False,       # Punjabi
    "ro": False,       # Romanian
    "ru": False,       # Russian
    "es": False,       # Spanish
    "sw": False,       # Swahili
    "sv": False,       # Swedish
    "ta": False,       # Tamil
    "te": False,       # Telugu
    "th": False,       # Thai
    "tr": False,       # Turkish
    "uk": False,       # Ukrainian
    "ur": True,        # Urdu
    "vi": False,       # Vietnamese
}

CODES: tuple[str, ...] = tuple(CATALOG)


def offered(enabled: list[str]) -> list[str]:
    """The switched-on languages in catalog order, English first; anything
    no longer in the catalog drops out."""
    on = set(enabled) | {ENGLISH}
    return [code for code in CODES if code in on]
