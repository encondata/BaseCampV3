# Renders play-store/feature-graphic.png (1024x500).
# Usage, from the repo root: python3 Android_Kiosk_App/play-store/make_feature_graphic.py . Android_Kiosk_App/play-store/feature-graphic.png
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
R, out = sys.argv[1], sys.argv[2]
W, H = 1024, 500
INK, SNOW, MUTE, ORANGE = (12,17,23), (232,237,244), (138,151,170), (255,161,46)
img = Image.new("RGB", (W, H), INK)
# mountains on the right, fading into ink
m = Image.open(f"{R}/portal/public/images/login-mountains-light.webp").convert("RGB")
m = m.resize((int(m.width * H / m.height * 1.05), int(H * 1.05)))
m = m.crop((0, 0, min(m.width, 640), H))
mask = Image.new("L", m.size)
md = ImageDraw.Draw(mask)
for x in range(m.width):
    md.line([(x, 0), (x, H)], fill=int(255 * min(1, x / (m.width * 0.55)) * 0.85))
from PIL import ImageEnhance
m = ImageEnhance.Brightness(m).enhance(0.92)
img.paste(m, (W - m.width, 0), mask)
# a dark scrim so text stays readable
scrim = Image.new("L", (W, H))
sd = ImageDraw.Draw(scrim)
for x in range(W):
    sd.line([(x, 0), (x, H)], fill=int(max(0, min(255, 330 - x * 0.5))))
img.paste(Image.new("RGB", (W, H), INK), (0, 0), scrim)
d = ImageDraw.Draw(img)
def geo(size, wght):
    f = ImageFont.truetype(f"{R}/Android_Kiosk_App/app/src/main/res/font/geologica.ttf", size)
    try: f.set_variation_by_axes([wght] + [0] * (len(f.get_variation_axes()) - 1))
    except Exception: pass
    return f
mono = ImageFont.truetype(f"{R}/Android_Kiosk_App/app/src/main/res/font/fragment_mono.ttf", 15)
logo = Image.open(f"{R}/portal/public/images/serversherpa-logo.png").convert("RGBA").resize((128, 128), Image.LANCZOS)
img.paste(logo, (64, 84), logo)
big = geo(64, 700)
d.text((64, 236), "Server", font=big, fill=SNOW)
d.text((64 + d.textlength("Server", font=big), 236), "Sherpa", font=big, fill=ORANGE)
d.text((67, 224), "D A T A C E N T E R  R E L O C A T I O N  T O O L S", font=mono, fill=MUTE)
d.text((64, 318), "Kiosk", font=geo(44, 500), fill=SNOW)
d.text((64, 384), "Scan, RFID-tag, label and clock in", font=geo(26, 400), fill=MUTE)
d.text((64, 416), "on every data center move.", font=geo(26, 400), fill=MUTE)
img.save(out)
print(out, img.size)
