"""Export a published wiki page as a bundled troubleshooting doc (read-only on the database).

Run from api/ with the root .env loaded:
  cd api && set -a && source ../.env && set +a && PYTHONPATH=src .venv/bin/python \
    ../scripts/troubleshooting/export_wiki_page.py --node <uuid> --out ../kiosk/src/troubleshooting --doc zebra-ds22.json

Writes the doc JSON (wikiImage assetIds replaced by bundled filenames) and each image into --out.
Exits non-zero when the doc holds a node type or mark the kiosk renderers do not support.
"""
import argparse
import asyncio
import copy
import json
import sys
import uuid
from pathlib import Path

from sqlalchemy import select

from serversherpa.db.engine import dispose_engine, get_sessionmaker
from serversherpa.db.models import WikiPageAsset, WikiPageVersion
from serversherpa.services import storage

SUPPORTED = {
    "doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "table",
    "tableRow", "tableHeader", "tableCell", "callout", "wikiImage", "text",
}


def walk(node):
    yield node
    for child in node.get("content") or []:
        yield from walk(child)


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
            version = (await db.execute(
                select(WikiPageVersion)
                .where(WikiPageVersion.node_id == node_id, WikiPageVersion.kind == "published")
                .order_by(WikiPageVersion.version_no.desc()).limit(1))).scalar_one_or_none()
            if version is None or not version.content_json:
                print("no published version with content", file=sys.stderr)
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
        for aid, a in assets.items():
            if files.get(a.filename, aid) != aid:
                print(f"two assets share filename {a.filename}", file=sys.stderr)
                return 4
            files[a.filename] = aid
            (out / a.filename).write_bytes(await storage.get_object(a.storage_key))
        for n in images:
            n["attrs"]["assetId"] = assets[uuid.UUID(n["attrs"]["assetId"])].filename

        (out / args.doc).write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
        print(f"version {version.version_no}: wrote {args.doc} and {len(files)} images: {sorted(files)}")
        return 0
    finally:
        await dispose_engine()


sys.exit(asyncio.run(main()))
