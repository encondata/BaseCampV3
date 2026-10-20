"""Server-side badge image prep (labels/image_prep.py, spec
2026-10-20-badge-templates §4.5, §4.11, §4.12): any stored picture (a V2
avatar with EXIF rotation, a transparent PNG logo, a library image) becomes
an 8-bit gray raster of exactly the element's dot box, turned by exact
transposition, ready for the shared dither. Pure: no database.

Pillow lives only in this module, and the API imports it lazily."""

import io
import struct
import subprocess
import sys
import textwrap
import warnings
import zlib
from pathlib import Path

import pytest
from PIL import Image, ImageFile, JpegImagePlugin

import serversherpa
from serversherpa.labels import image_prep
from serversherpa.labels.image_prep import ImageTooLarge, Raster, UnreadableImage, gray_raster

SRC = Path(serversherpa.__file__).resolve().parents[1]


def _png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def _rows(raster: Raster) -> list[list[int]]:
    w = raster.width
    return [list(raster.gray[y * w:(y + 1) * w]) for y in range(raster.height)]


def _gray(width: int, height: int, values: list[int]) -> Image.Image:
    im = Image.new("L", (width, height))
    im.putdata(values)
    return im


def test_transparent_logo_prints_on_white():
    """A transparent PNG's clear pixels are often stored as black (0,0,0,0):
    composited onto white, they print white, not as a black square."""
    logo = Image.new("RGBA", (20, 10), (0, 0, 0, 0))
    logo.paste((0, 0, 0, 255), (6, 2, 14, 8))
    raster = gray_raster(_png(logo), 20, 10, "contain", 0)
    assert (raster.width, raster.height) == (20, 10)
    rows = _rows(raster)
    assert rows[0] == [255] * 20 and rows[9] == [255] * 20
    assert rows[5][0] == 255 and rows[5][19] == 255
    assert rows[5][6:14] == [0] * 8
    # half-transparent black is mid gray over white
    half = Image.new("RGBA", (4, 4), (0, 0, 0, 128))
    assert set(gray_raster(_png(half), 4, 4, "cover", 0).gray) == {127}
    # palette transparency (a GIF or 8-bit PNG) is white too
    pal = Image.new("P", (4, 4), 0)
    pal.putpalette([0, 0, 0, 255, 255, 255])
    pal.info["transparency"] = 0
    assert set(gray_raster(_png(pal), 4, 4, "cover", 0).gray) == {255}


def test_luma_is_itu_601():
    """Pillow's L conversion: L = R*299/1000 + G*587/1000 + B*114/1000."""
    im = Image.new("RGB", (3, 1))
    im.putdata([(255, 0, 0), (0, 255, 0), (0, 0, 255)])
    assert list(gray_raster(_png(im), 3, 1, "cover", 0).gray) == [76, 150, 29]


def test_exif_rotated_jpeg_is_upright():
    """A V2 avatar stored raw with EXIF orientation 6 (turn 90° clockwise
    to view) comes out as the camera saw it."""
    upright = Image.new("L", (40, 20), 255)
    upright.paste(0, (0, 0, 20, 20))                  # left half black
    stored = upright.transpose(Image.Transpose.ROTATE_90)   # 20 x 40, black at the bottom
    exif = Image.Exif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    stored.save(buf, "JPEG", exif=exif, quality=95)
    raster = gray_raster(buf.getvalue(), 40, 20, "cover", 0)
    rows = _rows(raster)
    assert (raster.width, raster.height) == (40, 20)
    assert rows[10][4] < 40 and rows[10][35] > 215          # black left, white right
    assert rows[2][10] < 40 and rows[17][30] > 215
    # without the tag it is the stored picture's middle band: white over black
    plain = io.BytesIO()
    stored.save(plain, "JPEG", quality=95)
    rows = _rows(gray_raster(plain.getvalue(), 40, 20, "cover", 0))
    assert rows[2][4] > 215 and rows[2][35] > 215
    assert rows[17][4] < 40 and rows[17][35] < 40


