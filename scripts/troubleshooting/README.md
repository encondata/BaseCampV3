`kiosk/src/troubleshooting/` holds the troubleshooting guides (`topics.json`, doc JSON, PNGs) shared by the web, Android and iOS kiosks; never edit the Android/iOS copies by hand.
Re-export a wiki page: `cd api && set -a && source ../.env && set +a && PYTHONPATH=src .venv/bin/python ../scripts/troubleshooting/export_wiki_page.py --node <uuid> --out ../kiosk/src/troubleshooting --doc <name>.json` (read-only on the database).
Then run `scripts/troubleshooting/sync.sh` to refresh the Android and iOS copies and rebuild the apps; `content.test.ts` fails if a copy drifts.
