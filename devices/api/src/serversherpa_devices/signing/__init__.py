"""Re-signing IPAs on Linux with rcodesign (apple-codesign)."""


class SignError(Exception):
    """Signing can't succeed as things stand (a bad certificate or IPA, the
    signer failing); trying again won't help. The message is for the admin
    and never holds a secret file's path."""
