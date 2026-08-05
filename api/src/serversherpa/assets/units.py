"""Dual-unit fields: the client enters either unit system; the server
computes the partner so both are stored and exports never convert.

Rule (from the spec): if exactly one side of a pair is present in the
payload, compute the other; if both are present, store both as sent
(imports send both); None clears the pair."""

LB_TO_KG = 0.453592
IN_TO_CM = 2.54

UNIT_PAIRS: tuple[tuple[str, str, float], ...] = (
    ("weight_lbs", "weight_kg", LB_TO_KG),
    ("length_in", "length_cm", IN_TO_CM),
    ("width_in", "width_cm", IN_TO_CM),
    ("height_in", "height_cm", IN_TO_CM),
)


def apply_unit_pairs(data: dict) -> dict:
    for imperial, metric, factor in UNIT_PAIRS:
        if imperial in data and metric not in data:
            data[metric] = (None if data[imperial] is None
                            else round(float(data[imperial]) * factor, 2))
        elif metric in data and imperial not in data:
            data[imperial] = (None if data[metric] is None
                              else round(float(data[metric]) / factor, 2))
    return data
