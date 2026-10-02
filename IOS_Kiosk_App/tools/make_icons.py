#!/usr/bin/env python3
"""Generates the iOS kiosk app icon and the Logo / LoginMountains image sets from the portal assets."""
import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
IMAGES = ROOT / "portal/public/images"
ASSETS = ROOT / "IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/Assets.xcassets"


def write_contents(folder: Path, filename: str) -> None:
    contents = {
        "images": [{"filename": filename, "idiom": "universal"}],
        "info": {"author": "xcode", "version": 1},
    }
    (folder / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n")


def main() -> None:
    logo_path = IMAGES / "serversherpa-logo.png"

    # (a) App icon: logo centered at 80% on a #f1f4f7 canvas, no alpha.
    icon = ASSETS / "AppIcon.appiconset"
    icon.mkdir(parents=True, exist_ok=True)
    canvas = Image.new("RGB", (1024, 1024), "#f1f4f7")
    logo = Image.open(logo_path).convert("RGBA")
    target = int(1024 * 0.8)
    scale = min(target / logo.width, target / logo.height)
    logo = logo.resize((round(logo.width * scale), round(logo.height * scale)), Image.LANCZOS)
    canvas.paste(logo, ((1024 - logo.width) // 2, (1024 - logo.height) // 2), logo)
    canvas.save(icon / "AppIcon-1024.png")
    (icon / "Contents.json").write_text(json.dumps({
        "images": [{"filename": "AppIcon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
        "info": {"author": "xcode", "version": 1},
    }, indent=2) + "\n")

    # (b) Logo image set.
    logo_set = ASSETS / "Logo.imageset"
    logo_set.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(logo_path, logo_set / "serversherpa-logo.png")
    write_contents(logo_set, "serversherpa-logo.png")

    # (c) Login mountains image set (webp -> png).
    mountains = ASSETS / "LoginMountains.imageset"
    mountains.mkdir(parents=True, exist_ok=True)
    Image.open(IMAGES / "login-mountains-light.webp").save(mountains / "login-mountains.png")
    write_contents(mountains, "login-mountains.png")


if __name__ == "__main__":
    main()
