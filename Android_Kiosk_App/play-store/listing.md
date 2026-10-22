# Google Play store listing

What is live in Play Console (app "ServerSherpa - Kiosk", package `com.serversherpa.kiosk`, EnconDATA developer account). Keep this file in step with the console.

- **App name:** ServerSherpa - Kiosk
- **Short description:** Scan, RFID-tag, label and clock in on ServerSherpa data center moves.
- **Feature graphic:** `feature-graphic.png` (1024x500), made by `make_feature_graphic.py`.
- **Phone screenshots:** `screenshots/` (1080x1920, 9:16), in upload order. They show only the fictional "Summit Ridge Health / DC1 to DC2 Migration" demo data in the dev database (rows tagged `source_ref = 'play-demo:summit-ridge'`), never real client data.

## Full description

ServerSherpa Kiosk is the field app for crews running data center moves, migrations and decommissions with ServerSherpa. It turns an Android phone or a Zebra handheld into a scanning station that keeps every asset accounted for, from the rack it leaves to the rack it lands in.

Scan assets your way
• Camera scanning of barcodes and QR codes, one at a time or many in a single pass
• Zebra handhelds: the hardware trigger scans through DataWedge, set up automatically on first launch
• Bluetooth and USB barcode scanners work as soon as they are paired
• Each scan is matched against the move roster so the crew sees right away whether an asset belongs to the move

RFID with the Zebra RFD40
• Pull the trigger to sweep a cart or a rack and see unique and total tag counts as they read
• Enroll RFID tags to assets in a few taps
• Trigger mode, sweep behavior, beeper and radio settings are adjustable in the app

Print labels on site
• Asset labels are built on the device and sent to networked Zebra label printers
• Printer setup finds printers on the local network or connects by IP address

Time clock
• Crew members clock in and out at the kiosk, and their hours go straight to ServerSherpa timesheets

Built for the floor
• Sign in with your ServerSherpa account, or with a move password or its QR code for a shared kiosk locked to one move
• The move roster is synced to the device, so scanning keeps working when the connection drops
• Scans wait in an outbox and send automatically when the device is back online

ServerSherpa Kiosk requires a ServerSherpa account from your organization. It is a work tool for ServerSherpa customers and their moving crews, not a consumer app.
