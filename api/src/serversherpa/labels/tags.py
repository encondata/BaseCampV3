"""Container label tag keys — the single source of truth for the five
tags the Container Labels PDF assigns per container (Priority / Vendor /
Accessories / E-Waste / Warehouse). Shared by `containers.label_tag`
(schemas/routes/bulk import) and the `container_labels` report module's
run-option validation, so both sides always agree on the allowed set.

See docs/superpowers/specs/2026-09-12-container-labels-design.md,
Addendum 2026-09-12 — the label tag lives on the container."""

LABEL_TAG_KEYS = ("priority", "vendor", "accessories", "ewaste", "warehouse")

# Display labels, for bulk import's by-label matching (e.g. "E-Waste").
LABEL_TAG_LABELS = {
    "priority": "Priority",
    "vendor": "Vendor",
    "accessories": "Accessories",
    "ewaste": "E-Waste",
    "warehouse": "Warehouse",
}


def resolve_label_tag(raw: str) -> str | None:
    """Case-insensitive match against either the key or the display
    label (e.g. "ewaste" or "E-Waste" both resolve to "ewaste").
    Returns None when raw matches neither."""
    value = raw.strip().lower()
    if value in LABEL_TAG_KEYS:
        return value
    for key, label in LABEL_TAG_LABELS.items():
        if label.lower() == value:
            return key
    return None
