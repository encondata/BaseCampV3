"""Generate the launcher icon set from the portal logo.

Usage (from Android_Kiosk_App/):  python3 tools/make_icons.py
Source: ../portal/public/images/serversherpa-logo.png (890x890 RGBA).
Writes the adaptive-icon foreground PNGs and the legacy square/round
webp icons for every density. The background is a flat color resource
(ic_launcher_background in values/colors.xml), so no background image is
written. Re-run this script to change the icon; never hand-edit the
generated files.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT.parent / "portal" / "public" / "images" / "serversherpa-logo.png"
RES = ROOT / "app" / "src" / "main" / "res"
BG = (241, 244, 247, 255)  # --paper-2

# density -> (adaptive canvas px for 108dp, legacy icon px for 48dp)
DENSITIES = {
    "mdpi": (108, 48), "hdpi": (162, 72), "xhdpi": (216, 96),
    "xxhdpi": (324, 144), "xxxhdpi": (432, 192),
}
SAFE_FRACTION = 66 / 108   # the adaptive safe zone is a 66dp circle


def fit_logo(logo: Image.Image, canvas_px: int, fraction: float) -> Image.Image:
    size = round(canvas_px * fraction)
    scaled = logo.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
    off = (canvas_px - size) // 2
    out.alpha_composite(scaled, (off, off))
    return out


def legacy(logo: Image.Image, px: int, round_mask: bool) -> Image.Image:
    base = Image.new("RGBA", (px, px), BG)
    base.alpha_composite(fit_logo(logo, px, 0.80))
    if round_mask:
        mask = Image.new("L", (px, px), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, px - 1, px - 1), fill=255)
        base.putalpha(mask)
    return base


def main() -> None:
    logo = Image.open(SRC).convert("RGBA")
    for density, (adaptive_px, legacy_px) in DENSITIES.items():
        d = RES / f"mipmap-{density}"
        d.mkdir(parents=True, exist_ok=True)
        fit_logo(logo, adaptive_px, SAFE_FRACTION).save(d / "ic_launcher_foreground.png")
        legacy(logo, legacy_px, False).save(d / "ic_launcher.webp", quality=95)
        legacy(logo, legacy_px, True).save(d / "ic_launcher_round.webp", quality=95)
    print("icons written")


if __name__ == "__main__":
    main()
