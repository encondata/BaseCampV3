"""Spaces files that follow a recipe's records. A column holds file keys
when its name says so (the rule scripts/make-sql-seed-snapshot.sh uses):
storage_key, preview_key, avatar_key, logo_key, file_key, or any name
ending in _storage_key."""

FILE_KEY_COLUMNS = frozenset({"storage_key", "preview_key", "avatar_key", "logo_key", "file_key"})
FILE_KEY_SUFFIX = "_storage_key"


def file_columns(columns: list[str]) -> list[str]:
    """The names in `columns` that hold file keys, in their order."""
    return [c for c in columns if c in FILE_KEY_COLUMNS or c.endswith(FILE_KEY_SUFFIX)]
