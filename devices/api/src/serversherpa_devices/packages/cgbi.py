"""Apple's CgBI PNG variant (Xcode's "crushed" app icons) to a normal PNG.

CgBI files carry a CgBI chunk before IHDR, store pixels as premultiplied
BGRA, and deflate IDAT without the zlib header. Only 8-bit RGBA,
non-interlaced files (what Xcode writes for icons) are converted.

Also `icon_png`, the last check every APK and IPA icon goes through."""

import io
import struct
import zlib

from PIL import Image

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_MAX_PIXELS = 4096 * 4096
ICON_FORMATS = ("PNG", "WEBP", "JPEG")


def _chunks(png: bytes) -> list[tuple[bytes, bytes]] | None:
    chunks, i = [], len(PNG_SIGNATURE)
    while i + 8 <= len(png):
        (length,) = struct.unpack(">I", png[i:i + 4])
        kind = png[i + 4:i + 8]
        body = png[i + 8:i + 8 + length]
        if len(body) != length or i + 12 + length > len(png):
            return None
        chunks.append((kind, body))
        i += 12 + length
        if kind == b"IEND":
            return chunks
    return None


def _chunk(kind: bytes, body: bytes) -> bytes:
    crc = zlib.crc32(kind + body) & 0xFFFFFFFF
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)


def decode(png: bytes) -> bytes | None:
    """A normal PNG from a CgBI one. Anything that isn't CgBI comes back
    unchanged; a CgBI file that is unsupported or damaged gives None."""
    if not png.startswith(PNG_SIGNATURE + b"\x00\x00\x00\x04CgBI"):
        return png
    chunks = _chunks(png)
    if not chunks or chunks[0][0] != b"CgBI":
        return None
    ihdr = next((body for kind, body in chunks if kind == b"IHDR"), None)
    if ihdr is None or len(ihdr) != 13:
        return None
    width, height, depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", ihdr)
    if (depth, color_type, interlace) != (8, 6, 0) or not 0 < width * height <= _MAX_PIXELS:
        return None

    stride = width * 4 + 1   # filter byte + 4 bytes per pixel
    expected = stride * height
    try:
        inflater = zlib.decompressobj(-15)   # raw deflate
        raw = inflater.decompress(b"".join(b for k, b in chunks if k == b"IDAT"), expected)
    except zlib.error:
        return None
    if len(raw) != expected:
        return None

    # BGRA to RGBA. PNG filters work per byte against the same channel of the
    # neighboring pixel (4 bytes per pixel), so swapping before unfiltering
    # is safe.
    rows = bytearray(raw)
    for y in range(height):
        start, end = y * stride + 1, (y + 1) * stride
        rows[start:end:4], rows[start + 2:end:4] = rows[start + 2:end:4], rows[start:end:4]
    swapped = (PNG_SIGNATURE + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(rows))
               + _chunk(b"IEND", b""))
    try:
        premultiplied = Image.open(io.BytesIO(swapped), formats=("PNG",)).tobytes()
        # Pillow's "RGBa" is premultiplied RGBA; converting divides alpha back out.
        image = Image.frombytes("RGBa", (width, height), premultiplied).convert("RGBA")
        out = io.BytesIO()
        image.save(out, "PNG")
    except Exception:  # noqa: BLE001 (Pillow raises many types on hostile scanlines)
        return None
    return out.getvalue()


def icon_png(data: bytes | None) -> bytes | None:
    """`data` as a PNG icon: a PNG within 4096x4096 comes back as is, a WebP
    or JPEG within it is converted, and anything else gives None. Pillow reads
    only the header before the size check."""
    if not data:
        return None
    try:
        image = Image.open(io.BytesIO(data), formats=ICON_FORMATS)
        width, height = image.size
        if width * height > _MAX_PIXELS:
            return None
        if image.format == "PNG" and data.startswith(PNG_SIGNATURE):
            return data
        out = io.BytesIO()
        image.save(out, "PNG")
    except Exception:  # noqa: BLE001 (an optional field: any Pillow failure means "no icon")
        return None
    return out.getvalue()