def test_cover_crops_the_center():
    # 30 x 10: black | mid gray | white thirds
    src = _gray(30, 10, ([0] * 10 + [128] * 10 + [255] * 10) * 10)
    raster = gray_raster(_png(src), 10, 10, "cover", 0)
    assert raster.gray == bytes([128]) * 100
    # a tall picture in a wide box keeps its middle rows
    tall = _gray(4, 12, [0] * 16 + [99] * 16 + [255] * 16)
    assert gray_raster(_png(tall), 4, 4, "cover", 0).gray == bytes([99]) * 16


def test_contain_letterboxes_white():
    wide = Image.new("L", (20, 10), 0)
    rows = _rows(gray_raster(_png(wide), 10, 10, "contain", 0))
    # 10 x 5 picture, centered: two white rows above, three below
    assert rows == [[255] * 10] * 2 + [[0] * 10] * 5 + [[255] * 10] * 3
    tall = Image.new("L", (10, 20), 0)
    rows = _rows(gray_raster(_png(tall), 10, 10, "contain", 0))
    assert all(r == [255] * 2 + [0] * 5 + [255] * 3 for r in rows)
    # an extreme ratio still keeps at least one dot of picture
    sliver = Image.new("L", (1000, 1), 0)
    rows = _rows(gray_raster(_png(sliver), 10, 10, "contain", 0))
    assert sum(r == [0] * 10 for r in rows) == 1


def test_rotation_transposes_exactly():
    """90 turns clockwise like every other element (ZPL `R`); the box is
    fitted unrotated, then transposed, so 90 and 270 swap width and height."""
    a, b, c, d, e, f, g, h = 10, 20, 30, 40, 50, 60, 70, 80
    src = _png(_gray(4, 2, [a, b, c, d, e, f, g, h]))
    assert _rows(gray_raster(src, 4, 2, "cover", 0)) == [[a, b, c, d], [e, f, g, h]]
    r90 = gray_raster(src, 4, 2, "cover", 90)
    assert (r90.width, r90.height) == (2, 4)
    assert _rows(r90) == [[e, a], [f, b], [g, c], [h, d]]
    assert _rows(gray_raster(src, 4, 2, "cover", 180)) == [[h, g, f, e], [d, c, b, a]]
    r270 = gray_raster(src, 4, 2, "cover", 270)
    assert (r270.width, r270.height) == (2, 4)
    assert _rows(r270) == [[d, h], [c, g], [b, f], [a, e]]


def test_sixteen_bit_gray_scales_down():
    im = Image.new("I;16", (3, 1))
    for x, v in enumerate((65535, 32768, 0)):
        im.putpixel((x, 0), v)
    assert list(gray_raster(_png(im), 3, 1, "cover", 0).gray) == [255, 127, 0]


def test_a_huge_picture_is_refused():
    """A decompression bomb is refused from its header, before decoding."""
    big = Image.new("1", (10_000, 5_000))         # 50 MP
    with pytest.raises(ImageTooLarge):
        gray_raster(_png(big), 10, 10, "cover", 0)
    with pytest.raises(ImageTooLarge):
        image_prep.probe(_png(big))
    assert image_prep.MAX_PIXELS == 40_000_000


