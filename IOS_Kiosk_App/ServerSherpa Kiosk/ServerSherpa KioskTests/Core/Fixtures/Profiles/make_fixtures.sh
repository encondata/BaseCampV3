#!/bin/sh
# Regenerates the four fixture provisioning profiles. Every value is made up (fake UDIDs, team id,
# names); each plist is signed into real CMS/DER with a throwaway self-signed cert that is deleted.
set -e
cd "$(dirname "$0")"
T=$(mktemp -d)
openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=Fixture" -keyout "$T/k.pem" -out "$T/c.pem" -days 1 2>/dev/null

plist() { # name, extra top-level keys, get-task-allow
cat > "$T/$1.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Name</key><string>Fixture $1</string>
	<key>UUID</key><string>$4</string>
	<key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
$2
	<key>Entitlements</key>
	<dict>
		<key>application-identifier</key><string>ABCDE12345.com.example.fixture</string>
		<key>get-task-allow</key><$3/>
	</dict>
</dict>
</plist>
PL
}

plist adhoc '	<key>ProvisionedDevices</key><array><string>00008110-0000000000000001</string><string>00008110-0000000000000002</string></array>' false 00000000-0000-0000-0000-000000000001
plist development '	<key>ProvisionedDevices</key><array><string>00008110-0000000000000001</string></array>' true 00000000-0000-0000-0000-000000000002
plist enterprise '	<key>ProvisionsAllDevices</key><true/>' false 00000000-0000-0000-0000-000000000003
plist appstore '' false 00000000-0000-0000-0000-000000000004

for n in adhoc development enterprise appstore; do
  openssl cms -sign -binary -nodetach -outform DER -in "$T/$n.plist" -signer "$T/c.pem" -inkey "$T/k.pem" -out "$n.mobileprovision"
done
rm -rf "$T"
