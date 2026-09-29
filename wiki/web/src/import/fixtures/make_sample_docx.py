"""Writes sample.docx (run: python3 make_sample_docx.py sample.docx): a heading 1 (the
title), a paragraph with bold text, a heading 2, a two-item bullet list,
an embedded 1x1 PNG, and a 2x2 table. Hand-made OOXML, no python-docx."""
import struct
import sys
import zipfile
import zlib


def png_1x1() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    raw = b"\x00\xff\x00\x00"
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
NS = (W + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
      ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
      ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
      ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"')


def para(text: str, style: str | None = None, num: bool = False, bold: str = "") -> str:
    ppr = ""
    if style or num:
        ppr = "<w:pPr>"
        if style:
            ppr += f'<w:pStyle w:val="{style}"/>'
        if num:
            ppr += '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
        ppr += "</w:pPr>"
    runs = f"<w:r><w:t xml:space=\"preserve\">{text}</w:t></w:r>"
    if bold:
        runs += f"<w:r><w:rPr><w:b/></w:rPr><w:t>{bold}</w:t></w:r>"
    return f"<w:p>{ppr}{runs}</w:p>"


IMAGE = """<w:p><w:r><w:drawing><wp:inline><wp:extent cx="95250" cy="95250"/>
<wp:docPr id="1" name="Picture 1" descr="Red dot"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="dot.png" descr="Red dot"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="95250" cy="95250"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>
</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"""


def cell(text: str) -> str:
    return f"<w:tc>{para(text)}</w:tc>"


TABLE = ("<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>"
         f"<w:tr>{cell('Rack')}{cell('Units')}</w:tr>"
         f"<w:tr>{cell('A1')}{cell('42')}</w:tr></w:tbl>")

BODY = "".join([
    para("Rack plan", "Heading1"),
    para("Power down the rack before moving it. ", bold="Label every cable."),
    para("Checklist", "Heading2"),
    para("Unplug the PDUs", num=True),
    para("Remove the rails", num=True),
    IMAGE,
    TABLE,
])

DOCUMENT = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {NS}><w:body>{BODY}</w:body></w:document>'

STYLES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {W}>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>"""

NUMBERING = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering {W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>"""

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/dot.png"/>
</Relationships>"""

out = sys.argv[1]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    # fixed timestamps so the fixture is byte-stable when regenerated
    def put(name: str, data):
        info = zipfile.ZipInfo(name, date_time=(2026, 9, 25, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, data)
    put("[Content_Types].xml", CONTENT_TYPES)
    put("_rels/.rels", ROOT_RELS)
    put("word/document.xml", DOCUMENT)
    put("word/styles.xml", STYLES)
    put("word/numbering.xml", NUMBERING)
    put("word/_rels/document.xml.rels", DOC_RELS)
    put("word/media/dot.png", png_1x1())