def _png_header(width: int, height: int) -> bytes:
    """A PNG that only claims its size: a 1-bit gray header and an empty
    image stream, so a test can ask for any size without building it."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 1, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"")) + chunk(b"IEND", b""))


def test_the_cap_is_checked_before_decoding(monkeypatch):
    """The pixel count comes from the header: a bomb is refused without a
    single row decoded."""
    def no_decoding(self):
        raise RuntimeError("decoded")

    bigs = (_png_header(10_000, 5_000), _png(Image.new("1", (10_000, 5_000))))
    small = _png(Image.new("L", (4, 4)))
    monkeypatch.setattr(ImageFile.ImageFile, "load", no_decoding)
    monkeypatch.setattr(Image.Image, "load", no_decoding)
    for big in bigs:
        with pytest.raises(ImageTooLarge):
            gray_raster(big, 10, 10, "cover", 0)
        with pytest.raises(ImageTooLarge):
            image_prep.probe(big)
    # the patch does stop decoding: a small picture gets as far as decoding
    with pytest.raises(UnreadableImage, match="decoded"):
        gray_raster(small, 2, 2, "cover", 0)


def test_pillows_own_bomb_check_is_too_large_as_well():
    """Past Pillow's own limits its warning (or, past twice that, its error)
    comes first: still ImageTooLarge, whatever the warnings filter does."""
    over_warning = _png_header(10_000, 9_000)          # 90 MP: Pillow warns
    over_error = _png_header(20_000, 10_000)           # 200 MP: Pillow refuses
    for data in (over_warning, over_error):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with pytest.raises(ImageTooLarge):
                gray_raster(data, 10, 10, "cover", 0)
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            with pytest.raises(ImageTooLarge):
                image_prep.probe(data)


def test_the_cap_is_inclusive(monkeypatch):
    monkeypatch.setattr(image_prep, "MAX_PIXELS", 100)
    assert gray_raster(_png(Image.new("L", (10, 10))), 2, 2, "cover", 0).width == 2
    with pytest.raises(ImageTooLarge):
        gray_raster(_png(Image.new("L", (11, 10))), 2, 2, "cover", 0)


def test_unreadable_and_foreign_pictures():
    for data in (b"", b"not a picture", _png(Image.new("L", (8, 8)))[:40]):
        with pytest.raises(UnreadableImage):
            gray_raster(data, 4, 4, "cover", 0)
    # Pillow reads BMP, but a badge takes PNG, JPEG, WebP or GIF only
    buf = io.BytesIO()
    Image.new("L", (8, 8)).save(buf, "BMP")
    with pytest.raises(UnreadableImage):
        gray_raster(buf.getvalue(), 4, 4, "cover", 0)
    with pytest.raises(UnreadableImage):
        image_prep.probe(buf.getvalue())


def _mpo(*colors) -> bytes:
    """A multi-picture JPEG, as phones and cameras save them."""
    first, *rest = (Image.new("RGB", (30, 20), c) for c in colors)
    buf = io.BytesIO()
    first.save(buf, "MPO", save_all=True, append_images=rest)
    return buf.getvalue()


def test_a_multi_picture_jpeg_is_a_jpeg():
    data = _mpo((0, 0, 0), (255, 255, 255))
    assert Image.open(io.BytesIO(data)).format == "MPO"       # what Pillow calls it
    info = image_prep.probe(data)
    assert (info.width, info.height, info.mime, info.ext) == (30, 20, "image/jpeg", ".jpg")
    # its first picture prints
    assert max(gray_raster(data, 6, 4, "cover", 0).gray) < 20


def test_a_format_without_a_type_is_unreadable(monkeypatch):
    """Never a KeyError: a decoder format the module has no type for is an
    unreadable picture."""
    monkeypatch.setattr(image_prep, "TYPES", {k: v for k, v in image_prep.TYPES.items()
                                              if k != "PNG"})
    with pytest.raises(UnreadableImage):
        image_prep.probe(_png(Image.new("L", (4, 4))))
    with pytest.raises(UnreadableImage):
        gray_raster(_png(Image.new("L", (4, 4))), 2, 2, "cover", 0)


def test_sixteen_bit_gray_transparency_prints_white():
    im = Image.new("I;16", (3, 1))
    for x, v in enumerate((65535, 1000, 0)):
        im.putpixel((x, 0), v)
    buf = io.BytesIO()
    im.save(buf, "PNG", transparency=1000)
    assert list(gray_raster(buf.getvalue(), 3, 1, "cover", 0).gray) == [255, 255, 0]


def _spy(monkeypatch, cls, name):
    calls = []
    real = getattr(cls, name)

    def spy(self, *args, **kwargs):
        calls.append(args)
        return real(self, *args, **kwargs)

    monkeypatch.setattr(cls, name, spy)
    return calls


def test_a_large_picture_is_reduced_before_it_is_composited(monkeypatch):
    """A source past twice the box is box-reduced (whole factors, alpha
    premultiplied) before the white composite, so a 40 MP transparent PNG
    never makes full-size copies for it; the result still prints right."""
    reduce_calls = _spy(monkeypatch, Image.Image, "reduce")
    logo = Image.new("RGBA", (1000, 500), (0, 0, 0, 0))
    logo.paste((0, 0, 0, 255), (0, 0, 500, 500))               # left half black, right clear
    rows = _rows(gray_raster(_png(logo), 50, 25, "contain", 0))
    assert reduce_calls[0] == (10,)                            # 1000 // 100, 500 // 50
    assert all(r[:24] == [0] * 24 and r[26:] == [255] * 24 for r in rows)


def test_a_large_jpeg_is_decoded_small(monkeypatch):
    """A JPEG past twice the box decodes at 1/2, 1/4 or 1/8 (in its own
    mode, so the gray is Pillow's L as always), in its stored orientation."""
    drafts = _spy(monkeypatch, JpegImagePlugin.JpegImageFile, "draft")
    upright = Image.new("L", (800, 400), 255)
    upright.paste(0, (0, 0, 400, 400))                        # left half black
    stored = upright.transpose(Image.Transpose.ROTATE_90)    # 400 x 800, needs EXIF 6
    exif = Image.Exif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    stored.convert("RGB").save(buf, "JPEG", exif=exif, quality=95)
    rows = _rows(gray_raster(buf.getvalue(), 40, 20, "cover", 0))
    assert drafts == [("RGB", (40, 80))]                      # the box, twice, as stored
    assert rows[10][5] < 40 and rows[10][34] > 215            # upright: black left
    # the same picture reduced or decoded whole differs by a level or two at most
    reduced = gray_raster(buf.getvalue(), 40, 20, "cover", 0).gray
    monkeypatch.setattr(JpegImagePlugin.JpegImageFile, "draft", lambda self, mode, size: None)
    monkeypatch.setattr(Image.Image, "reduce", lambda self, factor, box=None: self.copy())
    whole = gray_raster(buf.getvalue(), 40, 20, "cover", 0).gray
    assert max(abs(a - b) for a, b in zip(reduced, whole, strict=True)) <= 8


def test_a_picture_up_to_twice_the_box_is_never_reduced(monkeypatch):
    """Under 4x the box (so at most 2x after a whole-factor reduction) a
    picture is prepped exactly as before: the canvas and the printer keep
    the same bits for every portal avatar and small logo."""
    reduce_calls = _spy(monkeypatch, Image.Image, "reduce")
    drafts = _spy(monkeypatch, JpegImagePlugin.JpegImageFile, "draft")
    buf = io.BytesIO()
    Image.new("RGB", (159, 79), (90, 90, 90)).save(buf, "JPEG")
    gray_raster(buf.getvalue(), 40, 20, "cover", 0)
    gray_raster(_png(Image.new("RGBA", (159, 79))), 40, 20, "contain", 90)
    assert reduce_calls == [] and drafts == []


def test_bad_box_or_settings():
    src = _png(Image.new("L", (4, 4)))
    for w, h, fit, rotation in ((0, 4, "cover", 0), (4, -1, "cover", 0),
                                (4, 4, "stretch", 0), (4, 4, "cover", 45)):
        with pytest.raises(ValueError):
            gray_raster(src, w, h, fit, rotation)


def test_probe_reads_format_and_upright_size():
    for fmt, mime, ext in (("PNG", "image/png", ".png"), ("JPEG", "image/jpeg", ".jpg"),
                           ("WEBP", "image/webp", ".webp"), ("GIF", "image/gif", ".gif")):
        buf = io.BytesIO()
        Image.new("RGB", (30, 20)).save(buf, fmt)
        info = image_prep.probe(buf.getvalue())
        assert (info.width, info.height, info.mime, info.ext) == (30, 20, mime, ext), fmt
    exif = Image.Exif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    Image.new("RGB", (30, 20)).save(buf, "JPEG", exif=exif)
    assert (image_prep.probe(buf.getvalue()).width,
            image_prep.probe(buf.getvalue()).height) == (20, 30)


def test_the_api_imports_pillow_lazily():
    """The labels routes and the people lookup load without Pillow: only a
    request that preps a picture imports labels/image_prep.py."""
    code = textwrap.dedent(f"""
        import importlib, sys
        sys.path.insert(0, {str(SRC)!r})
        sys.modules["PIL"] = None
        for name in ("serversherpa.api.routes.labels", "serversherpa.labels.people_badge"):
            importlib.import_module(name)
        assert "serversherpa.labels.image_prep" not in sys.modules
        print("ok")
    """)
    r = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True,
                       timeout=120, check=False)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "ok"
