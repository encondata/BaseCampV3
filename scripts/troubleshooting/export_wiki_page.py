"""Export a published wiki page as a bundled troubleshooting doc (read-only on the database).

Run from api/ with the root .env loaded:
  cd api && set -a && source ../.env && set +a && PYTHONPATH=src .venv/bin/python \
    ../scripts/troubleshooting/export_wiki_page.py --node <uuid> --out ../kiosk/src/troubleshooting --doc zebra-ds22.json

Reads the page's current published version (WikiPage.published_version_id, the row readers see,
which may be a published, restored or imported version). Writes the doc JSON (wikiImage assetIds
replaced by bundled filenames) and each image into --out.
Exits non-zero when the page has no published version, when the doc holds a node type or mark the
kiosk renderers do not support, or when an image's filename is not a plain lowercase .png name
(sync.sh mirrors only *.png, and a name must never write outside --out).
"""
import argparse
import asyncio
import copy
import json
import re
import sys
import uuid
from pathlib import Path

from sqlalchemy import select

from serversherpa.db.engine import dispose_engine, get_sessionmaker
from serversherpa.db.models import WikiPage, WikiPageAsset, WikiPageVersion
from serversherpa.services import storage

SUPPORTED = {
    "doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "table",
    "tableRow", "tableHeader", "tableCell", "callout", "wikiImage", "text",
}

# The bundled image names: plain, lowercase, .png only.
ASSET_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*\.png$")


def walk(node):
    yield node
    for child in node.get("content") or []:
        yield from walk(child)


def asset_path(out: Path, filename: str) -> Path | None:
    """Where an image is written, or None when its name is not a plain .png
    name or would resolve outside --out."""
    if not ASSET_NAME.fullmatch(filename):
        return None
    target = (out / filename).resolve()
    return target if target.parent == out.resolve() else None


def check_supported(doc) -> list[str]:
    problems = []
    for n in walk(doc):
        t = n.get("type")
        if t not in SUPPORTED:
            problems.append(f"unsupported node type: {t}")
        for m in n.get("marks") or []:
            if m.get("type") != "bold":
                problems.append(f"unsupported mark: {m.get('type')}")
        if t == "heading" and (n.get("attrs") or {}).get("level") not in (2, 3):
            problems.append(f"unsupported heading level: {(n.get('attrs') or {}).get('level')}")
    return problems


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--doc", required=True)
    args = ap.parse_args()
    node_id = uuid.UUID(args.node)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    try:
        async with get_sessionmaker()() as db:
            page = await db.get(WikiPage, node_id)
            if page is None:
                print(f"no wiki page for node {node_id}", file=sys.stderr)
                return 1
            if page.published_version_id is None:
                print(f"wiki page {node_id} has no published version (published_version_id is null)",
                      file=sys.stderr)
                return 1
            version = await db.get(WikiPageVersion, page.published_version_id)
            if version is None or not version.content_json:
                print(f"published version {page.published_version_id} has no content", file=sys.stderr)
                return 1
            doc = copy.deepcopy(version.content_json)
            problems = check_supported(doc)
            if problems:
                print("\n".join(sorted(set(problems))), file=sys.stderr)
                return 2

            images = [n for n in walk(doc) if n.get("type") == "wikiImage"]
            ids = {uuid.UUID(n["attrs"]["assetId"]) for n in images}
            assets = {a.id: a for a in (await db.execute(
                select(WikiPageAsset).where(WikiPageAsset.node_id == node_id,
                                            WikiPageAsset.id.in_(ids)))).scalars()}
            missing = ids - assets.keys()
            if missing:
                print(f"assets not found: {sorted(map(str, missing))}", file=sys.stderr)
                return 3

        files = {}
        targets = {}
        for aid, a in assets.items():
            if files.get(a.filename, aid) != aid:
                print(f"two assets share filename {a.filename}", file=sys.stderr)
                return 4
            target = asset_path(out, a.filename)
            if target is None:
                print(f"asset {aid} has filename {a.filename!r}: it must match {ASSET_NAME.pattern} "
                      f"and stay inside {out}; rename the image in the wiki and export again",
                      file=sys.stderr)
                return 5
            files[a.filename] = aid
            targets[aid] = target
        # every name is checked before anything is written
        for aid, a in assets.items():
            targets[aid].write_bytes(await storage.get_object(a.storage_key))
        for n in images:
            n["attrs"]["assetId"] = assets[uuid.UUID(n["attrs"]["assetId"])].filename

        (out / args.doc).write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
        print(f"version {version.version_no} ({version.kind}): wrote {args.doc} and {len(files)} images: {sorted(files)}")
        return 0
    finally:
        await dispose_engine()


sys.exit(asyncio.run(main()))
